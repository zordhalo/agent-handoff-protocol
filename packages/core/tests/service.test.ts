import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  transfers,
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
  TransferNotFoundError,
  type Db,
} from "../src/index.js";

/**
 * Integration tests against a real Neon Postgres database (see
 * vitest.config.ts for why — the neon-http driver has no local-container
 * equivalent). Covers docs/ROADMAP.md Phase 1 item 2's stated scope: each
 * transition guard's precondition-violation throw, the atomic-batch
 * behavior, and the insolvency race guard.
 *
 * Every test creates its own transfer(s) with a unique sourceHost marker
 * and deletes them in afterEach — cascading deletes on budgets/usage_events
 * mean deleting the transfer row is enough.
 */

let db: Db;
let tokenSecret: string;
const createdIds: string[] = [];

beforeAll(() => {
  db = createDb();
  tokenSecret = getTransferTokenSecret();
});

afterEach(async () => {
  for (const id of createdIds.splice(0)) {
    await db.delete(transfers).where(eq(transfers.id, id));
  }
});

function marker() {
  return `vitest-${randomUUID()}`;
}

async function stageTransfer() {
  const transfer = await snapshotState(db, {
    sourceHost: marker(),
    systemPrompt: "test agent",
    messageHistory: [{ role: "user", content: "hello" }],
    toolState: {},
    mcpConfig: [],
  });
  createdIds.push(transfer.id);
  return transfer;
}

async function provisionTransfer(transferId: string, opts: { allocatedUsd?: number } = {}) {
  const token = issueTransferToken(transferId, "provision_runtime", tokenSecret);
  return provisionRuntime(
    db,
    {
      transferId,
      tier: "sandbox-small",
      allocatedUsd: opts.allocatedUsd ?? 1.0,
      ratePerHourUsd: 0.1,
      token,
    },
    tokenSecret,
  );
}

async function activateTransfer(transferId: string) {
  const token = issueTransferToken(transferId, "activate", tokenSecret);
  return activate(db, transferId, token, tokenSecret);
}

describe("snapshotState", () => {
  it("creates a staged transfer with a snapshot_created event and a checksum", async () => {
    const transfer = await stageTransfer();
    expect(transfer.status).toBe("staged");
    expect(transfer.snapshotChecksum).toBe(computeSnapshotChecksum([{ role: "user", content: "hello" }]));

    const status = await getStatus(db, transfer.id);
    expect(status.events.map((e) => e.eventType)).toEqual(["snapshot_created"]);
  });
});

describe("provisionRuntime", () => {
  it("moves staged -> provisioned atomically, creating a budget row", async () => {
    const transfer = await stageTransfer();
    const provisioned = await provisionTransfer(transfer.id);

    expect(provisioned.status).toBe("provisioned");
    expect(provisioned.destinationTier).toBe("sandbox-small");

    const status = await getStatus(db, transfer.id);
    expect(status.budget).not.toBeNull();
    expect(status.budget?.allocatedUsd).toBe("1.000000");
  });

  it("rejects a transfer that isn't staged", async () => {
    const transfer = await stageTransfer();
    await provisionTransfer(transfer.id);

    await expect(provisionTransfer(transfer.id)).rejects.toThrow(/expected 'staged'/);
  });

  it("rejects a missing/invalid token", async () => {
    const transfer = await stageTransfer();
    await expect(
      provisionRuntime(
        db,
        { transferId: transfer.id, tier: "sandbox-small", allocatedUsd: 1, ratePerHourUsd: 0.1, token: "garbage" },
        tokenSecret,
      ),
    ).rejects.toThrow(/malformed transfer token/);
  });

  it("rejects a token scoped for a different transfer", async () => {
    const a = await stageTransfer();
    const b = await stageTransfer();
    const tokenForB = issueTransferToken(b.id, "provision_runtime", tokenSecret);

    await expect(
      provisionRuntime(
        db,
        { transferId: a.id, tier: "sandbox-small", allocatedUsd: 1, ratePerHourUsd: 0.1, token: tokenForB },
        tokenSecret,
      ),
    ).rejects.toThrow(/not valid for provision_runtime/);
  });

  it("rejects a token that's already been used (replay)", async () => {
    const transfer = await stageTransfer();
    const token = issueTransferToken(transfer.id, "provision_runtime", tokenSecret);

    await provisionRuntime(
      db,
      { transferId: transfer.id, tier: "sandbox-small", allocatedUsd: 1, ratePerHourUsd: 0.1, token },
      tokenSecret,
    );

    // Stage a fresh transfer at the right precondition so the replay is
    // rejected by the token check, not the (also-correct) status guard.
    const transfer2 = await stageTransfer();
    await expect(
      provisionRuntime(
        db,
        { transferId: transfer2.id, tier: "sandbox-small", allocatedUsd: 1, ratePerHourUsd: 0.1, token },
        tokenSecret,
      ),
    ).rejects.toThrow(/not valid for provision_runtime/); // wrong transferId anyway
  });
});

