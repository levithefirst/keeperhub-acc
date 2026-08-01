// keeper-agent | milestone 2
// core:      /health /run/pipeline-test /run/transfer /runs
// ledger:    /ledger /ledger/log /ledger/seed
// factory:   /run/factory /provenance/:id
// x402:      /x402/sweep /x402/probe /x402/pay /run/buyer
// mcp:       /mcp/init /mcp/tools /mcp/call /mcp/enable
// survey:    /survey /survey/slugs   (only if survey.js is present)
// status:    /status
// demo:      /demo
// landing:   /landing
// glass box: /

import express from "express";
import { createClient } from "@supabase/supabase-js";
import {
  kh, deepFind, draftParams, healParams, riskCheck, buildNodes, classifyFailure, collectExecutedNodeIds,
  createWorkflow, patchWorkflow, validateWorkflow, executeWorkflow, pollExecution, publishWorkflow,
} from "./pipeline.js";
import { paidCall, probeChallenge, mountBuyerRoutes } from "./buyer.js";
import { mountMcpRoutes } from "./mcp.js";
import { mountDemoRoute } from "./demo.js";
import { mountHealthRoutes } from "./health.js";
import { mountLandingRoute } from "./landing.js";

const {
  KEEPERHUB_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RUN_SECRET,
  TEST_ADDRESS, RECEIVER_ADDRESS, TEST_NETWORK = "11155111",
  ANTHROPIC_API_KEY, BUYER_PRIVATE_KEY,
  WORKFLOW_PRICE_USD = "0.05",
  DEMAND_THRESHOLD = "3",
  PORT = 3000,
} = process.env;

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) : null;
const app = express();

