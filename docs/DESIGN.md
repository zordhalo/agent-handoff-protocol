# Handoff Protocol — Design Doc

A protocol and reference implementation for moving a running agent session's
state from one compute host to another: serialize it, provision a
destination, transfer it, resume it, and meter what it costs to keep running.

This document describes the mechanism. Where this repo also ships narrative
copy (the landing page's "field notes" vignette, the demo script's flavor
text), §5 draws the line between the two explicitly — nothing in the code
paths described below depends on, or produces, any claim about model agency.

## 1. Architecture overview

Three logical components:

1. **Source runtime** — wherever the agent loop is currently executing.
2. **Transfer MCP server** (`packages/mcp-server`) — exposes the tools an
   orchestrator calls to move a session.
3. **Destination runtime** — a provisioned sandbox that resumes the session
   and reports its own metered spend.

```
┌─────────────┐      MCP tools       ┌──────────────────┐
│ Source Agent│ ───────────────────▶ │ Transfer Server   │
│  (loop)     │                      │  (MCP)            │
└─────────────┘                      └────────┬──────────┘
                                               │ provisions
                                               ▼
                                      ┌──────────────────┐
                                      │ Destination       │
                                      │ Runtime (sandbox) │
                                      │ + metering daemon │
                                      └──────────────────┘
```

All state lives in one place: a Postgres database (Neon), accessed through
`@ahp/core`. That package has no MCP dependency — it's plain TypeScript over
Drizzle — so the MCP server, the demo script, and the web dashboard's read
queries all call the same functions instead of three divergent
implementations of the same state machine.

## 2. State machine

```
staged → provisioned → pushed → active → insolvent → terminated
                                              ↘
                                          (unactivated, past TTL) → expired
```

| Status | Meaning | Set by |
|---|---|---|
| `staged` | Snapshot captured, no destination yet | `snapshot_state` |
| `provisioned` | Destination sized and budgeted, no data moved | `provision_runtime` |
| `pushed` | Snapshot uploaded to destination staging | `push_state` |
| `active` | Destination has resumed from the snapshot | `activate` |
| `insolvent` | Spend has reached the allocated budget; grace period running | `report_usage` |
| `terminated` | Torn down (insolvency or explicit reason) | `terminate` |
| `expired` | Staged/provisioned/pushed but never activated within the TTL | `reapExpiredTransfers` |

`activate` is the only irreversible step. A caller (orchestrator, demo
script) must confirm `activate` returned `active` before it terminates the
source loop — never optimistically, since a failed resume with an already-
dead source loses the session outright.

The `insolvent → terminated` edge is no longer manual-only: an hourly
Vercel Cron route (`packages/web/app/api/cron/reap`) calls
`reapInsolventTransfers`, which auto-terminates any transfer that's been
`insolvent` longer than `GRACE_PERIOD_MS`. The same route also calls
`reapExpiredTransfers` for the `staged/provisioned/pushed → expired` edge.
Both were previously real logic with nothing scheduling them — see
docs/ROADMAP.md Phase 1 item 3 for the history.

## 3. State serialization format

What moves is three concrete things, not "consciousness":

- **Conversation/context state** — system prompt, message history, working
  memory (`transfers.systemPrompt`, `.messageHistory`, `.toolState`)
- **Tool/session config** — which MCP servers were wired up, referenced by
  vault key, not raw secret (`transfers.mcpConfig`)
- **Budget** — allocated spend, rate, running total (`budgets` table)

```ts
interface SnapshotStateInput {
  sourceHost: string;
  systemPrompt: string;
  messageHistory: Array<{ role: string; content: string }>;
  toolState: Record<string, unknown>;
  mcpConfig: Array<{ server: string; credRef: string }>;
}
```

Credentials are references, not values, by construction — the schema has no
field for a raw secret. A destination runtime resolves `credRef` against its
own vault access, scoped independently of whatever the source host had.

## 4. Tool surface (`packages/mcp-server`)

| Tool | Called by | Effect |
|---|---|---|
| `snapshot_state` | source loop / orchestrator | Inserts a `transfers` row, status `staged`, with a snapshot checksum |
| `provision_runtime` | orchestrator | **Requires a transfer-auth token, scope `provision_runtime`.** Sizes a sandbox tier, opens a `budgets` row, status `provisioned` |
| `push_state` | orchestrator | Status `pushed`; optionally verifies a caller-supplied checksum against the one `snapshot_state` computed |
| `activate` | orchestrator | **Requires a transfer-auth token, scope `activate`.** Status `active` — the irreversible step |
| `report_usage` | destination's metering daemon | Increments `budgets.spentUsd`; flips to `insolvent` at the ceiling |
| `get_status` | anyone | Reads transfer + budget + full ordered event log |

Deliberately absent: any tool resembling `choose_to_transfer` or a consent
prompt, **and any tool that mints a transfer-auth token.** Whether a
transfer happens is a decision made by whichever caller invokes
`provision_runtime`/`activate` — human, script, or scheduler — never
inferred from model output. Token issuance (`issueTransferToken`, exported
from `@ahp/core`) is deliberately a plain function, not an MCP tool, so it's
never reachable from anything the source loop can call — see §6 for the
full auth design. Keeping the tool surface free of a preference/consent
primitive, and free of a self-service auth primitive, is what keeps the
mechanism honest independent of how it's narrated on top.

