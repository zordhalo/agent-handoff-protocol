import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  numeric,
  pgEnum,
} from "drizzle-orm/pg-core";

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

export const eventType = pgEnum("event_type", [
  "snapshot_created",
  "runtime_provisioned",
  "state_pushed",
  "activated",
  "heartbeat",
  "insolvent",
  "terminated",
]);

export const transfers = pgTable("transfers", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceHost: text("source_host").notNull(),
  destinationTier: text("destination_tier"),
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
