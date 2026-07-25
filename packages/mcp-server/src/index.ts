#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createDb,
  snapshotState,
  provisionRuntime,
  pushState,
  activate,
  reportUsage,
  getStatus,
  DESTINATION_TIERS,
  getTransferTokenSecret,
} from "@ahp/core";

/**
 * Transfer MCP server — the tool surface an agent (or its orchestrator)
 * calls to move a running session's state to a different compute host.
 *
 * Deliberately absent: any tool resembling "choose_to_transfer" or
 * "consent". Whether a transfer happens is a decision made by whoever
 * calls provision_runtime/activate — a human, a script, a scheduler — never
 * something inferred from model output. See docs/DESIGN.md §2.
 *
 * Also absent, deliberately: no tool here mints a transfer-auth token.
 * `provision_runtime` and `activate` both require one (docs/ROADMAP.md
 * Phase 1 item 4), but issuance (`issueTransferToken`, exported from
 * @ahp/core) is a plain function for an orchestrator to call directly —
 * never exposed as something this MCP server, and therefore the agent
 * connected to it, can invoke.
 */

const db = createDb();
const tokenSecret = getTransferTokenSecret();
const server = new McpServer({ name: "agent-handoff-protocol", version: "0.1.0" });

const messageSchema = z.object({ role: z.string(), content: z.string() });
const mcpConfigSchema = z.object({ server: z.string(), credRef: z.string() });
// Derived from @ahp/core's DESTINATION_TIERS rather than re-typed here, so
// this can't silently drift from the tier set the service layer enforces.
const tierSchema = z.enum(DESTINATION_TIERS);

server.tool(
  "snapshot_state",
  "Serialize the calling agent's current context (system prompt, message history, tool state, and MCP credential references — never raw secrets) into a transferable snapshot. Returns a transfer_id.",
  {
    sourceHost: z.string().describe("Identifier of the host currently running the agent"),
    systemPrompt: z.string(),
    messageHistory: z.array(messageSchema),
    toolState: z.record(z.unknown()).default({}),
    mcpConfig: z.array(mcpConfigSchema).default([]),
  },
  async (input) => {
    const transfer = await snapshotState(db, input);
    return textResult({ transfer_id: transfer.id, status: transfer.status });
  },
);

server.tool(
  "provision_runtime",
  "Request a sandboxed destination runtime sized to `tier`, with a fixed compute budget. Does not move any state yet. Requires a transfer-authorization token minted out-of-band by the orchestrator (this server has no tool to mint one).",
  {
    transferId: z.string().uuid(),
    tier: tierSchema,
    allocatedUsd: z.number().positive(),
    ratePerHourUsd: z.number().positive(),
    token: z.string().describe("Transfer-authorization token for scope 'provision_runtime', minted by the orchestrator"),
  },
  async (input) => {
    const transfer = await provisionRuntime(db, input, tokenSecret);
    return textResult({ transfer_id: transfer.id, status: transfer.status, tier: transfer.destinationTier });
  },
);

server.tool(
  "push_state",
  "Upload the previously created snapshot to the provisioned destination's staging area. If expectedChecksum is provided, it's verified against the checksum snapshot_state computed and stored.",
  {
    transferId: z.string().uuid(),
    expectedChecksum: z.string().optional(),
  },
  async ({ transferId, expectedChecksum }) => {
    const transfer = await pushState(db, transferId, expectedChecksum);
    return textResult({ transfer_id: transfer.id, status: transfer.status });
  },
);

server.tool(
  "activate",
  "Boot the destination runtime from the staged snapshot. This is the only irreversible step in the protocol — the caller must confirm success here before terminating the source loop. Requires a transfer-authorization token minted out-of-band by the orchestrator, scoped to 'activate'.",
  {
    transferId: z.string().uuid(),
    token: z.string().describe("Transfer-authorization token for scope 'activate', minted by the orchestrator"),
  },
  async ({ transferId, token }) => {
    const transfer = await activate(db, transferId, token, tokenSecret);
    return textResult({ transfer_id: transfer.id, status: transfer.status, activatedAt: transfer.activatedAt });
  },
);

server.tool(
  "report_usage",
  "Report metered compute/token spend against a transfer's budget. Called by the destination runtime's metering daemon, not by the agent itself. Flips the transfer to 'insolvent' once spend reaches the allocated budget.",
  {
    transferId: z.string().uuid(),
    costUsd: z.number().nonnegative(),
    detail: z.record(z.unknown()).optional(),
  },
  async (input) => {
    const status = await reportUsage(db, input);
    return textResult({
      transfer_id: input.transferId,
      status: status.transfer.status,
      spentUsd: status.budget?.spentUsd,
      allocatedUsd: status.budget?.allocatedUsd,
    });
  },
);

server.tool(
  "get_status",
  "Fetch the full lifecycle state of a transfer: its record, budget, and ordered event log.",
  { transferId: z.string().uuid() },
  async ({ transferId }) => {
    const status = await getStatus(db, transferId);
    return textResult(status);
  },
);

function textResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

const transport = new StdioServerTransport();
await server.connect(transport);