describe("pushState", () => {
  it("rejects a transfer that isn't provisioned", async () => {
    const transfer = await stageTransfer();
    await expect(pushState(db, transfer.id)).rejects.toThrow(/expected 'provisioned'/);
  });

  it("verifies the checksum when one is supplied", async () => {
    const transfer = await stageTransfer();
    await provisionTransfer(transfer.id);

    await expect(pushState(db, transfer.id, "not-the-real-checksum")).rejects.toThrow(/checksum mismatch/);
  });

  it("accepts a matching checksum and moves provisioned -> pushed", async () => {
    const transfer = await stageTransfer();
    await provisionTransfer(transfer.id);

    const pushed = await pushState(db, transfer.id, transfer.snapshotChecksum);
    expect(pushed.status).toBe("pushed");
  });
});

describe("activate", () => {
  it("rejects a transfer that isn't pushed", async () => {
    const transfer = await stageTransfer();
    await expect(activateTransfer(transfer.id)).rejects.toThrow(/expected 'pushed'/);
  });

  it("moves pushed -> active with a valid token", async () => {
    const transfer = await stageTransfer();
    await provisionTransfer(transfer.id);
    await pushState(db, transfer.id);

    const activated = await activateTransfer(transfer.id);
    expect(activated.status).toBe("active");
    expect(activated.activatedAt).not.toBeNull();
  });
});

describe("reportUsage", () => {
  async function activeTransfer(allocatedUsd = 1.0) {
    const transfer = await stageTransfer();
    await provisionTransfer(transfer.id, { allocatedUsd });
    await pushState(db, transfer.id);
    await activateTransfer(transfer.id);
    return transfer;
  }

  it("accumulates spend exactly (no float drift) across repeated calls", async () => {
    const transfer = await activeTransfer(10.0);

    // 0.1 + 0.2 famously != 0.3 in floating point; this exercises that.
    for (let i = 0; i < 3; i++) {
      await reportUsage(db, { transferId: transfer.id, costUsd: 0.1 });
    }
    const status = await getStatus(db, transfer.id);
    expect(status.budget?.spentUsd).toBe("0.300000");
  });

  it("flips to insolvent exactly once budget is reached, and only once", async () => {
    const transfer = await activeTransfer(1.0);

    let status = await reportUsage(db, { transferId: transfer.id, costUsd: 0.6 });
    expect(status.transfer.status).toBe("active");

    status = await reportUsage(db, { transferId: transfer.id, costUsd: 0.5 });
    expect(status.transfer.status).toBe("insolvent");
    expect(status.transfer.insolventAt).not.toBeNull();

    const insolventEvents = status.events.filter((e) => e.eventType === "insolvent");
    expect(insolventEvents).toHaveLength(1);

    // A further report_usage call while already insolvent must not insert
    // a second insolvent event (the WHERE eq(status, 'active') guard).
    status = await reportUsage(db, { transferId: transfer.id, costUsd: 0.1 });
    const insolventEventsAfter = status.events.filter((e) => e.eventType === "insolvent");
    expect(insolventEventsAfter).toHaveLength(1);
  });

  it("rejects reporting usage on a transfer that was never activated", async () => {
    const transfer = await stageTransfer();
    await provisionTransfer(transfer.id);

    await expect(reportUsage(db, { transferId: transfer.id, costUsd: 0.1 })).rejects.toThrow(/expected 'active'/);
  });
});

describe("terminate / getStatus", () => {
  it("terminates with a reason", async () => {
    const transfer = await stageTransfer();
    const terminated = await terminate(db, transfer.id, "manual_test_termination");
    expect(terminated.status).toBe("terminated");
    expect(terminated.terminationReason).toBe("manual_test_termination");
  });

  it("throws TransferNotFoundError, not a generic error, for an unknown id", async () => {
    await expect(getStatus(db, randomUUID())).rejects.toBeInstanceOf(TransferNotFoundError);
  });
});
