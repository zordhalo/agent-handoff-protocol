CREATE TABLE IF NOT EXISTS "used_transfer_tokens" (
	"nonce" uuid PRIMARY KEY NOT NULL,
	"transfer_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "snapshot_checksum" text;--> statement-breakpoint
UPDATE "transfers" SET "snapshot_checksum" = 'unbackfilled-pre-checksum-row' WHERE "snapshot_checksum" IS NULL;--> statement-breakpoint
ALTER TABLE "transfers" ALTER COLUMN "snapshot_checksum" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "insolvent_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "used_transfer_tokens" ADD CONSTRAINT "used_transfer_tokens_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
