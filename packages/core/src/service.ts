import { eq, sql } from "drizzle-orm";
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

export async function snapshotState(db: Db, input: SnapshotStateInput) {
  const [transfer] = await db
    .insert(transfers)
    .values({
      sourceHost: input.sourceHost,
      systemPrompt: input.systemPrompt,
      messageHistory: input.messageHistory,
      toolState: input.toolState,
      mcpConfig: input.mcpConfig,
      status: "staged",
    })
    .returning();

  if (!transfer) throw new Error("snapshotState: insert returned no row");

  await db.insert(usageEvents).values({
    transferId: transfer.id,
    eventType: "snapshot_created",
    detail: { sourceHost: input.sourceHost, messageCount: input.messageHistory.length },
  });

  return transfer;
}

export async function provisionRuntime(db: Db, input: ProvisionRuntimeInput) {
  const transfer = await requireTransfer(db, input.transferId);
  if (transfer.status !== "staged") {
    throw new Error(`provisionRuntime: transfer ${transfer.id} is '${transfer.status}', expected 'staged'`);
  }

  await db
    .update(transfers)
    .set({ status: "provisioned", provisionedAt: new Date(), destinationTier: input.tier })
    .where(eq(transfers.id, transfer.id));

  await db.insert(budgets).values({
    transferId: transfer.id,
    allocatedUsd: input.allocatedUsd.toFixed(6),
    ratePerHourUsd: input.ratePerHourUsd.toFixed(6),
  });

  await db.insert(usageEvents).values({
    transferId: transfer.id,
    eventType: "runtime_provisioned",
    detail: { tier: input.tier, limits: TIER_LIMITS[input.tier as DestinationTier], allocatedUsd: input.allocatedUsd },
  });

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

  const [budget] = await db.select().from(budgets).where(eq(budgets.transferId, input.transferId));
  if (!budget) throw new Error(`reportUsage: no budget row for transfer ${input.transferId}`);

  const newSpent = Number(budget.spentUsd) + input.costUsd;

  await db
    .update(budgets)
    .set({ spentUsd: newSpent.toFixed(6), updatedAt: new Date() })
    .where(eq(budgets.transferId, input.transferId));

  await db.insert(usageEvents).values({
    transferId: input.transferId,
    eventType: "heartbeat",
    detail: input.detail ?? {},
    costUsd: input.costUsd.toFixed(6),
  });

  if (newSpent >= Number(budget.allocatedUsd) && transfer.status === "active") {
    await db.update(transfers).set({ status: "insolvent" }).where(eq(transfers.id, input.transferId));
    await db.insert(usageEvents).values({
      transferId: input.transferId,
      eventType: "insolvent",
      detail: { allocatedUsd: budget.allocatedUsd, spentUsd: newSpent, gracePeriodMs: GRACE_PERIOD_MS },
    });
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
  if (!transfer) throw new Error(`Transfer ${transferId} not found`);
  return transfer;
}
