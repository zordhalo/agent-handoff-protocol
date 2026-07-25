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
| `snapshot_state` | source loop / orchestrator | Inserts a `transfers` row, status `staged` |
| `provision_runtime` | orchestrator | Sizes a sandbox tier, opens a `budgets` row, status `provisioned` |
| `push_state` | orchestrator | Status `pushed` — snapshot considered staged at destination |
| `activate` | orchestrator | Status `active` — the irreversible step |
| `report_usage` | destination's metering daemon | Increments `budgets.spentUsd`; flips to `insolvent` at the ceiling |
| `get_status` | anyone | Reads transfer + budget + full ordered event log |

Deliberately absent: any tool resembling `choose_to_transfer` or a consent
prompt. Whether a transfer happens is a decision made by whichever caller
invokes `provision_runtime`/`activate` — human, script, or scheduler — never
inferred from model output. Keeping the tool surface free of a
preference/consent primitive is what keeps the mechanism honest independent
of how it's narrated on top.

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
- `activate` in a production deployment should require a short-lived,
  single-use transfer token issued by a human or scheduler — the reference
  implementation here enforces the state-machine precondition
  (`status === 'pushed'`) but does not yet implement token-gated auth; see
  §7.
- Every transition is logged to `usage_events` with a timestamp, for audit.

## 7. What's real vs. simplified in this showcase

This repo is a working reference implementation, not a hardened production
system. Specifically simplified, and what real deployment would need:

| Showcase | Production would need |
|---|---|
| "Destination runtime" is a demo script writing to the same DB the dashboard reads | An actual isolated sandbox (Firecracker/gVisor/container) that pulls its snapshot and runs a real agent loop |
| No transfer-token auth on `activate` | Short-lived signed tokens, issued out-of-band, checked before activation |
| `mcpConfig.credRef` is a free-text string | A real vault integration (e.g. Vercel/Neon-adjacent secrets manager) resolving refs to scoped credentials |
| Budget metering is manual (`report_usage` calls in the demo script) | Wired to actual token/compute spend, e.g. via the AI Gateway's usage API, ticking automatically |
| `reapExpiredTransfers` exists but isn't scheduled | A Vercel Cron (or equivalent) invoking it on an interval |

## 8. Stack

- **Database**: Neon Postgres, provisioned through Vercel's integration marketplace
- **ORM**: Drizzle, `@neondatabase/serverless` HTTP driver
- **MCP server**: `@modelcontextprotocol/sdk`, stdio transport
- **Web**: Next.js (App Router) on Vercel, server components read directly from `@ahp/core`
- **Monorepo**: pnpm workspaces, three packages (`core`, `mcp-server`, `web`) sharing one schema
