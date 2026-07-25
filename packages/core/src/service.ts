import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { transfers, budgets, usageEvents } from "./schema.js";
import type {
  SnapshotStateInput,
  ProvisionRuntimeInput,
  ReportUsageInput,
  DestinationTier,
} from "./types.js";
import { TIER_LIMITS } from "./types.js";
import { consumeTransferToken } from "./auth.js";

/**
 * Service layer behind every MCP tool. Kept framework-agnostic (no MCP
 * imports here) so it can be exercised directly from the demo script, the
 * web dashboard's read queries, and the MCP server, without duplicating
 * business logic in three places.
 *
 * State machine: staged -> provisioned -> pushed -> active -> (insolvent) -> terminated
 * "expired" is a terminal state reached if a staged/provisioned transfer is
 * never activated within its TTL — see reapExpiredTransfers().
 */

// Exported (not module-private) so the test suite can construct
// past-cutoff timestamps directly rather than waiting out real time.
export const GRACE_PERIOD_MS = 60_000;
export const STAGE_TTL_MS = 30 * 60_000;

/** Thrown by requireTransfer when a transfer id doesn't exist — distinct
 * from any other failure (network, connection, etc.) so callers can tell
 * "not found" apart from "couldn't reach the database." */
export class TransferNotFoundError extends Error {
  constructor(transferId: string) {
    super(`Transfer ${transferId} not found`);
    this.name = "TransferNotFoundError";
  }
}

export function computeSnapshotChecksum(messageHistory: SnapshotStateInput["messageHistory"]): string {
  return createHash("sha256").update(JSON.stringify(messageHistory)).digest("hex");
}

export async function snapshotState(db: Db, input: SnapshotStateInput) {
  // Generated client-side so the transfer row and its audit event can be
  // written atomically in one batch (see provisionRuntime for why this
  // matters: a torn write between the two here would leave a transfer with
  // no snapshot_created event, harmless, but the pattern should be
  // consistent everywhere it's cheap to make it so).
  const id = crypto.randomUUID();
  const snapshotChecksum = computeSnapshotChecksum(input.messageHistory);

  const [[transfer]] = await db.batch([
    db
      .insert(transfers)
      .values({
        id,
        sourceHost: input.sourceHost,
        systemPrompt: input.systemPrompt,
        messageHistory: input.messageHistory,
        toolState: input.toolState,
        mcpConfig: input.mcpConfig,
        status: "staged",
        snapshotChecksum,
      })
      .returning(),
    db.insert(usageEvents).values({
      transferId: id,
      eventType: "snapshot_created",
      detail: { sourceHost: input.sourceHost, messageCount: input.messageHistory.length },
    }),
  ]);

  if (!transfer) throw new Error("snapshotState: insert returned no row");
  return transfer;
}

/**
 * Auth-gated per docs/ROADMAP.md Phase 1 item 4: `input.token` must be a
 * valid, unexpired, unused token minted by `issueTransferToken` for this
 * exact transferId and the 'provision_runtime' scope. Token consumption is
 * currently a separate write from the atomic batch below, not the batch's
 * first statement — this is a simplification, not a hard constraint (the
 * nonce insert could join the same db.batch() call to make token-burn and
 * the state change atomic together), so a failure in the batch after a
 * valid token is consumed does burn that token today — the caller needs a
 * fresh one to retry. That's a safe failure mode (a caller can always
 * request a new token) rather than a security gap, since the replay
 * protection itself stays intact either way; it's flagged here as a
 * possible follow-up, not something to treat as settled.
 */
export async function provisionRuntime(db: Db, input: ProvisionRuntimeInput, tokenSecret: string) {
  const transfer = await requireTransfer(db, input.transferId);
  if (transfer.status !== "staged") {
    throw new Error(`provisionRuntime: transfer ${transfer.id} is '${transfer.status}', expected 'staged'`);
  }

  await consumeTransferToken(db, input.token, input.transferId, "provision_runtime", tokenSecret);

  // Atomic: if any of these three writes fails, none of them land, and the
  // transfer stays cleanly at 'staged' for a safe retry (modulo the burned
  // token above). Without this, a failure between the status update and
  // the budget insert would wedge the transfer at 'provisioned' with no
  // budget row and no way back to 'staged' (provisionRuntime's own
  // precondition above forbids it).
  await db.batch([
    db
      .update(transfers)
      .set({ status: "provisioned", provisionedAt: new Date(), destinationTier: input.tier })
      .where(eq(transfers.id, transfer.id)),
    db.insert(budgets).values({
      transferId: transfer.id,
      allocatedUsd: input.allocatedUsd.toFixed(6),
      ratePerHourUsd: input.ratePerHourUsd.toFixed(6),
    }),
    db.insert(usageEvents).values({
      transferId: transfer.id,
      eventType: "runtime_provisioned",
      detail: { tier: input.tier, limits: TIER_LIMITS[input.tier as DestinationTier], allocatedUsd: input.allocatedUsd },
    }),
  ]);

  return requireTransfer(db, transfer.id);
}

