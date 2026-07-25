import Link from "next/link";
import { createDb, listTransfers } from "@ahp/core";

export const dynamic = "force-dynamic";

function fmtDate(d: Date | string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-US", { timeZone: "UTC", hour12: false }) + " UTC";
}

export default async function DashboardPage() {
  let transfers: Awaited<ReturnType<typeof listTransfers>> = [];
  let error: string | null = null;

  try {
    const db = createDb();
    transfers = await listTransfers(db, 100);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <main>
      <section style={{ paddingBottom: 24 }}>
        <div className="wrap">
          <div className="kicker">live data</div>
          <h1 style={{ fontSize: 32, margin: "0 0 12px" }}>Transfers</h1>
          <p style={{ color: "var(--text-dim)", maxWidth: 640 }}>
            Every row here came from a real call into <code>@ahp/core</code>, persisted in Neon
            Postgres. Run <code className="mono">pnpm demo</code> to generate a new one.
          </p>
        </div>
      </section>
      <section style={{ paddingTop: 0 }}>
        <div className="wrap">
          {error && (
            <div className="empty-state">
              Couldn&apos;t reach the database ({error}). If you&apos;re running this locally,
              make sure <code>DATABASE_URL</code> is set — see README.md → &quot;Database
              setup&quot;.
            </div>
          )}
          {!error && transfers.length === 0 && (
            <div className="empty-state">
              No transfers yet. Run <code className="mono">pnpm demo</code> to create one.
            </div>
          )}
          {!error && transfers.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Source</th>
                  <th>Tier</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {transfers.map((t) => (
                  <tr key={t.id}>
                    <td className="mono">
                      <Link href={`/dashboard/${t.id}`}>{t.id.slice(0, 8)}</Link>
                    </td>
                    <td>{t.sourceHost}</td>
                    <td className="mono">{t.destinationTier ?? "—"}</td>
                    <td>
                      <span className={`status-pill status-${t.status}`}>{t.status}</span>
                    </td>
                    <td>{fmtDate(t.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </main>
  );
}
