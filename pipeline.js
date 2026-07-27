// pipeline.js | milestone 2
// the factory: demand evidence -> Claude drafts params -> deterministic template
// -> risk policy -> validate -> self-heal (capped) -> simulate -> real self-test tx
// -> publish to marketplace. LLM proposes, system normalizes, KeeperHub executes.

const KH = "https://app.keeperhub.com";
const MAX_HEAL_ATTEMPTS = 2;

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

// Claude only fills PARAMETERS. the node graph itself is a fixed template.
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
// the agent refuses to publish anything outside its autonomous budget.
// this runs in code, not in the LLM, so it cannot be talked out of it.
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
// template-level errors (node types, schema, config shape) are NOT fixable by
// re-drafting parameters. healing them just burns Claude calls against the
// wrong layer. classify first, heal only what healing can reach.
export function classifyFailure(errJson) {
  const text = JSON.stringify(errJson || "").toLowerCase();
  const templateSignals = [
    "node", "edge", "actiontype", "action type", "unknown field", "invalid action",
    "invalid_action_config", "schema", "condition", "sourcehandle", "workflow contains",
  ];
  return templateSignals.some((s) => text.includes(s)) ? "TEMPLATE" : "PARAMETER";
}

// collect every nodeId that appears anywhere in an execution's status/logs,
// so we can verify which graph nodes actually ran vs were silently dropped.
export function collectExecutedNodeIds(obj, found = new Set()) {
  if (!obj || typeof obj !== "object") return found;
  for (const [k, v] of Object.entries(obj)) {
    if ((k === "nodeId" || k === "currentNodeId" || k === "lastSuccessfulNodeId") && typeof v === "string" && v) found.add(v);
    if (typeof v === "object") collectExecutedNodeIds(v, found);
  }
  return found;
}

// ---------- pipeline steps against KeeperHub ----------
// KeeperHub's real create endpoint requires name, nodes, and edges together
// in the initial call (confirmed by the 400 "Name, nodes, and edges are
// required" response) rather than accepting an empty shell to be patched
// afterward. nodes/edges are now required params here.
export async function createWorkflow(name, description, nodes, edges) {
  const r = await kh("/api/workflows/create", "POST", { name, description, nodes, edges });
  const id = r.json?.id || r.json?.workflow?.id || r.json?.data?.id || r.json?.workflowId;
  return { ...r, workflowId: id };
}

export async function patchWorkflow(workflowId, nodes, edges) {
  return kh(`/api/workflows/${workflowId}`, "PATCH", { nodes, edges });
}

// validation: REST path for this is unverified in docs. we try the likely path,
// and if it 404s we fall through, because simulate + execute is itself a
// real validation gate. the raw response is kept either way.
export async function validateWorkflow(workflowId) {
  const r = await kh(`/api/workflows/${workflowId}/validate`, "POST", {});
  if (r.status === 404) return { ok: true, status: 404, json: { note: "no REST validate endpoint found, relying on simulate as the validation gate" }, skipped: true };
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

// publish: discovered via live probe, NOT a separate endpoint. listing is a
// PATCH on the workflow itself with isListed/listedSlug/price, and the API
// requires an inputSchema (json-schema object; {"type":"object"} is valid for
// no-input workflows) — KeeperHub's own 422 error documented this for us.
export async function listWorkflow(workflowId, params, priceUsd) {
  const slug = `${params.workflow_name}-${Date.now().toString(36).slice(-4)}`;
  const body = {
    isListed: true,
    listedSlug: slug,
    price: String(priceUsd),
    inputSchema: { type: "object" },
  };
  const r = await kh(`/api/workflows/${workflowId}`, "PATCH", body);
  return { ...r, requested: body, slug };
}
