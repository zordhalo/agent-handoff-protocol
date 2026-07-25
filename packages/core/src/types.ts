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

export type DestinationTier = "sandbox-small" | "sandbox-medium" | "sandbox-large";

export interface ProvisionRuntimeInput {
  transferId: string;
  tier: DestinationTier;
  allocatedUsd: number;
  ratePerHourUsd: number;
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