function guard(req, res) {
  if (!RUN_SECRET || req.query.secret !== RUN_SECRET) {
    res.status(401).json({ error: "missing or wrong ?secret=" });
    return false;
  }
  return true;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function logRun(fields) {
  if (!supabase) return null;
  const { data } = await supabase.from("runs").insert(fields).select().single();
  return data;
}
async function updateRun(id, fields) {
  if (supabase && id) await supabase.from("runs").update(fields).eq("id", id);
}

// ============================================================
// milestone 1
// ============================================================
app.get("/health", (req, res) => {
  res.json({
    ok: true, service: "keeper-agent milestone 2",
    env: {
      KEEPERHUB_API_KEY: KEEPERHUB_API_KEY ? "set" : "MISSING",
      SUPABASE_URL: SUPABASE_URL ? "set" : "MISSING",
      SUPABASE_SERVICE_ROLE_KEY: SUPABASE_SERVICE_ROLE_KEY ? "set" : "MISSING",
      RUN_SECRET: RUN_SECRET ? "set" : "MISSING",
      TEST_ADDRESS: TEST_ADDRESS ? "set" : "MISSING",
      RECEIVER_ADDRESS: RECEIVER_ADDRESS ? "set" : "MISSING",
      ANTHROPIC_API_KEY: ANTHROPIC_API_KEY ? "set" : "MISSING (needed for /run/factory)",
      BUYER_PRIVATE_KEY: BUYER_PRIVATE_KEY ? "set" : "MISSING (needed for /x402/pay)",
      TEST_NETWORK, WORKFLOW_PRICE_USD, DEMAND_THRESHOLD,
    },
  });
});

app.get("/run/pipeline-test", async (req, res) => {
  if (!guard(req, res)) return;
  const trace = [];
  const run = await logRun({ kind: "pipeline_test", status: "started", request: { TEST_ADDRESS, TEST_NETWORK } });
  try {
    const nodes = [
      { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: { label: "Manual Trigger", type: "trigger", config: { triggerType: "Manual" }, status: "idle" } },
      { id: "check-balance", type: "action", position: { x: 0, y: 160 }, data: { label: "Check Balance", type: "action", config: { actionType: "web3/check-balance", network: TEST_NETWORK, address: TEST_ADDRESS }, status: "idle" } },
    ];
    const edges = [{ id: "e1", source: "trigger", target: "check-balance" }];
    const created = await createWorkflow(`pipeline-test-${Date.now()}`, "read-only balance check to prove the loop", nodes, edges);
    trace.push({ step: "create_workflow", status: created.status, body: created.json });
    if (!created.ok || !created.workflowId) throw new Error(`create_workflow failed (${created.status})`);
    const executed = await executeWorkflow(created.workflowId);
    trace.push({ step: "execute", status: executed.status, body: executed.json });
    if (!executed.ok || !executed.executionId) throw new Error(`execute failed (${executed.status})`);
    const result = await pollExecution(executed.executionId);
    trace.push({ step: "result", finalStatus: result.finalStatus, status: result.statusBody, logs: result.logs });
    const ok = ["success", "completed"].includes(result.finalStatus);
    await updateRun(run?.id, { status: ok ? "success" : "error", keeperhub_workflow_id: String(created.workflowId), keeperhub_execution_id: String(executed.executionId), response: trace, error: ok ? null : `final status: ${result.finalStatus}` });
    res.json({ milestone: "pipeline_test", result: ok ? "SUCCESS" : "NOT SUCCESSFUL", finalStatus: result.finalStatus, workflowId: created.workflowId, executionId: executed.executionId, trace });
  } catch (err) {
    await updateRun(run?.id, { status: "error", response: trace, error: err.message });
    res.status(500).json({ milestone: "pipeline_test", result: "ERROR", error: err.message, trace });
  }
});

app.get("/run/transfer", async (req, res) => {
  if (!guard(req, res)) return;
  const mode = req.query.mode === "live" ? "live" : "simulate";
  const kind = mode === "live" ? "transfer_live" : "transfer_simulate";
  const trace = [];
  const body = { network: TEST_NETWORK, to: RECEIVER_ADDRESS, amount: "0.0001", simulate: mode === "simulate" };
  const run = await logRun({ kind, status: "started", request: body });
  try {
    if (!RECEIVER_ADDRESS) throw new Error("RECEIVER_ADDRESS env var is not set");
    const started = await kh("/api/execute/transfer", "POST", body);
    trace.push({ step: "execute_transfer", status: started.status, body: started.json });
    if (!started.ok) throw new Error(`execute_transfer failed (${started.status})`);
    const executionId = started.json?.executionId || started.json?.id;
    if (!executionId) throw new Error("no executionId in transfer response, see trace");
    let statusBody = null, finalStatus = "unknown";
    for (let i = 0; i < 20; i++) {
      await sleep(3000);
      const st = await kh(`/api/execute/${executionId}/status`);
      statusBody = st.json;
      finalStatus = st.json?.status || "unknown";
      if (["completed", "failed", "success", "error"].includes(finalStatus)) break;
    }
    trace.push({ step: "final_status", body: statusBody });
    const found = deepFind(statusBody, ["transactionHash", "transactionLink", "txHash", "gasEstimate", "wouldRevert", "revertReason"]);
    const ok = ["completed", "success"].includes(finalStatus);
    await updateRun(run?.id, { status: ok ? "success" : "error", keeperhub_execution_id: String(executionId), tx_hash: found.transactionHash || found.txHash || null, tx_link: found.transactionLink || null, response: trace, error: ok ? null : `final status: ${finalStatus}` });
    res.json({ milestone: kind, result: ok ? "SUCCESS" : "NOT SUCCESSFUL", finalStatus, executionId, transactionHash: found.transactionHash || found.txHash || null, transactionLink: found.transactionLink || null, trace });
  } catch (err) {
    await updateRun(run?.id, { status: "error", response: trace, error: err.message });
    res.status(500).json({ milestone: kind, result: "ERROR", error: err.message, trace });
  }
});

app.get("/runs", async (req, res) => {
  if (!guard(req, res)) return;
  if (!supabase) return res.json({ error: "supabase not configured" });
  const { data, error } = await supabase.from("runs").select("id, created_at, kind, status, tx_hash, tx_link, error").order("created_at", { ascending: false }).limit(20);
  res.json(error ? { error: error.message } : data);
});

// ============================================================
// demand ledger
// ============================================================
app.get("/ledger/log", async (req, res) => {
  if (!guard(req, res)) return;
  const { raw, need, reason } = req.query;
  if (!raw || !need) return res.status(400).json({ error: "need ?raw= and ?need=" });
  const { data, error } = await supabase.from("demand_events").insert({ raw_request: raw, normalized_need: need, failure_reason: reason || null, source: "live" }).select().single();
  res.json(error ? { error: error.message } : data);
});

app.get("/ledger/seed", async (req, res) => {
  if (!guard(req, res)) return;
  const seeds = [
    { raw_request: "send 0.0005 eth to my cold wallet but only if my hot wallet still has enough", normalized_need: "checked-transfer", failure_reason: "no workflow existed for balance-gated transfer", source: "seeded" },
    { raw_request: "auto top-up my gas wallet when the main one has spare balance", normalized_need: "checked-transfer", failure_reason: "no workflow existed for balance-gated transfer", source: "seeded" },
    { raw_request: "move a tiny amount to the ops wallet if balance is above threshold", normalized_need: "checked-transfer", failure_reason: "no workflow existed for balance-gated transfer", source: "seeded" },
  ];
  const { data, error } = await supabase.from("demand_events").insert(seeds).select();
  res.json(error ? { error: error.message } : { seeded: data.length, note: "labeled source='seeded', shown honestly as demo evidence", data });
});

app.get("/ledger", async (req, res) => {
  if (!guard(req, res)) return;
  const { data, error } = await supabase.from("demand_events").select("*").order("created_at", { ascending: false }).limit(100);
  if (error) return res.json({ error: error.message });
  const grouped = {};
  for (const e of data) {
    grouped[e.normalized_need] = grouped[e.normalized_need] || { count: 0, unconsumed: 0, events: [] };
    grouped[e.normalized_need].count++;
    if (!e.consumed_by) grouped[e.normalized_need].unconsumed++;
    grouped[e.normalized_need].events.push(e);
  }
  res.json({ threshold: Number(DEMAND_THRESHOLD), grouped });
});

// ============================================================
// THE FACTORY
// ============================================================
app.get("/run/factory", async (req, res) => {
  if (!guard(req, res)) return;
  const trace = [];
  let prov = null;
  const healLog = [];

  try {
    const { data: events } = await supabase.from("demand_events").select("*").is("consumed_by", null).eq("normalized_need", "checked-transfer");
    if (!events || events.length < Number(DEMAND_THRESHOLD)) {
      return res.status(412).json({
        result: "NO BUILD",
        reason: `evidence gate not met: ${events?.length || 0}/${DEMAND_THRESHOLD} unconsumed demand events. the agent refuses to invent demand.`,
      });
    }
    const { data: provRow } = await supabase.from("provenance").insert({
      normalized_need: "checked-transfer",
      demand_event_ids: events.map((e) => e.id),
      status: "started",
    }).select().single();
    prov = provRow;
    trace.push({ step: "evidence_gate", passed: true, eventCount: events.length });

    let params = await draftParams("checked-transfer", events.map((e) => e.raw_request));
    trace.push({ step: "draft", params });
    await supabase.from("provenance").update({ status: "generated", trace }).eq("id", prov.id);

    let verdict = riskCheck(params, TEST_NETWORK);
    if (!verdict.allowed) {
      params = await healParams(params, `risk policy rejected: ${verdict.rejections.join("; ")}`);
      healLog.push({ stage: "risk", error: verdict.rejections, patched: params });
      verdict = riskCheck(params, TEST_NETWORK);
      if (!verdict.allowed) {
        await supabase.from("provenance").update({ status: "failed", risk_verdict: verdict, heal_attempts: healLog.length, heal_log: healLog, trace, error: "risk policy rejection, publication refused" }).eq("id", prov.id);
        return res.status(403).json({ result: "REFUSED BY RISK POLICY", verdict, trace });
      }
    }
    trace.push({ step: "risk_check", verdict });
    await supabase.from("provenance").update({ status: "risk_checked", risk_verdict: verdict }).eq("id", prov.id);

    let workflowId = null;
    for (let attempt = 0; attempt <= 2; attempt++) {
      const { nodes, edges } = buildNodes(params, TEST_NETWORK, TEST_ADDRESS, RECEIVER_ADDRESS);
      const created = await createWorkflow(params.workflow_name + "-" + Date.now().toString(36), params.listing_description.slice(0, 140), nodes, edges);
      trace.push({ step: "create_workflow", attempt, status: created.status, enabled_requested: true, body: created.json });
      if (created.ok && created.workflowId) { workflowId = created.workflowId; break; }

      const failureClass = classifyFailure(created.json);
      trace.push({ step: "failure_classification", attempt, class: failureClass });
      if (failureClass === "TEMPLATE") {
        healLog.push({ stage: "create", classification: "TEMPLATE", fixable: false, error: created.json });
        throw new Error("KH-TEMPLATE-MISMATCH: template-level rejection, healing skipped by design");
      }
      if (healLog.length >= 2) break;
      params = await healParams(params, JSON.stringify(created.json));
      healLog.push({ stage: "create", classification: "PARAMETER", fixable: true, error: created.json, patched: params });
      const reVerdict = riskCheck(params, TEST_NETWORK);
      trace.push({ step: "risk_recheck_after_heal", attempt, verdict: reVerdict });
      if (!reVerdict.allowed) {
        await supabase.from("provenance").update({ status: "failed", risk_verdict: reVerdict, heal_attempts: healLog.length, heal_log: healLog, trace, error: "healed parameters rejected by risk policy" }).eq("id", prov.id);
        return res.status(403).json({ result: "REFUSED BY RISK POLICY (post-heal)", verdict: reVerdict, trace });
      }
    }
    if (!workflowId) throw new Error("create failed after capped heal attempts, see trace");

    const validated = await validateWorkflow(workflowId);
    trace.push({ step: "validate", status: validated.status, body: validated.json, skipped: !!validated.skipped });
    if (!validated.ok && !validated.skipped) {
      if (healLog.length < 2) {
        params = await healParams(params, JSON.stringify(validated.json));
        healLog.push({ stage: "validate", error: validated.json, patched: params });
        const { nodes, edges } = buildNodes(params, TEST_NETWORK, TEST_ADDRESS, RECEIVER_ADDRESS);
        const repatch = await patchWorkflow(workflowId, nodes, edges);
        trace.push({ step: "repatch_after_validate", status: repatch.status, body: repatch.json });
      } else {
        throw new Error("validation failed and heal budget exhausted");
      }
    }
    await supabase.from("provenance").update({ status: "validated", workflow_id: String(workflowId), heal_attempts: healLog.length, heal_log: healLog, trace }).eq("id", prov.id);

    const executed = await executeWorkflow(workflowId);
    trace.push({ step: "self_test_execute", status: executed.status, body: executed.json });
    if (!executed.ok || !executed.executionId) throw new Error("self-test execute failed, see trace");
    const result = await pollExecution(executed.executionId);
    trace.push({ step: "self_test_result", finalStatus: result.finalStatus, logs: result.logs });
    const found = deepFind({ s: result.statusBody, l: result.logs }, ["transactionHash", "transactionLink", "txHash"]);
    const selfTestOk = ["success", "completed"].includes(result.finalStatus);

    const { nodes: builtNodes } = buildNodes(params, TEST_NETWORK, TEST_ADDRESS, RECEIVER_ADDRESS);
    const expectedIds = builtNodes.map((n) => n.id);
    const executedIds = [...collectExecutedNodeIds({ s: result.statusBody, l: result.logs })];
    const missing = expectedIds.filter((id) => !executedIds.includes(id));
    const transferRan = executedIds.includes("safe-transfer");
    const integrity = {
      expectedNodes: expectedIds,
      executedNodes: executedIds,
      missingNodes: missing,
      transferExecuted: transferRan,
      pass: missing.length === 0 && transferRan,
      note: missing.length > 0
        ? "graph nodes were silently dropped from execution; refusing to publish"
        : (!transferRan ? "gate evaluated false or transfer skipped; refusing to publish" : "all nodes executed, transfer confirmed"),
    };
    trace.push({ step: "integrity_check", integrity });

    await supabase.from("provenance").update({
      status: selfTestOk && integrity.pass ? "self_tested" : "failed",
      selftest_execution_id: String(executed.executionId),
      selftest_tx_hash: found.transactionHash || found.txHash || null,
      selftest_tx_link: found.transactionLink || null,
      trace,
      error: selfTestOk ? (integrity.pass ? null : `integrity check failed: ${integrity.note}`) : `self-test final status ${result.finalStatus}`,
    }).eq("id", prov.id);
    if (!selfTestOk) throw new Error(`self-test did not succeed (${result.finalStatus})`);
    if (!integrity.pass) throw new Error(`INTEGRITY-FAIL: ${integrity.note}`);

    const listed = await publishWorkflow({
      workflowId, params, priceUsd: WORKFLOW_PRICE_USD, apiKey: KEEPERHUB_API_KEY,
    });
    trace.push({ step: "publish", ok: listed.ok, verified: listed.verified, steps: listed.steps });
    const published = listed.ok;

    let callable = null;
    if (listed.slug) {
      const p = await probeChallenge({ target: listed.slug, apiKey: KEEPERHUB_API_KEY });
      callable = {
        status: p.status,
        is_402: p.status === 402,
        version: p.detected_version,
        price: p.offer_summary?.human_price_usdc ?? null,
        payTo: p.offer_summary?.payTo ?? null,
      };
      trace.push({ step: "callability_probe", callable });
    }

    await supabase.from("provenance").update({
      status: published ? "published" : "self_tested",
      listing_slug: listed.slug,
      price_usd: Number(WORKFLOW_PRICE_USD),
      trace,
      error: published ? null : `publish verification failed: ${JSON.stringify(listed.verified)}`,
    }).eq("id", prov.id);

    await supabase.from("demand_events").update({ consumed_by: prov.id }).in("id", events.map((e) => e.id));

    res.json({
      result: published && callable?.is_402 ? "PUBLISHED AND CHARGING" : (published ? "PUBLISHED, NOT YET CHARGING" : "SELF-TESTED, PUBLISH FAILED"),
      provenanceId: prov.id,
      workflowId,
      selfTestTx: found.transactionHash || found.txHash || null,
      selfTestTxLink: found.transactionLink || null,
      listingSlug: listed.slug,
      priceUsd: WORKFLOW_PRICE_USD,
      publishVerified: listed.verified,
      callable,
      healAttempts: healLog.length,
      nextStep: callable?.is_402
        ? `/x402/pay?secret=...&target=${listed.slug}`
        : "read trace.publish.steps for the failing tool call",
      trace,
    });
  } catch (err) {
    if (prov?.id) await supabase.from("provenance").update({ status: "failed", trace, heal_log: healLog, error: err.message }).eq("id", prov.id);
    res.status(500).json({ result: "ERROR", error: err.message, provenanceId: prov?.id || null, trace });
  }
});

// legacy alias, kept so older URLs still work
app.get("/run/buyer", async (req, res) => {
  if (!guard(req, res)) return;
  const slug = req.query.slug;
  if (!slug) return res.status(400).json({ error: "need ?slug=" });
  const out = await paidCall({ target: slug, maxUsd: Number(req.query.max || 0.5) });
  await logRun({
    kind: "buyer", status: out.ok ? "success" : "error",
    tx_hash: out.tx_hash || null, tx_link: out.tx_link || null,
    request: { slug }, response: out, error: out.error || null,
  });
  if (out.ok && out.tx_hash) {
    await supabase.from("provenance").update({
      status: "paid_call_confirmed", paid_tx_hash: out.tx_hash, paid_tx_link: out.tx_link,
    }).eq("listing_slug", slug);
  }
  res.status(out.ok ? 200 : 502).json(out);
});

// ============================================================
// provenance certificate
// ============================================================
app.get("/provenance/:id", async (req, res) => {
  if (!guard(req, res)) return;
  const { data: p, error } = await supabase.from("provenance").select("*").eq("id", req.params.id).single();
  if (error || !p) return res.status(404).json({ error: "not found" });
  const { data: events } = await supabase.from("demand_events").select("raw_request, failure_reason, source, created_at").in("id", p.demand_event_ids);
  res.json({
    certificate: {
      why_this_exists: { normalized_need: p.normalized_need, evidence_count: p.demand_event_ids.length, evidence: events },
      how_it_was_built: { status: p.status, heal_attempts: p.heal_attempts, risk_verdict: p.risk_verdict, keeperhub_workflow_id: p.workflow_id },
      proof_it_works: { selftest_execution_id: p.selftest_execution_id, selftest_tx_hash: p.selftest_tx_hash, selftest_tx_link: p.selftest_tx_link },
      proof_it_earns: {
        listing_slug: p.listing_slug,
        price_usd: p.price_usd,
        paid_tx_hash: p.paid_tx_hash,
        paid_tx_link: p.paid_tx_link,
        status: p.paid_tx_hash ? "monetized" : (p.selftest_tx_hash ? "self_tested_only" : "unproven"),
        marketplace_call_url: p.listing_slug ? `https://app.keeperhub.com/api/mcp/workflows/${p.listing_slug}/call` : null,
        per_workflow_mcp: p.listing_slug ? `https://app.keeperhub.com/mcp/w/${p.listing_slug}` : null,
      },
      chain_split_disclosure: "Workflow execution settles on Sepolia (11155111) per the risk policy. x402 payment settles on Base mainnet USDC (8453), because KeeperHub's signing allowlist is Base 8453 / Tempo 4217 / Tempo testnet 42431 and offers no Base Sepolia payment rail. The payment leg executes no workflow node.",
      created_at: p.created_at,
    },
    full_trace_available: true,
  });
});

// ============================================================
// discovery
// ============================================================
app.get("/discover", async (req, res) => {
  if (!guard(req, res)) return;
  const full = req.query.full === "1";
  const out = {};

  const schemas = await kh("/api/mcp/schemas");
  if (full) {
    out.mcp_schemas = { status: schemas.status, body: schemas.json };
  } else {
    const raw = JSON.stringify(schemas.json || {});
    out.mcp_schemas = {
      status: schemas.status,
      totalChars: raw.length,
      topLevelKeys: schemas.json && typeof schemas.json === "object" ? Object.keys(schemas.json) : null,
      conditionExcerpt: raw.match(/.{0,400}Condition.{0,800}/)?.[0] || "no 'Condition' match",
      note: "add &full=1 for the complete raw registry",
    };
  }

  try {
    const oa = await fetch("https://app.keeperhub.com/openapi.json");
    const oaText = await oa.text();
    let oaJson; try { oaJson = JSON.parse(oaText); } catch { oaJson = null; }
    out.openapi = oaJson
      ? (full ? oaJson : {
          status: oa.status,
          pathCount: oaJson.paths ? Object.keys(oaJson.paths).length : 0,
          slugs: oaJson.paths ? Object.keys(oaJson.paths).map((p) => p.split("/")[4]).filter(Boolean) : [],
        })
      : { status: oa.status, note: "not json", head: oaText.slice(0, 300) };
  } catch (e) { out.openapi = { error: String(e).slice(0, 200) }; }

  const wfs = await kh("/api/workflows");
  const wfArr = Array.isArray(wfs.json) ? wfs.json : wfs.json?.workflows || wfs.json?.data || [];
  out.workflows = {
    status: wfs.status,
    count: Array.isArray(wfArr) ? wfArr.length : "unknown shape",
    all: Array.isArray(wfArr) ? wfArr.map((w) => ({ id: w.id, name: w.name, enabled: w.enabled, visibility: w.visibility, isListed: w.isListed, listedSlug: w.listedSlug, priceUsdcPerCall: w.priceUsdcPerCall })) : wfs.json,
  };

  res.json(out);
});

app.get("/debug/kh-proxy", async (req, res) => {
  if (!guard(req, res)) return;
  const { method = "GET", path } = req.query;
  if (!path || !path.startsWith("/")) return res.status(400).json({ error: "need ?path=/api/..." });
  let body = null;
  if (req.query.body) {
    try { body = JSON.parse(req.query.body); } catch { return res.status(400).json({ error: "?body= must be valid json" }); }
  }
  const r = await kh(path, method.toUpperCase(), body);
  res.json({ probed: { method: method.toUpperCase(), path, body }, status: r.status, response: r.json });
});

// ============================================================
// glass box
// ============================================================
app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>keeper-agent</title>
<style>body{background:#0b0b0d;color:#c9c9c9;font-family:ui-monospace,monospace;padding:16px;font-size:13px}h1{color:#CC2222;font-size:16px;margin-bottom:4px}#log div{padding:4px 0;border-bottom:1px solid #1a1a1e}.ok{color:#4ade80}.err{color:#f87171}.k{color:#888}input{background:#151518;border:1px solid #333;color:#ddd;padding:7px;width:230px}a{color:#CC2222}.pill{display:inline-block;padding:1px 6px;border:1px solid #333;border-radius:3px;margin-right:6px;font-size:11px}</style></head>
<body><h1>keeper-agent // glass box</h1>
<p class="k">demand &rarr; build &rarr; prove &rarr; sell &rarr; earn. live from Supabase, nothing staged.</p>
<p>secret: <input id="s" placeholder="RUN_SECRET" /></p>
<p class="k" id="meta"></p><div id="log">enter the secret above</div>
<script>
async function tick(){const s=document.getElementById('s').value;if(!s)return;
try{const r=await fetch('/runs?secret='+encodeURIComponent(s));const d=await r.json();
if(d.error){document.getElementById('log').innerHTML='<div class="err">'+d.error+'</div>';return}
const okc=d.filter(x=>x.status==='success').length;
document.getElementById('meta').textContent=d.length+' runs shown / '+okc+' successful / updated '+new Date().toLocaleTimeString();
document.getElementById('log').innerHTML=d.map(x=>'<div><span class="k">'+new Date(x.created_at).toLocaleTimeString()+'</span> <span class="pill">'+x.kind+'</span> <span class="'+(x.status==='success'?'ok':(x.status==='error'?'err':'k'))+'">'+String(x.status).toUpperCase()+'</span>'+(x.tx_link?' <a href="'+x.tx_link+'" target="_blank">tx</a>':'')+(x.error?' <span class="err">'+String(x.error).slice(0,90)+'</span>':'')+'</div>').join('')}catch(e){}}
setInterval(tick,3000);tick();
</script></body></html>`);
});

mountBuyerRoutes(app, { guard, logRun, apiKey: KEEPERHUB_API_KEY });
mountMcpRoutes(app, { guard, apiKey: KEEPERHUB_API_KEY });
mountLandingRoute(app);
mountDemoRoute(app);

// survey.js is optional. if the file is not in the repo, the app still boots.
try {
  const { mountSurveyRoutes } = await import("./survey.js");
  mountSurveyRoutes(app, { guard, apiKey: KEEPERHUB_API_KEY });
  console.log("survey routes mounted");
} catch {
  console.log("survey.js not present, skipping /survey routes");
}

app.listen(PORT, () => console.log(`keeper-agent m2 listening on ${PORT}`));
