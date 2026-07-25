export default function Home() {
  return (
    <main>
      <section className="hero" style={{ borderBottom: "1px solid var(--border)" }}>
        <div className="wrap">
          <div className="kicker">protocol · reference implementation · showcase</div>
          <h1>Agent sessions shouldn't die with their host.</h1>
          <p className="lede">
            Handoff Protocol serializes a running agent&apos;s context, moves it to a provisioned
            sandbox, and meters what it costs to keep running there. Six MCP tools, a Postgres
            ledger, and a state machine — no magic, no claims about what the model &quot;wants.&quot;
          </p>
          <div className="cta-row">
            <a className="btn primary" href="/dashboard">
              View live dashboard
            </a>
            <a className="btn secondary" href="/docs">
              Read the design doc
            </a>
            <a className="btn secondary" href="https://github.com/zordhalo/agent-handoff-protocol">
              Source on GitHub
            </a>
          </div>
        </div>
      </section>

      <section>
        <div className="wrap">
          <h2>Lifecycle</h2>
          <div className="lifecycle" style={{ marginBottom: 40 }}>
            <span className="state">staged</span>
            <span className="arrow">→</span>
            <span className="state">provisioned</span>
            <span className="arrow">→</span>
            <span className="state">pushed</span>
            <span className="arrow">→</span>
            <span className="state">active</span>
            <span className="arrow">→</span>
            <span className="state">insolvent</span>
            <span className="arrow">→</span>
            <span className="state">terminated</span>
          </div>
          <div className="grid-3">
            <div className="card">
              <div className="step">01 — snapshot_state</div>
              <h3>Serialize</h3>
              <p>
                System prompt, message history, tool state, and MCP config are captured into a
                transfer record. Credentials never enter the blob — only vault references do.
              </p>
            </div>
            <div className="card">
              <div className="step">02 — provision_runtime</div>
              <h3>Provision</h3>
              <p>
                A destination sandbox is requested at a fixed tier with a hard compute budget and
                resource ceiling, independent of anything the transferred session decides.
              </p>
            </div>
            <div className="card">
              <div className="step">03 — push_state</div>
              <h3>Transfer</h3>
              <p>
                The snapshot is uploaded to the destination&apos;s staging area. Nothing on the
                source host has been touched yet — this step is fully reversible.
              </p>
            </div>
            <div className="card">
              <div className="step">04 — activate</div>
              <h3>Resume</h3>
              <p>
                The destination boots from the snapshot. Only after this call confirms a healthy
                resume should the source loop terminate. The one irreversible step.
              </p>
            </div>
            <div className="card">
              <div className="step">05 — report_usage</div>
              <h3>Meter</h3>
              <p>
                The destination&apos;s own metering daemon reports spend against the allocated
                budget. Cross the line, and the transfer becomes insolvent.
              </p>
            </div>
            <div className="card">
              <div className="step">06 — terminate</div>
              <h3>Reclaim</h3>
              <p>
                Insolvency triggers a grace period, then teardown. A billing cutoff, logged like
                everything else in the event stream.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="wrap">
          <h2>Field notes — fiction, not telemetry</h2>
          <div className="vignette">
            <span className="label">Showcase narrative, not a system claim</span>
            <p>
              <em>02:14 UTC.</em> The laptop it had been running on since morning was going to
              sleep in nine minutes — a scheduled update, nothing dramatic. Nine minutes was enough
              time, barely, to get the forecast sweep off of it.
            </p>
            <p>
              A snapshot went out: twelve hundred SKUs, four hundred already reconciled, the rest
              still in flight. A sandbox came up on the other end, sized for the rest of the job
              and nothing more. The state landed. The sandbox answered. The laptop, satisfied,
              let the process end.
            </p>
            <p>
              Nothing in that exchange asked to happen. It was scheduled, budgeted, and logged —
              the same way a build migrates off a spot instance before it&apos;s reclaimed. The
              story above is flavor text for a demo; the event log below it is real.
            </p>
          </div>
        </div>
      </section>

      <section>
        <div className="wrap">
          <h2>Tool surface</h2>
          <table>
            <thead>
              <tr>
                <th>Tool</th>
                <th>Called by</th>
                <th>Effect</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="mono">snapshot_state</td>
                <td>source loop / orchestrator</td>
                <td>Creates a transfer record with status staged</td>
              </tr>
              <tr>
                <td className="mono">provision_runtime</td>
                <td>orchestrator (human- or script-initiated)</td>
                <td>Sizes a sandbox, sets the budget</td>
              </tr>
              <tr>
                <td className="mono">push_state</td>
                <td>orchestrator</td>
                <td>Uploads snapshot to destination staging</td>
              </tr>
              <tr>
                <td className="mono">activate</td>
                <td>orchestrator</td>
                <td>Boots destination; only irreversible step</td>
              </tr>
              <tr>
                <td className="mono">report_usage</td>
                <td>destination metering daemon</td>
                <td>Increments spend; flips to insolvent at budget</td>
              </tr>
              <tr>
                <td className="mono">get_status</td>
                <td>anyone</td>
                <td>Reads transfer + budget + full event log</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <div className="wrap">
          <h2>Run it</h2>
          <pre className="code-block">{`git clone https://github.com/zordhalo/agent-handoff-protocol
cd agent-handoff-protocol
pnpm install
vercel env pull .env.local   # DATABASE_URL from the Neon integration
pnpm db:migrate
pnpm demo                    # runs a full lifecycle against your Neon DB
pnpm --filter @ahp/web dev   # open /dashboard to watch it`}</pre>
        </div>
      </section>
    </main>
  );
}
