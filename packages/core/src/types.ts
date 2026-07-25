/** A vault reference, never a raw secret. See docs/DESIGN.md §4 (Security boundaries). */
export interface McpCredentialRef {
  server: string;
  credRef: string;
}

export interface SnapshotStateInput {
  sourceHost: string;
  systemPrompt: string;
  messageHistory: Array<{ role: string; content: string }>;
  toolState: Record<string, unknown>;
  mcpConfig: McpCredentialRef[];
}

// DESTINATION_TIERS lives in schema.ts (see the comment there for why) and
// is re-exported from here so the rest of the package/consumers can import
// either the type or the values from one place. The pgEnum in schema.ts,
// the Zod schema in packages/mcp-server, and TIER_LIMITS below all derive
// from that single array instead of re-typing the literals independently,
// which a review pass flagged as a real drift risk.
import { DESTINATION_TIERS } from "./schema.js";
export { DESTINATION_TIERS };
export type DestinationTier = (typeof DESTINATION_TIERS)[number];

export interface ProvisionRuntimeInput {
  transferId: string;
  tier: DestinationTier;
  allocatedUsd: number;
  ratePerHourUsd: number;
  /** Minted by the orchestrator via issueTransferToken — never by the source loop. See auth.ts. */
  token: string;
}

export interface ReportUsageInput {
  transferId: string;
  costUsd: number;
  detail?: Record<string, unknown>;
}

export const TIER_LIMITS: Record<DestinationTier, { cpuCores: number; memoryMb: number; egressMbps: number }> = {
  "sandbox-small": { cpuCores: 1, memoryMb: 512, egressMbps: 10 },
  "sandbox-medium": { cpuCores: 2, memoryMb: 2048, egressMbps: 50 },
  "sandbox-large": { cpuCores: 4, memoryMb: 8192, egressMbps: 100 },
};
