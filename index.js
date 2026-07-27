// keeper-agent | milestone 2
// milestone 1 endpoints kept: /health /run/pipeline-test /run/transfer /runs
// new:
//   GET  /ledger/log?secret=..&raw=..&need=..&reason=..   log one real demand event
//   GET  /ledger/seed?secret=..                           seed 3 labeled demo events for 'checked-transfer'
//   GET  /ledger?secret=..                                view the demand ledger grouped by need
//   GET  /run/factory?secret=..                           THE LOOP: evidence -> draft -> risk -> validate -> heal -> simulate-ish -> real self-test tx -> publish
//   GET  /run/buyer?secret=..&slug=..                     second identity pays for the listed workflow via x402
//   GET  /provenance/:id?secret=..                        the birth certificate, every claim anchored to a KeeperHub id or tx hash
//   GET  /                                                glass-box live view (polls /runs + /provenance)

import express from "express";
import { createClient } from "@supabase/supabase-js";
import {
  kh, deepFind, draftParams, healParams, riskCheck, buildNodes, classifyFailure, collectExecutedNodeIds,
  createWorkflow, patchWorkflow, validateWorkflow, executeWorkflow, pollExecution, listWorkflow,
} from "./pipeline.js";
import { paidCall } from "./buyer.js";

const {
  KEEPERHUB_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RUN_SECRET,
  TEST_ADDRESS, RECEIVER_ADDRESS, TEST_NETWORK = "11155111",
  ANTHROPIC_API_KEY, BUYER_PRIVATE_KEY,
  WORKFLOW_PRICE_USD = "0.05",   // >= $0.05: KeeperHub's own floor against self-dealing
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
// milestone 1 endpoints (unchanged behavior)
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
      BUYER_PRIVATE_KEY: BUYER_PRIVATE_KEY ? "set" : "MISSING (needed for /run/buyer)",
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
    if (!started.ok) throw new Error(`execute_transfer failed (${started.status}), see trace for expected fields`);
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
// milestone 2: demand ledger
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
// milestone 2: THE FACTORY
// ============================================================
app.get("/run/factory", async (req, res) => {
  if (!guard(req, res)) return;
  const trace = [];
  let prov = null;
  const healLog = [];

  try {
    // step 0: evidence gate. no evidence, no build. that's the whole point.
    const { data: events } = await supabase.from("demand_events").select("*").is("consumed_by", null).eq("normalized_need", "checked-transfer");
    if (!events || events.length < Number(DEMAND_THRESHOLD)) {
      return res.status(412).json({
        result: "NO BUILD",
        reason: `evidence gate not met: ${events?.length || 0}/${DEMAND_THRESHOLD} unconsumed demand events for 'checked-transfer'. the agent refuses to invent demand. seed or log events first.`,
      });
    }
    const { data: provRow } = await supabase.from("provenance").insert({
      normalized_need: "checked-transfer",
      demand_event_ids: events.map((e) => e.id),
      status: "started",
    }).select().single();
    prov = provRow;
    trace.push({ step: "evidence_gate", passed: true, eventCount: events.length });

    // step 1: Claude drafts parameters only. the graph is a fixed template.
    let params = await draftParams("checked-transfer", events.map((e) => e.raw_request));
    trace.push({ step: "draft", params });
    await supabase.from("provenance").update({ status: "generated", trace }).eq("id", prov.id);

    // step 2: deterministic risk policy. runs in code, cannot be prompted around.
    let verdict = riskCheck(params, TEST_NETWORK);
    if (!verdict.allowed) {
      // one heal attempt for policy failures, then hard stop
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

    // step 3: create (nodes/edges upfront). failures are CLASSIFIED first:
    // TEMPLATE errors abort immediately (healing params can't fix the graph),
    // PARAMETER errors get healed, and every healed draft must re-pass the
    // risk policy before resubmission.
    let workflowId = null;
    for (let attempt = 0; attempt <= 2; attempt++) {
      const { nodes, edges } = buildNodes(params, TEST_NETWORK, TEST_ADDRESS, RECEIVER_ADDRESS);
      const created = await createWorkflow(params.workflow_name + "-" + Date.now().toString(36), params.listing_description.slice(0, 140), nodes, edges);
      trace.push({ step: "create_workflow", attempt, status: created.status, body: created.json });
      if (created.ok && created.workflowId) { workflowId = created.workflowId; break; }

      const failureClass = classifyFailure(created.json);
      trace.push({ step: "failure_classification", attempt, class: failureClass });
      if (failureClass === "TEMPLATE") {
        healLog.push({ stage: "create", classification: "TEMPLATE", fixable: false, error: created.json });
        throw new Error("KH-TEMPLATE-MISMATCH: template-level rejection, healing skipped by design (re-drafting parameters cannot fix graph structure), see trace");
      }
      if (healLog.length >= 2) break;
      params = await healParams(params, JSON.stringify(created.json));
      healLog.push({ stage: "create", classification: "PARAMETER", fixable: true, error: created.json, patched: params });
      // healed params must re-pass the risk policy; Claude cannot heal its way past it
      const reVerdict = riskCheck(params, TEST_NETWORK);
      trace.push({ step: "risk_recheck_after_heal", attempt, verdict: reVerdict });
      if (!reVerdict.allowed) {
        await supabase.from("provenance").update({ status: "failed", risk_verdict: reVerdict, heal_attempts: healLog.length, heal_log: healLog, trace, error: "healed parameters rejected by risk policy" }).eq("id", prov.id);
        return res.status(403).json({ result: "REFUSED BY RISK POLICY (post-heal)", verdict: reVerdict, trace });
      }
    }
    if (!workflowId) throw new Error("create failed after capped heal attempts, see trace");

    // step 4: validate (falls through gracefully if REST validate is absent)
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

    // step 5: real self-test execution. tx #1.
    const executed = await executeWorkflow(workflowId);
    trace.push({ step: "self_test_execute", status: executed.status, body: executed.json });
    if (!executed.ok || !executed.executionId) throw new Error("self-test execute failed, see trace");
    const result = await pollExecution(executed.executionId);
    trace.push({ step: "self_test_result", finalStatus: result.finalStatus, logs: result.logs });
    const found = deepFind({ s: result.statusBody, l: result.logs }, ["transactionHash", "transactionLink", "txHash"]);
    const selfTestOk = ["success", "completed"].includes(result.finalStatus);

    // step 5b: EXECUTION INTEGRITY CHECK. KeeperHub can accept an invalid node
    // at create time, silently prune it at runtime, and still report "success"
    // (we got burned by exactly this). so "success" alone is not proof: compare
    // the graph we created against the nodes that actually executed.
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
        : (!transferRan ? "gate evaluated false or transfer skipped; nothing proven onchain, refusing to publish" : "all nodes executed, transfer confirmed"),
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
    if (!selfTestOk) throw new Error(`self-test did not succeed (${result.finalStatus}), refusing to publish an unproven workflow`);
    if (!integrity.pass) throw new Error(`INTEGRITY-FAIL: ${integrity.note} (missing: ${missing.join(", ") || "none"})`);

    // step 6: publish at >= $0.05 (KeeperHub's own anti-self-dealing floor)
    const listed = await listWorkflow(workflowId, params, WORKFLOW_PRICE_USD);
    trace.push({ step: "list_workflow", status: listed.status, requested: listed.requested, body: listed.json });
    const published = listed.ok;
    await supabase.from("provenance").update({
      status: published ? "published" : "self_tested",
      listing_slug: listed.slug,
      price_usd: Number(WORKFLOW_PRICE_USD),
      trace,
      error: published ? null : "listing call did not return ok, raw response kept in trace (likely field-name fix needed)",
    }).eq("id", prov.id);

    // step 7: consume the evidence so it cannot justify a second build
    await supabase.from("demand_events").update({ consumed_by: prov.id }).in("id", events.map((e) => e.id));

    res.json({
      result: published ? "PUBLISHED" : "SELF-TESTED, LISTING NEEDS ONE FIX",
      provenanceId: prov.id,
      workflowId,
      selfTestTx: found.transactionHash || found.txHash || null,
      selfTestTxLink: found.transactionLink || null,
      listingSlug: listed.slug,
      priceUsd: WORKFLOW_PRICE_USD,
      healAttempts: healLog.length,
      nextStep: published ? `/run/buyer?secret=...&slug=${listed.slug}` : "paste the list_workflow trace back into chat",
      trace,
    });
  } catch (err) {
    if (prov?.id) await supabase.from("provenance").update({ status: "failed", trace, heal_log: healLog, error: err.message }).eq("id", prov.id);
    res.status(500).json({ result: "ERROR", error: err.message, provenanceId: prov?.id || null, trace });
  }
});

// ============================================================
// milestone 2: the buyer (second identity, tx #2)
// ============================================================
app.get("/run/buyer", async (req, res) => {
  if (!guard(req, res)) return;
  const slug = req.query.slug;
  if (!slug) return res.status(400).json({ error: "need ?slug=" });
  const out = await paidCall(slug, {});
  if (out.ok && out.paid) {
    const found = deepFind(out.result, ["transactionHash", "transactionLink", "txHash"]);
    await supabase.from("provenance").update({
      status: "paid_call_confirmed",
      paid_tx_hash: found.transactionHash || found.txHash || null,
      paid_tx_link: found.transactionLink || null,
    }).eq("listing_slug", slug);
  }
  res.status(out.ok ? 200 : 500).json(out);
});

// ============================================================
// milestone 2: provenance certificate
// ============================================================
app.get("/provenance/:id", async (req, res) => {
  if (!guard(req, res)) return;
  const { data: p, error } = await supabase.from("provenance").select("*").eq("id", req.params.id).single();
  if (error || !p) return res.status(404).json({ error: "not found" });
  const { data: events } = await supabase.from("demand_events").select("raw_request, failure_reason, source, created_at").in("id", p.demand_event_ids);
  res.json({
    certificate: {
      why_this_exists: {
        normalized_need: p.normalized_need,
        evidence_count: p.demand_event_ids.length,
        evidence: events,
      },
      how_it_was_built: {
        status: p.status,
        heal_attempts: p.heal_attempts,
        risk_verdict: p.risk_verdict,
        keeperhub_workflow_id: p.workflow_id,
      },
      proof_it_works: {
        selftest_execution_id: p.selftest_execution_id,
        selftest_tx_hash: p.selftest_tx_hash,
        selftest_tx_link: p.selftest_tx_link,
      },
      proof_it_earns: {
        listing_slug: p.listing_slug,
        price_usd: p.price_usd,
        paid_tx_hash: p.paid_tx_hash,
        paid_tx_link: p.paid_tx_link,
        marketplace_call_url: p.listing_slug ? `https://app.keeperhub.com/api/mcp/workflows/${p.listing_slug}/call` : null,
        per_workflow_mcp: p.listing_slug ? `https://app.keeperhub.com/mcp/w/${p.listing_slug}` : null,
      },
      created_at: p.created_at,
    },
    full_trace_available: true,
  });
});

// ============================================================
// discovery: one deploy collapses the remaining unknowns.
// GET /discover — schema registry, openapi surface, real workflow shapes,
//                 and the raw 402 challenge from KeeperHub's public listing.
// GET /debug/kh-proxy — the browser becomes the terminal: probe any
//                 KeeperHub path without a deploy cycle.
// ============================================================
app.get("/discover", async (req, res) => {
  if (!guard(req, res)) return;
  const full = req.query.full === "1";
  const out = {};

  // 1. the schema registry: source of truth for node/action shapes
  const schemas = await kh("/api/mcp/schemas");
  if (full) {
    out.mcp_schemas = { status: schemas.status, body: schemas.json };
  } else {
    const raw = JSON.stringify(schemas.json || {});
    out.mcp_schemas = {
      status: schemas.status,
      totalChars: raw.length,
      topLevelKeys: schemas.json && typeof schemas.json === "object" ? Object.keys(schemas.json) : null,
      conditionExcerpt: raw.match(/.{0,400}Condition.{0,800}/)?.[0] || "no 'Condition' match found",
      listingExcerpt: raw.match(/.{0,300}(list_workflow|marketplace|listing).{0,700}/i)?.[0] || "no listing-related match found",
      workflowStructureExcerpt: raw.match(/.{0,200}(workflowStructure|edgeStructure).{0,900}/)?.[0] || "no structure match found",
      note: "add &full=1 for the complete raw registry",
    };
  }

  // 2. openapi surface, if published
  try {
    const oa = await fetch("https://app.keeperhub.com/openapi.json");
    const oaText = await oa.text();
    let oaJson; try { oaJson = JSON.parse(oaText); } catch { oaJson = null; }
    out.openapi = oaJson
      ? (full ? oaJson : {
          status: oa.status,
          pathCount: oaJson.paths ? Object.keys(oaJson.paths).length : 0,
          paths: oaJson.paths ? Object.keys(oaJson.paths) : [],
          listingRelated: oaJson.paths ? Object.entries(oaJson.paths).filter(([p]) => /list|market|live|publish/i.test(p)).map(([p, v]) => ({ path: p, methods: Object.keys(v) })) : [],
        })
      : { status: oa.status, note: "not json", head: oaText.slice(0, 300) };
  } catch (e) {
    out.openapi = { error: String(e).slice(0, 200) };
  }

  // 3. our existing workflows: real accepted node shapes
  const wfs = await kh("/api/workflows");
  const wfArr = Array.isArray(wfs.json) ? wfs.json : wfs.json?.workflows || wfs.json?.data || [];
  out.workflows = {
    status: wfs.status,
    count: Array.isArray(wfArr) ? wfArr.length : "unknown shape, see sample",
    sample: Array.isArray(wfArr) ? wfArr.slice(0, 5).map((w) => ({ id: w.id, name: w.name, isListed: w.isListed, listedSlug: w.listedSlug })) : wfs.json,
    note: "use /debug/kh-proxy?path=/api/workflows/<id> to dump one full workflow",
  };

  // 4. the raw 402 challenge from KeeperHub's own public $0.01 reference listing
  try {
    const probe = await fetch("https://app.keeperhub.com/api/mcp/workflows/mcp-test/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputs: {} }),
    });
    const pText = await probe.text();
    let pJson; try { pJson = JSON.parse(pText); } catch { pJson = { nonJsonBody: pText.slice(0, 1500) }; }
    const hdrs = {};
    for (const h of ["www-authenticate", "x-payment-required", "payment-required", "content-type", "x-payment", "accept-payment"]) {
      const v = probe.headers.get(h);
      if (v) hdrs[h] = v;
    }
    out.x402_challenge_probe = { status: probe.status, headers: hdrs, body: pJson };
  } catch (e) {
    out.x402_challenge_probe = { error: String(e).slice(0, 200) };
  }

  res.json(out);
});

app.get("/debug/kh-proxy", async (req, res) => {
  if (!guard(req, res)) return;
  const { method = "GET", path } = req.query;
  if (!path || !path.startsWith("/")) return res.status(400).json({ error: "need ?path=/api/... (must start with /)" });
  let body = null;
  if (req.query.body) {
    try { body = JSON.parse(req.query.body); } catch { return res.status(400).json({ error: "?body= must be valid json" }); }
  }
  const r = await kh(path, method.toUpperCase(), body);
  res.json({ probed: { method: method.toUpperCase(), path, body }, status: r.status, response: r.json });
});


app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>keeper-agent</title>
<style>body{background:#0b0b0d;color:#c9c9c9;font-family:ui-monospace,monospace;padding:16px;font-size:13px}h1{color:#CC2222;font-size:16px}#log div{padding:3px 0;border-bottom:1px solid #1a1a1e}.ok{color:#4ade80}.err{color:#f87171}.k{color:#888}input{background:#151518;border:1px solid #333;color:#ddd;padding:6px;width:200px}a{color:#CC2222}</style></head>
<body><h1>keeper-agent // glass box</h1>
<p class="k">demand -&gt; build -&gt; prove -&gt; sell -&gt; earn. live from Supabase, nothing staged.</p>
<p>secret: <input id="s" placeholder="RUN_SECRET" /></p><div id="log">waiting...</div>
<script>
async function tick(){const s=document.getElementById('s').value;if(!s)return;
try{const r=await fetch('/runs?secret='+encodeURIComponent(s));const d=await r.json();
if(d.error){document.getElementById('log').innerHTML='<div class="err">'+d.error+'</div>';return}
document.getElementById('log').innerHTML=d.map(x=>'<div><span class="k">'+new Date(x.created_at).toLocaleTimeString()+'</span> ['+x.kind+'] <span class="'+(x.status==='success'?'ok':(x.status==='error'?'err':'k'))+'">'+x.status.toUpperCase()+'</span>'+(x.tx_link?' <a href="'+x.tx_link+'" target="_blank">tx</a>':'')+(x.error?' <span class="err">'+String(x.error).slice(0,80)+'</span>':'')+'</div>').join('')}catch(e){}}
setInterval(tick,3000);
</script></body></html>`);
});

app.listen(PORT, () => console.log(`keeper-agent m2 listening on ${PORT}`));