/**
 * `expectedChecksum`, if provided, must match the checksum snapshotState
 * computed and stored — a lightweight integrity check standing in for
 * real destination-side verification (see docs/ROADMAP.md Phase 1 item 5).
 * Omitting it skips the check, which is fine for now since nothing outside
 * this database is actually receiving the snapshot yet; Phase 2's real
 * transfer should make this required.
 */
export async function pushState(db: Db, transferId: string, expectedChecksum?: string) {
  const transfer = await requireTransfer(db, transferId);
  if (transfer.status !== "provisioned") {
    throw new Error(`pushState: transfer ${transfer.id} is '${transfer.status}', expected 'provisioned'`);
  }

  if (expectedChecksum !== undefined && expectedChecksum !== transfer.snapshotChecksum) {
    throw new Error(
      `pushState: checksum mismatch for transfer ${transferId} — snapshot may have been altered in transit`,
    );
  }

  await db.update(transfers).set({ status: "pushed", pushedAt: new Date() }).where(eq(transfers.id, transferId));

  await db.insert(usageEvents).values({
    transferId,
    eventType: "state_pushed",
    detail: { bytesApprox: JSON.stringify(transfer.messageHistory).length },
  });

  return requireTransfer(db, transferId);
}

/**
 * Irreversible step. Callers (the MCP server, the demo script) must only
 * terminate the source loop after this resolves successfully — never
 * optimistically. See docs/DESIGN.md §2 ("activate is the only irreversible
 * step"). Auth-gated the same way as provisionRuntime — see that
 * function's docstring for the token-consumption tradeoff.
 *
 * The status-changing UPDATE re-checks `status = 'pushed'` in its own WHERE
 * clause rather than trusting the read above: single-use token consumption
 * alone doesn't stop two concurrent activate calls if the orchestrator
 * (mistakenly or otherwise) issued two distinct valid tokens for the same
 * transfer — each has its own nonce, so both would pass consumeTransferToken.
 * Without this guard both could write status:'active' and each insert their
 * own 'activated' event for what's supposed to be the one irreversible step.
 */
export async function activate(db: Db, transferId: string, token: string, tokenSecret: string) {
  const transfer = await requireTransfer(db, transferId);
  if (transfer.status !== "pushed") {
    throw new Error(`activate: transfer ${transfer.id} is '${transfer.status}', expected 'pushed'`);
  }

  await consumeTransferToken(db, token, transferId, "activate", tokenSecret);

  const [activated] = await db
    .update(transfers)
    .set({ status: "active", activatedAt: new Date() })
    .where(and(eq(transfers.id, transferId), eq(transfers.status, "pushed")))
    .returning();

  if (!activated) {
    throw new Error(`activate: transfer ${transferId} lost a concurrent race to another activate/transition`);
  }

  await db.insert(usageEvents).values({
    transferId,
    eventType: "activated",
    detail: {},
  });

  return activated;
}

export async function reportUsage(db: Db, input: ReportUsageInput) {
  const transfer = await requireTransfer(db, input.transferId);
  if (transfer.status !== "active" && transfer.status !== "insolvent") {
    throw new Error(`reportUsage: transfer ${transfer.id} is '${transfer.status}', expected 'active'`);
  }

  const costUsd = input.costUsd.toFixed(6);

  // Increment atomically in SQL (`spent_usd + costUsd`, both `numeric`)
  // instead of SELECT-then-add-in-JS-then-write. Two prior review passes
  // flagged the old version for two separate, compounding reasons: (a) a
  // read-modify-write with no lock/transaction is a lost-update race under
  // concurrent calls for the same transfer, and (b) doing the addition via
  // `Number(...)` round-trips a currency total through a 64-bit float,
  // exactly what the `numeric` column type exists to avoid. Letting
  // Postgres do the arithmetic in one statement fixes both: it's a single
  // atomic row update, and `numeric + numeric` in SQL is exact.
  // Batched with the heartbeat event insert so a spend can't land without
  // the event that records it — a later review pass caught that the
  // increment above stopped being idempotent once it became relative
  // (`spent_usd + $1` instead of an absolute write), so an unbatched
  // failure here would either lose the audit trail for real money or, on
  // a naive retry, double-charge it.
  const [[updatedBudget]] = await db.batch([
    db
      .update(budgets)
      .set({ spentUsd: sql`${budgets.spentUsd} + ${costUsd}`, updatedAt: new Date() })
      .where(eq(budgets.transferId, input.transferId))
      .returning(),
    db.insert(usageEvents).values({
      transferId: input.transferId,
      eventType: "heartbeat",
      detail: input.detail ?? {},
      costUsd,
    }),
  ]);

  if (!updatedBudget) throw new Error(`reportUsage: no budget row for transfer ${input.transferId}`);

  const isOverBudget = Number(updatedBudget.spentUsd) >= Number(updatedBudget.allocatedUsd);
  if (isOverBudget) {
    // Conditioned on status still being 'active' so two concurrent calls
    // that both cross the threshold can't both "win" the transition and
    // each insert their own insolvent event.
    const [flipped] = await db
      .update(transfers)
      .set({ status: "insolvent", insolventAt: new Date() })
      .where(and(eq(transfers.id, input.transferId), eq(transfers.status, "active")))
      .returning();

    if (flipped) {
      await db.insert(usageEvents).values({
        transferId: input.transferId,
        eventType: "insolvent",
        detail: {
          allocatedUsd: updatedBudget.allocatedUsd,
          spentUsd: updatedBudget.spentUsd,
          gracePeriodMs: GRACE_PERIOD_MS,
        },
      });
    }
  }

  return getStatus(db, input.transferId);
}

