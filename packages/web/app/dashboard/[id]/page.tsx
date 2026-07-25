import Link from "next/link";
import { notFound } from "next/navigation";
import { createDb, getStatus } from "@ahp/core";

export const dynamic = "force-dynamic";

function fmtDate(d: Date | string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-US", { timeZone: "UTC", hour12: false }) + " UTC";
}

export default async function TransferDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = createDb();

  let status: Awaited<ReturnType<typeof getStatus>>;
  try {
    status = await getStatus(db, id);
  } catch {
    notFound();
  }

  const { transfer, budget, events } = status;
  const burnPct = budget ? Math.min(100, (Number(budget.spentUsd) / Number(budget.allocatedUsd)) * 100) : 0;

  return (
    <main>
      <section style={{ paddingBottom: 24 }}>
        <div className="wrap">
          <Link href="/dashboard" style={{ color: "var(--text-dim)", fontSize: 13 }}>
            ← all transfers
          </Link>
          <h1 className="mono" style={{ fontSize: 24, margin: "12px 0" }}>
            {transfer.id}
          </h1>
          <span className={`status-pill status-${transfer.status}`}>{transfer.status}</span>
        </div>
      </section>

      <section>
        <div className="wrap">
          <h2>Summary</h2>
          <div className="grid-3">
            <div className="card">
              <div className="step">source</div>
              <h3 style={{ fontSize: 14 }} className="mono">
                {transfer.sourceHost}
              </h3>
            </div>
            <div className="card">
              <div className="step">destination tier</div>
              <h3 style={{ fontSize: 14 }} className="mono">
                {transfer.destinationTier ?? "unprovisioned"}
              </h3>
            </div>
            <div className="card">
              <div className="step">created</div>
              <h3 style={{ fontSize: 14 }} className="mono">
                {fmtDate(transfer.createdAt)}
              </h3>
            </div>
          </div>
        </div>
      </section>

      {budget && (
        <section>
          <div className="wrap">
            <h2>Budget</h2>
            <p style={{ color: "var(--text-dim)", fontSize: 14 }}>
              ${Number(budget.spentUsd).toFixed(4)} spent of ${Number(budget.allocatedUsd).toFixed(4)}{" "}
              allocated ({budget.ratePerHourUsd}/hr rate)
            </p>
            <div
              style={{
                height: 8,
                borderRadius: 999,
                background: "var(--bg-raised)",
                border: "1px solid var(--border)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${burnPct}%`,
                  background: burnPct >= 100 ? "var(--danger)" : "var(--accent)",
                }}
              />
            </div>
          </div>
        </section>
      )}

      <section>
        <div className="wrap">
          <h2>Event log</h2>
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Event</th>
                <th>Cost</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="mono" style={{ whiteSpace: "nowrap" }}>
                    {fmtDate(e.createdAt)}
                  </td>
                  <td className="mono">{e.eventType}</td>
                  <td className="mono">{Number(e.costUsd) > 0 ? `$${Number(e.costUsd).toFixed(4)}` : "—"}</td>
                  <td className="mono" style={{ fontSize: 12, color: "var(--text-dim)" }}>
                    {JSON.stringify(e.detail)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <div className="wrap">
          <h2>Raw snapshot</h2>
          <pre className="code-block">
            {JSON.stringify(
              {
                systemPrompt: transfer.systemPrompt,
                messageHistory: transfer.messageHistory,
                toolState: transfer.toolState,
                mcpConfig: transfer.mcpConfig,
              },
              null,
              2,
            )}
          </pre>
        </div>
      </section>
    </main>
  );
}
