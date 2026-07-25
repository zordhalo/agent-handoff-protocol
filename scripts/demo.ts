import { existsSync } from "node:fs";
import {
  createDb,
  snapshotState,
  provisionRuntime,
  pushState,
  activate,
  reportUsage,
  terminate,
  getStatus,
  computeSnapshotChecksum,
  issueTransferToken,
  getTransferTokenSecret,
} from "@ahp/core";

// Load a local .env / .env.local if present (e.g. after `vercel env pull`).
for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) process.loadEnvFile(file);
}

/**
 * End-to-end walkthrough of the handoff protocol against a real Neon
 * database: snapshot -> provision -> push -> activate -> meter -> insolvent
 * -> terminate. This is what the web dashboard's data comes from — run it,
 * then look at /dashboard.
 *
 * The "agent" here is a stand-in: a long-running inventory-forecasting loop
 * that outgrows its original host and gets hopped to a dedicated sandbox.
 * Swap the snapshot payload for real session state to use this for real.
 *
 * This script plays the orchestrator role for provision_runtime/activate's
 * transfer-auth tokens (docs/ROADMAP.md Phase 1 item 4) — it calls
 * issueTransferToken directly, the same way a human-operated control plane
 * would, never the source loop itself.
 */

const db = createDb();
const tokenSecret = getTransferTokenSecret();

function log(step: string, detail: unknown) {
  console.log(`\n[${step}]`);
  console.log(JSON.stringify(detail, null, 2));
}

async function main() {
  const snapshot = await snapshotState(db, {
    sourceHost: "laptop-lucas-dev",
    systemPrompt:
      "You are an inventory-forecasting agent. Reconcile supplier lead times against sales velocity and flag reorder points.",
    messageHistory: [
      { role: "user", content: "Start the weekly reorder sweep for warehouse EU-3." },
      { role: "assistant", content: "Pulled 1,204 SKUs. Cross-referencing lead times now." },
    ],
    toolState: { phase: "cross-referencing", skusProcessed: 412, skusTotal: 1204 },
    mcpConfig: [{ server: "warehouse-db", credRef: "vault://warehouse-db/readonly" }],
  });
  log("snapshot_state", { transferId: snapshot.id, status: snapshot.status });

  const provisionToken = issueTransferToken(snapshot.id, "provision_runtime", tokenSecret);
  const provisioned = await provisionRuntime(
    db,
    {
      transferId: snapshot.id,
      tier: "sandbox-medium",
      allocatedUsd: 2.0,
      ratePerHourUsd: 0.25,
      token: provisionToken,
    },
    tokenSecret,
  );
  log("provision_runtime", { status: provisioned.status, tier: provisioned.destinationTier });

  const expectedChecksum = computeSnapshotChecksum(snapshot.messageHistory as Array<{ role: string; content: string }>);
  const pushed = await pushState(db, snapshot.id, expectedChecksum);
  log("push_state", { status: pushed.status, checksumVerified: true });

  const activateToken = issueTransferToken(snapshot.id, "activate", tokenSecret);
  const activated = await activate(db, snapshot.id, activateToken, tokenSecret);
  log("activate", { status: activated.status, activatedAt: activated.activatedAt });

  // Simulate the destination sandbox's metering daemon reporting spend
  // every "tick" until the budget runs out.
  const perTickCost = 0.35;
  let status = await getStatus(db, snapshot.id);
  let tick = 0;
  while (status.transfer.status === "active") {
    tick += 1;
    status = await reportUsage(db, {
      transferId: snapshot.id,
      costUsd: perTickCost,
      detail: { tick, note: "resumed forecasting sweep on destination sandbox" },
    });
    log(`report_usage (tick ${tick})`, {
      status: status.transfer.status,
      spentUsd: status.budget?.spentUsd,
      allocatedUsd: status.budget?.allocatedUsd,
    });
  }

  if (status.transfer.status === "insolvent") {
    // Terminating immediately here for a fast demo. In a real deployment
    // this is optional — the grace-period cron sweep
    // (reapInsolventTransfers, wired to /api/cron/reap) auto-terminates
    // any transfer still insolvent after GRACE_PERIOD_MS even if nothing
    // calls terminate directly.
    const terminated = await terminate(db, snapshot.id, "budget_exhausted");
    log("terminate", { status: terminated.status, reason: terminated.terminationReason });
  }

  const final = await getStatus(db, snapshot.id);
  log("final getStatus", {
    transfer: final.transfer,
    budget: final.budget,
    eventCount: final.events.length,
  });

  console.log(`\nDone. View this transfer at /dashboard/${snapshot.id} once the web app is running.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
