CREATE TYPE "public"."event_type" AS ENUM('snapshot_created', 'runtime_provisioned', 'state_pushed', 'activated', 'heartbeat', 'insolvent', 'terminated');--> statement-breakpoint
CREATE TYPE "public"."transfer_status" AS ENUM('staged', 'provisioned', 'pushed', 'active', 'insolvent', 'terminated', 'expired');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "budgets" (
	"transfer_id" uuid PRIMARY KEY NOT NULL,
	"allocated_usd" numeric(12, 6) NOT NULL,
	"spent_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"rate_per_hour_usd" numeric(12, 6) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_host" text NOT NULL,
	"destination_tier" text,
	"status" "transfer_status" DEFAULT 'staged' NOT NULL,
	"system_prompt" text NOT NULL,
	"message_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tool_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"mcp_config" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provisioned_at" timestamp with time zone,
	"pushed_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"terminated_at" timestamp with time zone,
	"termination_reason" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transfer_id" uuid NOT NULL,
	"event_type" "event_type" NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "budgets" ADD CONSTRAINT "budgets_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
