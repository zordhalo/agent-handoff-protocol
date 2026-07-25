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

const GRACE_PERIOD_MS = 60_000;
const STAGE_TTL_MS = 30 * 60_000;

/** Thrown by requireTransfer when a transfer id doesn't exist — distinct
 * from any other failure (network, connection, etc.) so callers can tell
 * "not found" apart from "couldn't reach the database." */
export class TransferNotFoundError extends Error {
  constructor(transferId: string) {
    super(`Transfer ${transferId} not found`);
    this.name = "TransferNotFoundError";
  }
}

export async function snapshotState(db: Db, input: SnapshotStateInput) {
  // Generated client-side so the transfer row and its audit event can be
  // written atomically in one batch (see provisionRuntime for why this
  // matters: a torn write between the two here would leave a transfer with
  // no snapshot_created event, harmless, but the pattern should be
  // consistent everywhere it's cheap to make it so).
  const id = crypto.randomUUID();

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

export async function provisionRuntime(db: Db, input: ProvisionRuntimeInput) {
  const transfer = await requireTransfer(db, input.transferId);
  if (transfer.status !== "staged") {
    throw new Error(`provisionRuntime: transfer ${transfer.id} is '${transfer.status}', expected 'staged'`);
  }

  // Atomic: if any of these three writes fails, none of them land, and the
  // transfer stays cleanly at 'staged' for a safe retry. Without this, a
  // failure between the status update and the budget insert would wedge
  // the transfer at 'provisioned' with no budget row and no way back to
  // 'staged' (provisionRuntime's own precondition above forbids it).
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

export async function pushState(db: Db, transferId: string) {
  const transfer = await requireTransfer(db, transferId);
  if (transfer.status !== "provisioned") {
    throw new Error(`pushState: transfer ${transfer.id} is '${transfer.status}', expected 'provisioned'`);
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
 * step").
 */
export async function activate(db: Db, transferId: string) {
  const transfer = await requireTransfer(db, transferId);
  if (transfer.status !== "pushed") {
    throw new Error(`activate: transfer ${transfer.id} is '${transfer.status}', expected 'pushed'`);
  }

  await db.update(transfers).set({ status: "active", activatedAt: new Date() }).where(eq(transfers.id, transferId));

  await db.insert(usageEvents).values({
    transferId,
    eventType: "activated",
    detail: {},
  });

  return requireTransfer(db, transferId);
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
      .set({ status: "insolvent" })
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
 * within STAGE_TTL_MS. Meant to be invoked periodically (e.g. Vercel Cron)
 * — not wired to a cron job in this showcase, but the logic is real.
 */
export async function reapExpiredTransfers(db: Db) {
  const cutoff = new Date(Date.now() - STAGE_TTL_MS);
  const stale = await db
    .select()
    .from(transfers)
    .where(sql`${transfers.status} in ('staged','provisioned','pushed') and ${transfers.createdAt} < ${cutoff}`);

  for (const transfer of stale) {
    await db.update(transfers).set({ status: "expired" }).where(eq(transfers.id, transfer.id));
  }
  return stale.length;
}

async function requireTransfer(db: Db, transferId: string) {
  const [transfer] = await db.select().from(transfers).where(eq(transfers.id, transferId));
  if (!transfer) throw new TransferNotFoundError(transferId);
  return transfer;
}
