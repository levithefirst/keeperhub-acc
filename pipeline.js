// pipeline.js | milestone 2
// the factory: demand evidence -> Claude drafts params -> deterministic template
// -> risk policy -> validate -> self-heal (capped) -> real self-test tx
// -> publish to marketplace. LLM proposes, system normalizes, KeeperHub executes.

import { mcpCallTool } from "./mcp.js";

const KH = "https://app.keeperhub.com";

// ---------- KeeperHub http ----------
export async function kh(path, method = "GET", body = null, apiKey = process.env.KEEPERHUB_API_KEY) {
  const res = await fetch(`${KH}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { nonJsonBody: text.slice(0, 2000) }; }
  return { ok: res.ok, status: res.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function deepFind(obj, keys, found = {}) {
  if (!obj || typeof obj !== "object") return found;
  for (const [k, v] of Object.entries(obj)) {
    if (keys.includes(k) && typeof v === "string" && !found[k]) found[k] = v;
    if (typeof v === "object") deepFind(v, keys, found);
  }
  return found;
}

// ---------- claude (drafting + healing) ----------
async function askClaude(system, user) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1200,
      temperature: 0,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`claude api error: ${JSON.stringify(data).slice(0, 400)}`);
  const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

const DRAFT_SYSTEM = `you are a parameter compiler for one fixed KeeperHub workflow template: a "checked transfer" (check wallet balance, and only if it exceeds a threshold, send a tiny transfer). output RAW JSON ONLY, no markdown, no prose, matching exactly:
{
  "workflow_name": "string, lowercase-hyphens, max 32 chars",
  "listing_title": "string, max 60 chars, plain and useful",
  "listing_description": "string, max 300 chars: what it does, what inputs the caller needs, what the caller should expect. write for a first-time user.",
  "balance_threshold_eth": "string decimal, between 0.0001 and 0.01",
  "transfer_amount_eth": "string decimal, between 0.00005 and 0.001"
}`;

export async function draftParams(need, evidence) {
  return askClaude(
    DRAFT_SYSTEM,
    `normalized need: ${need}\nevidence (raw failed requests): ${JSON.stringify(evidence.slice(0, 10))}\ncompile the parameters now.`
  );
}

export async function healParams(previousParams, errorText) {
  return askClaude(
    DRAFT_SYSTEM,
    `the previous parameters failed downstream. previous: ${JSON.stringify(previousParams)}\nexact error from KeeperHub: ${String(errorText).slice(0, 1500)}\noutput corrected parameters now.`
  );
}

// ---------- deterministic risk policy ----------
const TESTNETS = ["11155111", "84532"];
export function riskCheck(params, network) {
  const rejections = [];
  const amt = parseFloat(params.transfer_amount_eth);
  const thr = parseFloat(params.balance_threshold_eth);
  if (!TESTNETS.includes(String(network))) rejections.push(`network ${network} is not in the testnet allowlist`);
  if (!(amt > 0 && amt <= 0.001)) rejections.push(`transfer amount ${params.transfer_amount_eth} exceeds the 0.001 autonomous cap`);
  if (!(thr > 0 && thr <= 0.01)) rejections.push(`balance threshold ${params.balance_threshold_eth} out of allowed range`);
  if (!/^[a-z0-9-]{3,32}$/.test(params.workflow_name || "")) rejections.push("workflow_name fails naming policy");
  return {
    allowed: rejections.length === 0,
    rejections,
    policy: "read actions + capped testnet transfer only. approvals, arbitrary contract writes, and mainnet are auto-rejected.",
  };
}

// ---------- fixed node template ----------
export function buildNodes(params, network, watchAddress, receiver) {
  const nodes = [
    {
      id: "trigger",
      type: "trigger",
      position: { x: 0, y: 0 },
      data: { label: "Manual Trigger", description: "caller starts the run", type: "trigger", config: { triggerType: "Manual" }, status: "idle" },
    },
    {
      id: "check-balance",
      type: "action",
      position: { x: 0, y: 150 },
      data: {
        label: "Check Balance", description: "read ETH balance before moving anything", type: "action",
        config: { actionType: "web3/check-balance", network: String(network), address: watchAddress }, status: "idle",
      },
    },
    {
      id: "gate",
      type: "action",
      position: { x: 0, y: 300 },
      data: {
        type: "action",
        label: "Balance Gate",
        description: `only proceed if balance > ${params.balance_threshold_eth} ETH`,
        config: {
          actionType: "Condition",
          condition: `{{@check-balance:Check Balance.balance}} > ${parseFloat(params.balance_threshold_eth)}`,
        },
        status: "idle",
      },
    },
    {
      id: "safe-transfer",
      type: "action",
      position: { x: 0, y: 450 },
      data: {
        label: "Safe Transfer", description: `send ${params.transfer_amount_eth} ETH only when the gate passes`, type: "action",
        config: { actionType: "web3/transfer-funds", network: String(network), recipientAddress: receiver, amount: params.transfer_amount_eth }, status: "idle",
      },
    },
  ];
  const edges = [
    { id: "e1", source: "trigger", target: "check-balance" },
    { id: "e2", source: "check-balance", target: "gate" },
    { id: "e3", source: "gate", target: "safe-transfer", sourceHandle: "true" },
  ];
  return { nodes, edges };
}

// ---------- failure classification ----------
export function classifyFailure(errJson) {
  const text = JSON.stringify(errJson || "").toLowerCase();
  const templateSignals = [
    "node", "edge", "actiontype", "action type", "unknown field", "invalid action",
    "invalid_action_config", "schema", "condition", "sourcehandle", "workflow contains",
  ];
  return templateSignals.some((s) => text.includes(s)) ? "TEMPLATE" : "PARAMETER";
}

export function collectExecutedNodeIds(obj, found = new Set()) {
  if (!obj || typeof obj !== "object") return found;
  for (const [k, v] of Object.entries(obj)) {
    if ((k === "nodeId" || k === "currentNodeId" || k === "lastSuccessfulNodeId") && typeof v === "string" && v) found.add(v);
    if (typeof v === "object") collectExecutedNodeIds(v, found);
  }
  return found;
}

// ---------- pipeline steps against KeeperHub ----------
// create requires name, nodes, and edges in the SAME call.
// enabled MUST be passed true: KeeperHub creates workflows DISABLED by default,
// and a disabled workflow 503s every marketplace call even while listed.
export async function createWorkflow(name, description, nodes, edges) {
  const r = await kh("/api/workflows/create", "POST", { name, description, nodes, edges, enabled: true });
  const id = r.json?.id || r.json?.workflow?.id || r.json?.data?.id || r.json?.workflowId;
  return { ...r, workflowId: id };
}

export async function patchWorkflow(workflowId, nodes, edges) {
  return kh(`/api/workflows/${workflowId}`, "PATCH", { nodes, edges });
}

export async function validateWorkflow(workflowId) {
  const r = await kh(`/api/workflows/${workflowId}/validate`, "POST", {});
  if (r.status === 404) return { ok: true, status: 404, json: { note: "no REST validate endpoint found, relying on execute as the validation gate" }, skipped: true };
  return r;
}

export async function executeWorkflow(workflowId) {
  const r = await kh(`/api/workflow/${workflowId}/execute`, "POST", {});
  const executionId = r.json?.executionId || r.json?.id || r.json?.data?.executionId;
  return { ...r, executionId };
}

export async function pollExecution(executionId, tries = 20) {
  let statusBody = null, finalStatus = "unknown";
  for (let i = 0; i < tries; i++) {
    await sleep(3000);
    const st = await kh(`/api/workflows/executions/${executionId}/status`);
    statusBody = st.json;
    finalStatus = st.json?.status || "unknown";
    if (["success", "error", "cancelled", "completed", "failed"].includes(finalStatus)) break;
  }
  const logs = await kh(`/api/workflows/executions/${executionId}/logs`);
  return { finalStatus, statusBody, logs: logs.json };
}

/**
 * PUBLISH — the sequence that actually produces a callable, paid listing.
 *
 * Four separate facts, each of which silently breaks the listing on its own:
 *   1. enabled defaults to false. A disabled workflow 503s every call.
 *   2. list_workflow accepts NO price field. Listing at "no price" returns 200
 *      and executes for free instead of issuing a 402.
 *   3. price lives on update_workflow_listing as priceUsdcPerCall.
 *   4. priceUsdcPerCall must be a STRING, and cannot be set while listed.
 *
 * So: enable -> unlist (if listed) -> set string price -> list -> verify.
 * Every step is a KeeperHub MCP tool call, and the result is verified by
 * reading the public listing back rather than trusting the write responses.
 */
export async function publishWorkflow({ workflowId, params, priceUsd, apiKey = process.env.KEEPERHUB_API_KEY } = {}) {
  const id = String(workflowId);
  const slug = `${params.workflow_name}-${Date.now().toString(36).slice(-4)}`;
  const price = String(priceUsd);
  const steps = [];

  const step = async (label, tool, args) => {
    const r = await mcpCallTool({ tool, args, apiKey });
    steps.push({ label, tool, args, ok: r.ok, error: r.ok ? null : (r.text?.[0] || r.rpc_error) });
    return r;
  };

  // 1. enable
  const enabled = await step("enable", "update_workflow", { workflowId: id, enabled: true });

  // 2. unlist first if it is already listed, because price is immutable while listed
  const current = enabled.parsed || (await step("read", "get_workflow", { workflowId: id })).parsed;
  if (current?.isListed) await step("unlist", "unlist_workflow", { workflowId: id });

  // 3. price, as a STRING
  const priced = await step("set_price", "update_workflow_listing", { workflowId: id, priceUsdcPerCall: price });

  // 4. list
  const listed = await step("list", "list_workflow", {
    workflowId: id,
    slug,
    inputSchema: { type: "object" },
  });

  const finalSlug = listed.parsed?.listedSlug || slug;

  // 5. verify against the PUBLIC listing, not the write response
  const check = await step("verify", "get_workflow_listing", { slug: finalSlug });
  const v = check.parsed || {};
  const priceOk = v.priceUsdcPerCall === price;
  const listedOk = v.isListed === true;
  const enabledOk = (enabled.parsed?.enabled ?? listed.parsed?.enabled) === true;

  return {
    ok: priceOk && listedOk && enabledOk,
    slug: finalSlug,
    requested: { enabled: true, priceUsdcPerCall: price, isListed: true },
    verified: {
      enabled: enabledOk,
      isListed: listedOk,
      priceUsdcPerCall: v.priceUsdcPerCall ?? null,
      priceMatches: priceOk,
    },
    summary: {
      slug: finalSlug,
      enable_ok: enabled.ok,
      price_ok: priced.ok,
      list_ok: listed.ok,
      verified_price: v.priceUsdcPerCall ?? null,
      verified_listed: v.isListed ?? null,
    },
    steps,
    listing: v,
  };
}

// kept as a thin alias so nothing that imports the old name breaks
export const listWorkflow = (workflowId, params, priceUsd) =>
  publishWorkflow({ workflowId, params, priceUsd });
