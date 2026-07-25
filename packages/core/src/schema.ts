import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  numeric,
  pgEnum,
} from "drizzle-orm/pg-core";

// Single source of truth for the tier set, defined here (rather than
// imported from ./types.ts) because drizzle-kit's config loader compiles
// this file standalone and doesn't resolve same-package relative imports
// the way a normal TS build does. types.ts imports DestinationTier back
// from this file instead.
export const DESTINATION_TIERS = ["sandbox-small", "sandbox-medium", "sandbox-large"] as const;

/**
 * Lifecycle of a single handoff. "insolvent" is a distinct state from
 * "terminated": it marks the grace window after budget exhaustion, before
 * the metering daemon actually tears the runtime down.
 */
export const transferStatus = pgEnum("transfer_status", [
  "staged",
  "provisioned",
  "pushed",
  "active",
  "insolvent",
  "terminated",
  "expired",
]);
export type TransferStatus = (typeof transferStatus.enumValues)[number];

export const eventType = pgEnum("event_type", [
  "snapshot_created",
  "runtime_provisioned",
  "state_pushed",
  "activated",
  "heartbeat",
  "insolvent",
  "terminated",
]);

// Kept as a pgEnum (rather than the plain `text` it was before) so
// Postgres itself rejects an invalid tier, matching how `status` is
// already enforced at the DB level, not just in application code.
export const destinationTier = pgEnum("destination_tier", DESTINATION_TIERS);

export const transfers = pgTable("transfers", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceHost: text("source_host").notNull(),
  destinationTier: destinationTier("destination_tier"),
  status: transferStatus("status").notNull().default("staged"),

  // Serialized agent state. Credentials are never stored here directly —
  // mcpConfig holds vault references only. See docs/DESIGN.md ("State
  // serialization format") for the schema this is expected to follow.
  systemPrompt: text("system_prompt").notNull(),
  messageHistory: jsonb("message_history").notNull().default([]),
  toolState: jsonb("tool_state").notNull().default({}),
  mcpConfig: jsonb("mcp_config").notNull().default([]),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  provisionedAt: timestamp("provisioned_at", { withTimezone: true }),
  pushedAt: timestamp("pushed_at", { withTimezone: true }),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  terminatedAt: timestamp("terminated_at", { withTimezone: true }),
  terminationReason: text("termination_reason"),
});

export const budgets = pgTable("budgets", {
  transferId: uuid("transfer_id")
    .primaryKey()
    .references(() => transfers.id, { onDelete: "cascade" }),
  allocatedUsd: numeric("allocated_usd", { precision: 12, scale: 6 }).notNull(),
  spentUsd: numeric("spent_usd", { precision: 12, scale: 6 }).notNull().default("0"),
  ratePerHourUsd: numeric("rate_per_hour_usd", { precision: 12, scale: 6 }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const usageEvents = pgTable("usage_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  transferId: uuid("transfer_id")
    .notNull()
    .references(() => transfers.id, { onDelete: "cascade" }),
  eventType: eventType("event_type").notNull(),
  detail: jsonb("detail").notNull().default({}),
  costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
