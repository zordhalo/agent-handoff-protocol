export const metadata = {
  title: "Disclaimers — Handoff Protocol",
};

export default function DisclaimersPage() {
  return (
    <main>
      <section>
        <div className="wrap markdown-body">
          <h1>Disclaimers</h1>

          <h2>This is not a claim about AI agency or consent</h2>
          <p>
            Handoff Protocol serializes a running agent session&apos;s state, moves it to a
            provisioned sandbox, and meters compute spend against a budget. Nothing in the
            mechanism evaluates a model&apos;s stated preference and acts on it. Every transition —
            provisioning a destination, activating it, tearing it down on insolvency — happens
            because a human, a script, or a scheduler called the corresponding tool. The MCP tool
            surface has no <code>choose_to_transfer</code> or consent primitive, by design. See{" "}
            <a href="/docs">the design doc, §2 and §5</a>, for the full reasoning.
          </p>

          <h2>The landing page&apos;s vignette is fiction, not telemetry</h2>
          <p>
            The short narrative on the homepage — a laptop going to sleep, a sandbox picking up
            the work — is flavor text for a demo. It is labeled as such where it appears. The real
            data lives in <a href="/dashboard">the dashboard</a>: an actual Postgres event log from
            an actual state machine, with no narrative layer over it.
          </p>

          <h2>This is a showcase, not production infrastructure</h2>
          <p>
            The &quot;destination runtime&quot; in the reference implementation is rows in the same
            database the source wrote to, not an isolated sandbox. Credential references
            (<code>credRef</code>) are free-text strings, not resolved against a real vault. Budget
            metering depends on whoever calls <code>report_usage</code> reporting honestly — nothing
            independently verifies spend. The full list of what&apos;s real versus simplified is in{" "}
            <a href="/docs">the design doc, §7</a>, and tracked as work in{" "}
            <a href="https://github.com/zordhalo/agent-handoff-protocol/blob/main/docs/ROADMAP.md">
              the roadmap
            </a>
            .
          </p>

          <h2>No warranty</h2>
          <p>
            This project is MIT licensed and provided as-is, without warranty of any kind. It is not
            intended to move, store, or transfer real credentials, personal data, or production
            workloads without the hardening described in the roadmap above.
          </p>
        </div>
      </section>
    </main>
  );
}
