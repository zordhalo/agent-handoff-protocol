import { NextRequest, NextResponse } from "next/server";
import { createDb, reapExpiredTransfers, reapInsolventTransfers } from "@ahp/core";

export const dynamic = "force-dynamic";

/**
 * docs/ROADMAP.md Phase 1 item 3: closes both halves of the reaping gap —
 * transfers stuck pre-activation past their TTL (reapExpiredTransfers) and
 * transfers that went insolvent and were never manually terminated
 * (reapInsolventTransfers, enforcing GRACE_PERIOD_MS). Scheduled by
 * packages/web/vercel.json's `crons` entry.
 *
 * Gated by CRON_SECRET, Vercel's standard pattern for cron routes: Vercel
 * automatically attaches this as a Bearer token on its own invocations, so
 * an arbitrary request without the secret gets rejected.
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 500 });
  }

  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = createDb();
  const [expiredCount, insolventCount] = await Promise.all([reapExpiredTransfers(db), reapInsolventTransfers(db)]);

  return NextResponse.json({ expiredCount, insolventTerminatedCount: insolventCount });
}
