import { createHmac, timingSafeEqual } from "node:crypto";
import type { Db } from "./client.js";
import { usedTransferTokens } from "./schema.js";

/**
 * Transfer-authorization tokens, gating `provisionRuntime` and `activate`
 * per docs/ROADMAP.md Phase 1 item 4.
 *
 * Non-negotiable, carried over from docs/DESIGN.md §6: these tokens are
 * minted by the human/orchestrator control plane only. There is no MCP
 * tool that issues one — `issueTransferToken` is a plain function in this
 * package, callable from the demo script or a protected API route, never
 * from anything the source loop (the agent) can reach on its own. If a
 * token ever needs to flow through the agent to reach the destination
 * that's fine (it's just a bearer credential at that point), but the
 * *minting* must never be reachable via a path that originates from model
 * output.
 */

export type TransferTokenScope = "provision_runtime" | "activate";

export interface TransferTokenPayload {
  transferId: string;
  scope: TransferTokenScope;
  nonce: string;
  exp: number;
}

const DEFAULT_TTL_MS = 5 * 60_000;

export function getTransferTokenSecret(): string {
  const secret = process.env.TRANSFER_TOKEN_SECRET;
  if (!secret) {
    throw new Error(
      "TRANSFER_TOKEN_SECRET is not set. It gates provision_runtime/activate — " +
        "see README.md → 'Auth setup'.",
    );
  }
  return secret;
}

export function issueTransferToken(
  transferId: string,
  scope: TransferTokenScope,
  secret: string,
  ttlMs = DEFAULT_TTL_MS,
): string {
  const payload: TransferTokenPayload = {
    transferId,
    scope,
    nonce: crypto.randomUUID(),
    exp: Date.now() + ttlMs,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = sign(body, secret);
  return `${body}.${sig}`;
}

/** Verifies signature and expiry only — does not check or record
 * single-use. Callers should use `consumeTransferToken` instead, which
 * does both; this is exported mainly for the test suite. */
export function decodeTransferToken(token: string, secret: string): TransferTokenPayload {
  const [body, sig] = token.split(".");
  if (!body || !sig) throw new Error("malformed transfer token");

  const expected = sign(body, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("invalid transfer token signature");
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as TransferTokenPayload;
  if (Date.now() > payload.exp) throw new Error("transfer token expired");
  return payload;
}

/**
 * Verifies the token matches the expected transfer/scope, then atomically
 * records its nonce as used. The nonce insert's primary-key collision is
 * what makes a replay attempt fail — there's no separate
 * check-then-record step for an attacker to race.
 */
export async function consumeTransferToken(
  db: Db,
  token: string,
  transferId: string,
  scope: TransferTokenScope,
  secret: string,
): Promise<void> {
  const payload = decodeTransferToken(token, secret);
  if (payload.transferId !== transferId || payload.scope !== scope) {
    throw new Error(`transfer token is not valid for ${scope} on transfer ${transferId}`);
  }

  try {
    await db.insert(usedTransferTokens).values({
      nonce: payload.nonce,
      transferId,
      scope,
    });
  } catch (err) {
    // Postgres unique_violation on the nonce primary key means this exact
    // token was already consumed once.
    throw new Error(`transfer token already used: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}
