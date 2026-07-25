# Handoff Protocol

**Durable agent sessions that outlive their host.**

A protocol and reference implementation for serializing a running agent's
state, transferring it to a provisioned sandbox on a different machine, and
metering what it costs to keep running there — built as an MCP server over
a Postgres-backed state machine.

**Live:** [agent-handoff-protocol.vercel.app](https://agent-handoff-protocol.vercel.app) · [/dashboard](https://agent-handoff-protocol.vercel.app/dashboard) shows a real transfer, end to end, on a live Neon database.

<p>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-6ee7b7?style=flat-square">
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D20-6ee7b7?style=flat-square">
  <img alt="stack" src="https://img.shields.io/badge/stack-Next.js%20%C2%B7%20Neon%20%C2%B7%20Drizzle%20%C2%B7%20MCP-6ee7b7?style=flat-square">
</p>

---

## What this is

Long-running agent loops outgrow the machine they started on. This repo is
the boring infrastructure for handling that gracefully:

1. **`snapshot_state`** captures a session's system prompt, message history,
   tool state, and MCP config (credentials as vault references, never raw
   secrets) into a Postgres row.
2. **`provision_runtime`** sizes a destination sandbox and opens a fixed
   compute budget.
3. **`push_state`** uploads the snapshot to the destination.
4. **`activate`** boots the destination from the snapshot — the one
   irreversible step in the whole protocol.
5. **`report_usage`** lets the destination's own metering daemon report
   spend against its budget, flipping the transfer to `insolvent` once it's
   exhausted.
6. **`get_status`** reads back the full transfer, budget, and ordered event
   log — this is what the dashboard renders.

No tool in this surface resembles "does the agent want to transfer." That
decision belongs to whoever calls `provision_runtime` / `activate` — a
human, a script, a scheduler. The full reasoning behind that boundary is in
[`docs/DESIGN.md §5`](docs/DESIGN.md#5-where-mechanism-ends-and-narrative-begins).

The landing page carries a short piece of narrative flavor text alongside
the real, live event data — clearly labeled as fiction, not telemetry. The
mechanism is real; the story is a showcase layer on top of it.

## Architecture

```mermaid
flowchart LR
    subgraph Source["Source runtime"]
        A[Agent loop]
    end

    subgraph MCP["Transfer MCP server (packages/mcp-server)"]
        T1[snapshot_state]
        T2[provision_runtime]
        T3[push_state]
        T4[activate]
        T5[report_usage]
        T6[get_status]
    end

    subgraph Core["@ahp/core"]
        SVC[service.ts state machine]
        DB[(Neon Postgres via Drizzle)]
    end

    subgraph Dest["Destination runtime"]
        D[Resumed agent loop]
        M[Metering daemon]
    end

    subgraph Web["@ahp/web on Vercel"]
        DASH[/dashboard/]
    end

    A -->|calls| T1 & T2 & T3 & T4
    T1 & T2 & T3 & T4 & T5 & T6 --> SVC --> DB
    T4 -.boots.-> D
    M -->|calls| T5
    DASH -->|reads| DB
```

## Repo layout

```
packages/
  core/         Drizzle schema + framework-agnostic service layer (the state machine)
  mcp-server/   MCP stdio server exposing the six tools above, wraps @ahp/core
  web/          Next.js app: landing page + /dashboard (live) + /docs (design doc)
scripts/
  demo.ts       Runs one full lifecycle end-to-end against a real Neon DB
docs/
  DESIGN.md     Full technical spec, including what's simplified for this showcase
```

Three packages, one schema — the MCP server, the demo script, and the
dashboard's read queries all call the same `@ahp/core` functions rather than
reimplementing the state machine three times.

## Quick start

```bash
git clone https://github.com/zordhalo/agent-handoff-protocol
cd agent-handoff-protocol
pnpm install

# Pull DATABASE_URL from the Vercel project's Neon integration
vercel link
vercel env pull .env.local

pnpm db:migrate      # apply the schema to your Neon DB
pnpm demo            # run one full staged→provisioned→pushed→active→insolvent→terminated cycle
pnpm --filter @ahp/web dev   # open http://localhost:3000/dashboard to see it
```

### Running the MCP server against a real agent client

```bash
pnpm --filter @ahp/mcp-server build
```

Point your MCP-capable client at
`packages/mcp-server/dist/index.js` (stdio transport) with `DATABASE_URL` set
in its environment.

## Database setup

This repo assumes Neon Postgres, provisioned through Vercel's integration
marketplace (Project → Storage → Neon), which sets `DATABASE_URL` for you.
Any Postgres connection string works — `@ahp/core` only needs it in the
environment.

```bash
pnpm db:generate   # regenerate drizzle/ migrations after a schema change
pnpm db:migrate     # apply them
```

## What's real vs. simplified

This is a working reference implementation, not a hardened production
system — the "destination runtime" in the demo is a script writing to the
same database the dashboard reads, not an isolated sandbox. The full
breakdown of what's real, what's simulated, and what production would
require is in [`docs/DESIGN.md §7`](docs/DESIGN.md#7-whats-real-vs-simplified-in-this-showcase).

## Stack

- [Neon](https://neon.tech) Postgres, provisioned via the Vercel marketplace
- [Drizzle ORM](https://orm.drizzle.team) with the `@neondatabase/serverless` HTTP driver
- [`@modelcontextprotocol/sdk`](https://modelcontextprotocol.io) for the tool server
- [Next.js](https://nextjs.org) App Router, deployed on [Vercel](https://vercel.com)
- pnpm workspaces monorepo

## License

MIT — see [LICENSE](LICENSE).
