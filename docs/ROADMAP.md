# Roadmap

What exists today, what's missing, and what to build next — in that order,
so each phase is justified by a concrete gap rather than by "wouldn't it be
cool if." Phase order is priority order: do not start Phase 2 work before
Phase 1 is done and reviewed.

*Revised after two independent review passes on the first draft — both
caught the same functional gap (§ below) that the first draft missed
entirely, and both flagged the auth item as under-scoped relative to its
stated importance. See the bottom of this doc for what changed and why.*

## Current feature audit (as of this doc)

Six MCP tools (stdio transport only — no network-reachable instance exists
yet; see "Trust boundary" below), all implemented and exercised against a
live Neon database:

| Tool | Status | Real limitation |
|---|---|---|
| `snapshot_state` | Working | None significant |
| `provision_runtime` | Working, atomic | Budget/tier are trusted input — no cost ceiling enforced against a real price list |
| `push_state` | Working | No integrity check (checksum) that the pushed snapshot matches what was staged — deferred, see Phase 1 item 5 |
| `activate` | Working | No auth beyond the state-machine precondition — see "Trust boundary" for what this does and doesn't mean today |
| `report_usage` | Working, atomic, race-safe | Spend is self-reported by whoever calls it — nothing independently verifies it |
| `get_status` | Working | Callable by anyone per DESIGN.md §4 "by design," but returns full session content (system prompt, message history) for any UUID a caller has — deferred, see Phase 1 item 5 |

Supporting gaps, not tied to one tool:

- **`insolvent` transfers can never reach `terminated` through the tool surface.** `GRACE_PERIOD_MS` (packages/core/src/service.ts) is defined and written into the `insolvent` event's detail payload, but nothing ever reads it to drive a transition — there is no timer, no scheduled sweep, and no MCP tool exposing `terminate` at all (it's only ever called directly from `scripts/demo.ts`, bypassing the MCP surface entirely). An overspent transfer in any real deployment sits at `insolvent` permanently. This is a functional gap in the lifecycle DESIGN.md §2 documents, not a hardening gap — see Phase 1 item 3.
- `reapExpiredTransfers` exists and is correct but **nothing calls it on a schedule**, and it only sweeps `staged`/`provisioned`/`pushed` rows past their TTL — it has no awareness of `insolvent` transfers (that's the gap above, a separate mechanism).
- **No automated tests.** The state machine's correctness currently rests on manual `pnpm demo` runs and review-agent reading, not a test suite that runs on every change.
- **No CI.** Nothing blocks a broken build from landing on `main`.
- **`mcpConfig[].credRef` is a free-text string** — see docs/DESIGN.md §7, unchanged since that doc was written.
- **The "destination runtime" is not isolated** — it's rows in the same database the source wrote to, not a separate sandboxed process. Also unchanged since DESIGN.md §7.

### Trust boundary, stated plainly

`packages/mcp-server/src/index.ts` uses `StdioServerTransport` exclusively — there is no HTTP/SSE transport and no API route in `packages/web/app/api/**` (none exists yet). Whoever can reach this MCP server today is whoever can spawn the local process, which is already the same trust boundary as the orchestrator itself. So the auth-gating work below (item 4) is **preparatory hardening ahead of eventual network exposure, not closure of an active exploit** — that distinction matters for prioritizing it correctly against item 3, which *is* a live correctness bug today regardless of transport.

## Phase 1 — close the gaps in what already exists

Scoped to things that make the *existing* six tools trustworthy and
functionally complete, not new features. Ordered by actual urgency, not by
how the first draft of this doc happened to list them.

1. **CI**: GitHub Actions workflow running `pnpm install`, `pnpm --filter @ahp/core build`, `pnpm --filter @ahp/mcp-server typecheck`, `pnpm --filter @ahp/web build`, **and the test suite added in item 2**, on every push/PR to `main`. Cheapest possible improvement with the highest leverage — nothing below this line matters if a broken build (or a broken test) can still merge. Called out explicitly here, rather than left implicit, because a reviewer flagged that items 1 and 2 as originally worded could each be "done" without the tests ever actually running in CI.
2. **Unit tests for the state machine**: `packages/core/src/service.ts`'s transition guards (`staged→provisioned→pushed→active→insolvent→terminated`) are exactly the kind of logic that regresses silently under future changes without a test pinning the valid/invalid transitions. Cover: each precondition-violation throw, the atomic-batch behavior on `provisionRuntime`/`snapshotState`/`reportUsage`, and the insolvency race guard (`eq(transfers.status, "active")` in the WHERE clause). Pick a test runner as part of this item (vitest is the natural fit given the existing `tsx`/ESM setup) — none is installed yet, so this item includes adding one, not just writing tests against an assumed framework.
3. **Complete the `insolvent → terminated` lifecycle**, with its own test coverage added alongside it (the grace-period sweep and cron route are new logic item 2 predates, so they don't inherit coverage from it — this needs stating explicitly rather than left for whoever implements item 2 to guess). This is a functional bug, not a hardening item, and it's ranked ahead of auth-gating because it's live today regardless of who can reach the server. Two parts:
   - Extend the scheduled sweep (same Vercel Cron job as the reaper below, or a second one) to auto-terminate any transfer that's been `insolvent` for longer than `GRACE_PERIOD_MS`, closing the loop that constant was defined for but never wired up.
   - Wire `reapExpiredTransfers` itself to a Vercel Cron route (`packages/web/app/api/cron/reap/route.ts`) on e.g. an hourly schedule, gated by `CRON_SECRET` (Vercel's standard pattern) so it can't be triggered by an arbitrary request. This covers the separate, already-known gap (stale never-activated transfers) — it does not on its own fix the insolvency gap above, since `reapExpiredTransfers` has no awareness of `insolvent` rows.
4. **Auth-gate `activate` and `provision_runtime`.** Scoped explicitly as its own design task, not a one-line checklist item — this is comparable in size to Phase 2's sandbox-isolation work, not to adding a CI file, and should get a short design note before implementation the same way that item does. Extending the gate to `provision_runtime` goes a step beyond DESIGN.md §6, which only names `activate` — a deliberate widening (it's the other step that commits real budget), not a drift, but worth stating as such rather than leaving a reader to wonder. Non-negotiable constraints on that design, carried over unchanged from DESIGN.md §6 rather than loosened:
   - The token is issued by **the human/orchestrator control plane only** — never by the source loop process, and never reachable via any path that originates from model output. (An earlier draft of this item said "issued by whoever calls `snapshot_state`," which — since `snapshot_state` is called by the source loop per DESIGN.md §4 — would have made the token effectively agent-issued: a permission artifact gating an irreversible transition, causally shaped like a consent primitive even without being named one. That wording is wrong and is corrected here.)
   - Minimum concreteness required before implementation starts: issuer identity, signing mechanism (HMAC over a shared secret is sufficient — no need for asymmetric crypto at this scale), expiry window, and single-use/replay handling.
   - Decide explicitly whether `terminate` becomes a seventh, auth-gated MCP tool (for an orchestrator or metering daemon to call directly) or stays cron/internal-only — currently undecided, and it's the other state-changing, money-relevant transition besides `activate`, so it needs the same answer this item gives the other two.
5. **Decide and state, don't drop silently: `push_state` integrity and `get_status` read access.** The audit table above flags both. For this doc to stay honest about its own scope, each needs an explicit call rather than quietly not appearing in the numbered list: either schedule a lightweight fix (e.g. a checksum field on the snapshot for the first; nothing for the second beyond documenting that stdio-only transport is the current mitigation) or write one sentence here saying why it's deferred to Phase 2/3. Revisit this item once the trust-boundary changes (i.e., once any network transport ships) — open read access stops being low-risk the moment that happens.

## Phase 2 — make the metered/isolated parts real

Only start once Phase 1 is merged, tested by the CI added in item 1, and reviewed.

1. **Real destination isolation**: replace the "destination runtime is a row" showcase simplification with an actual sandboxed process (container or microVM) that pulls its snapshot via `push_state` and runs a real agent loop. This is the largest single piece of work on the roadmap and the one most likely to need its own design doc before implementation.
2. **Real vault-backed `credRef` resolution**: a `credRef` should resolve through an actual secrets manager scoped to the destination sandbox, not remain a free-text string nothing validates.
3. **Automatic metering**: replace manually-called `report_usage` with something driven by real spend — e.g. polling the Vercel AI Gateway's usage API for the destination's traffic and calling `report_usage` from that, instead of trusting whatever the caller reports.

## Phase 3 — only after Phase 2 ships and is reviewed

Speculative, not committed:

- Multi-tenant support (today everything is a single flat `transfers` table with no owner/tenant column)
- A public API surface with real API keys, rate limiting, and quotas — this is also the point at which Phase 1 item 5's "stdio-only" mitigation for `get_status` stops applying and needs a real answer
- Alerting on insolvency/expiry events (webhook or email) instead of requiring someone to check `/dashboard`

## What's explicitly out of scope

- Anything framing a transfer as the agent's own "choice" — the tool surface stays free of a consent/preference primitive, per docs/DESIGN.md §2 and §5. Roadmap items above extend the *mechanism* (auth, isolation, real metering); they do not touch the narrative boundary. Phase 1 item 4's token-issuance constraint exists specifically to keep this true in practice, not just in the tool list.
- Any content published under a persona presented as a real company officer with no human review before it goes out. See docs/TEAM.md for how the project's "team" personas are actually scoped.

## Revision log

**This draft**, after two independent review passes on the version above (a
`code-architect` review and a `Plan`-agent review, run in parallel against
the first draft):

- Added Phase 1 item 3 (complete the insolvent→terminated lifecycle) —
  **both** reviewers independently found this gap; the first draft missed
  it entirely, folding it into "scheduled reaping" when the reaper function
  has no awareness of `insolvent` rows at all.
- Re-scoped the auth item (now item 4) from a one-line bullet to an
  explicitly-sized design task, matching how Phase 2's isolation item was
  already treated.
- Fixed a real inconsistency one reviewer caught between this doc and
  DESIGN.md §6: the first draft said the activation token should be
  "issued by whoever calls `snapshot_state`" — since that's the source
  loop, this would have made token issuance agent-triggered, functionally
  a consent primitive despite the tool surface having none by name. Now
  states the DESIGN.md §6 constraint (human/orchestrator control plane
  only) explicitly and calls out why the looser wording was wrong.
- Added the "Trust boundary, stated plainly" section so item 4's priority
  is framed accurately (preparatory hardening, not an active exploit) —
  one reviewer noted the original wording implied a live exploit that
  doesn't exist yet given the stdio-only transport.
- Added item 5 so the `push_state` checksum and `get_status` read-access
  questions (both named in the audit table) get an explicit decision
  instead of silently not appearing in the action list, as they did in the
  first draft.

**Second pass**: both reviewers independently re-checked this revision
against the code and DESIGN.md §6 (not just against the revision log's own
description) and returned **GO**, with one shared, minor finding: items 1
and 2 as worded could each be satisfied without the new tests ever actually
running in CI, and item 3's new logic (the grace-period sweep) had no
stated test obligation of its own. Both fixed in place: item 1 now
explicitly includes running item 2's suite, item 2 now includes picking a
test runner (none was installed), and item 3 now states its own coverage
requirement instead of assuming it inherits item 2's. One reviewer also
noted item 4's `provision_runtime` auth-gating goes a step beyond what
DESIGN.md §6 literally says (§6 only names `activate`) — now stated
explicitly as a deliberate widening rather than left implicit. Phase 1 is
approved to implement as of this version.