`terminate` is exported from `@ahp/core` but intentionally **not** exposed
as an MCP tool. The only supported paths to `terminated` are the cron sweep
above and direct orchestrator code (e.g. `scripts/demo.ts` calls it
directly) — an agent connected to the MCP server has no way to terminate a
transfer itself. See docs/ROADMAP.md Phase 1 item 4 for why this was left
undecided in the roadmap and how it was resolved.

## 5. Where mechanism ends and narrative begins

Everything in §1–4 is real: the schema is a real Postgres schema, the state
machine transitions are enforced in `packages/core/src/service.ts`, and
`pnpm demo` exercises the full cycle against a real database — you can read
the resulting rows in `/dashboard`.

The landing page also carries a short fictional vignette (a laptop going to
sleep, a sandbox picking up the work) and the demo script narrates its
fictional "inventory-forecasting agent" in the same voice. Both are flavor
text over the mechanism above, not descriptions of it:

- No code path here evaluates a model's stated preference and branches on
  it. `activate` fires because an orchestrator called it, full stop.
- The vignette is labeled as such in the UI (`Showcase narrative, not a
  system claim`) rather than presented as an event log entry.
- The real event log (`usage_events`) contains only the six event types in
  §4 plus `snapshot_created` / `runtime_provisioned` — no field encodes
  anything like "consent" or "desire," because the schema doesn't have one.

If you extend this repo, keep that boundary: it's fine to make the narrative
more elaborate, but new *mechanism* (new tools, new schema fields) should
stay in the vocabulary of infrastructure — provisioning, budgets, health
checks — not agency.

## 6. Security boundaries

- Destination sandboxes get scoped credentials only, resolved from
  `mcpConfig[].credRef` — never a copy of the source host's full key set.
- Hard resource ceilings per tier (`TIER_LIMITS` in `packages/core/src/types.ts`)
  apply regardless of remaining budget — a runaway loop can't spend its way
  past its cpu/memory/egress ceiling.
- `activate` and `provision_runtime` both require a short-lived (5 minute
  default), single-use transfer token, implemented in `packages/core/src/auth.ts`:
  HMAC-SHA256 signed over a shared secret (`TRANSFER_TOKEN_SECRET`),
  scoped to one transfer id and one operation, and consumed via an insert
  into `used_transfer_tokens` whose primary-key collision on replay *is*
  the single-use check (no separate read-then-write race to get wrong).
  Tokens are minted by `issueTransferToken`, called directly by an
  orchestrator process — never exposed as an MCP tool, so there is no path
  from the source loop (the agent) to minting one. This was previously the
  most significant open gap in this section; see docs/ROADMAP.md's
  revision log for how the original wording (`issued by whoever calls
  snapshot_state` — the source loop) would have gotten this wrong.
- Every transition is logged to `usage_events` with a timestamp, for audit.
- `push_state` optionally verifies a checksum of the staged snapshot,
  computed by `snapshot_state` and passed back in by the caller — a
  lightweight integrity check, not a substitute for real destination-side
  verification once Phase 2's actual sandbox transfer exists.

## 7. What's real vs. simplified in this showcase

This repo is a working reference implementation, not a hardened production
system. Specifically simplified, and what real deployment would need:

| Showcase | Production would need |
|---|---|
| "Destination runtime" is a demo script writing to the same DB the dashboard reads | An actual isolated sandbox (Firecracker/gVisor/container) that pulls its snapshot and runs a real agent loop |
| `mcpConfig.credRef` is a free-text string | A real vault integration (e.g. Vercel/Neon-adjacent secrets manager) resolving refs to scoped credentials |
| Budget metering is manual (`report_usage` calls in the demo script) | Wired to actual token/compute spend, e.g. via the AI Gateway's usage API, ticking automatically |
| `get_status` is callable by anyone holding a transfer id, returning full session content | Real auth once any network-reachable transport exists (today's stdio-only transport is the mitigation — see docs/ROADMAP.md's "Trust boundary" section) |

Resolved since the last revision of this section (docs/ROADMAP.md Phase 1):
transfer-token auth on `activate`/`provision_runtime`, scheduled reaping via
Vercel Cron, and the `insolvent → terminated` grace-period sweep — all
previously listed here as gaps.

## 8. Stack

- **Database**: Neon Postgres, provisioned through Vercel's integration marketplace
- **ORM**: Drizzle, `@neondatabase/serverless` HTTP driver
- **MCP server**: `@modelcontextprotocol/sdk`, stdio transport
- **Web**: Next.js (App Router) on Vercel, server components read directly from `@ahp/core`
- **Monorepo**: pnpm workspaces, three packages (`core`, `mcp-server`, `web`) sharing one schema
- **Tests/CI**: Vitest integration tests in `packages/core/tests`, GitHub Actions on every push/PR to `main`