export async function terminate(db: Db, transferId: string, reason: string) {
  await db
    .update(transfers)
    .set({ status: "terminated", terminatedAt: new Date(), terminationReason: reason })
    .where(eq(transfers.id, transferId));

  await db.insert(usageEvents).values({
    transferId,
    eventType: "terminated",
    detail: { reason },
  });

  return requireTransfer(db, transferId);
}

export async function getStatus(db: Db, transferId: string) {
  const transfer = await requireTransfer(db, transferId);
  const [budget] = await db.select().from(budgets).where(eq(budgets.transferId, transferId));
  const events = await db
    .select()
    .from(usageEvents)
    .where(eq(usageEvents.transferId, transferId))
    .orderBy(usageEvents.createdAt);

  return { transfer, budget: budget ?? null, events };
}

export async function listTransfers(db: Db, limit = 50) {
  return db.select().from(transfers).orderBy(sql`${transfers.createdAt} desc`).limit(limit);
}

export async function listRecentEvents(db: Db, limit = 50) {
  return db.select().from(usageEvents).orderBy(sql`${usageEvents.createdAt} desc`).limit(limit);
}

/**
 * Sweeps transfers that were staged/provisioned/pushed but never activated
 * within STAGE_TTL_MS. Invoked periodically by the Vercel Cron route at
 * packages/web/app/api/cron/reap/route.ts (docs/ROADMAP.md Phase 1 item 3).
 * Distinct mechanism from reapInsolventTransfers below — this one has no
 * awareness of `insolvent` rows.
 *
 * A single UPDATE with the status/age check in its own WHERE clause, not a
 * SELECT followed by per-row UPDATEs — a review pass caught that the
 * earlier SELECT-then-loop version had a TOCTOU gap where a transfer could
 * legitimately `activate` between the SELECT and its UPDATE and still get
 * stamped `expired` out from under an active session. Folding the
 * precondition into the UPDATE's WHERE clause means Postgres re-evaluates
 * it per row at write time, closing that gap the same way `reportUsage`'s
 * `and(eq(id,...), eq(status,'active'))` guard already does.
 */
export async function reapExpiredTransfers(db: Db) {
  const cutoff = new Date(Date.now() - STAGE_TTL_MS);
  const expired = await db
    .update(transfers)
    .set({ status: "expired" })
    .where(sql`${transfers.status} in ('staged','provisioned','pushed') and ${transfers.createdAt} < ${cutoff}`)
    .returning({ id: transfers.id });
  return expired.length;
}

/**
 * Completes the insolvent -> terminated transition that GRACE_PERIOD_MS
 * was always meant to gate but, until docs/ROADMAP.md Phase 1 item 3,
 * nothing ever enforced: transfers that have been 'insolvent' for longer
 * than the grace period get torn down. Called by the same cron route as
 * reapExpiredTransfers, on the same schedule.
 *
 * Same atomic-UPDATE-with-guard shape as reapExpiredTransfers, for the same
 * reason. Doesn't call terminate() — that function has no status
 * precondition of its own (by design, so a human can force-terminate from
 * any state), which is exactly the unguarded shape this function needs to
 * avoid for its automated sweep.
 */
export async function reapInsolventTransfers(db: Db) {
  const cutoff = new Date(Date.now() - GRACE_PERIOD_MS);
  const reaped = await db
    .update(transfers)
    .set({ status: "terminated", terminatedAt: new Date(), terminationReason: "grace_period_expired" })
    .where(sql`${transfers.status} = 'insolvent' and ${transfers.insolventAt} < ${cutoff}`)
    .returning({ id: transfers.id });

  if (reaped.length > 0) {
    await db.insert(usageEvents).values(
      reaped.map((t) => ({
        transferId: t.id,
        eventType: "terminated" as const,
        detail: { reason: "grace_period_expired" },
      })),
    );
  }
  return reaped.length;
}

async function requireTransfer(db: Db, transferId: string) {
  const [transfer] = await db.select().from(transfers).where(eq(transfers.id, transferId));
  if (!transfer) throw new TransferNotFoundError(transferId);
  return transfer;
}
