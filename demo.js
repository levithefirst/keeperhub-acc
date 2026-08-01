// demo.js — single-page auto-running demo. One button, six stages, real data.
// Rebuilt clean after a persistent 404 on the deployed route. Same behavior
// as before, written fresh top to bottom.

export function mountDemoRoute(app) {
  app.get("/demo", function (req, res) {
    res.setHeader("Content-Type", "text/html");
    res.send(PAGE);
  });
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>keeper-agent</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
* { box-sizing: border-box; }
:root {
  --bg:#09090b; --surface:#18181b; --border:rgba(255,255,255,.07);
  --text:#fafafa; --muted:rgba(255,255,255,.42); --faint:rgba(255,255,255,.24);
  --accent:#6366f1; --success:#22c55e; --warn:#f59e0b; --error:#ef4444;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
html, body { margin:0; padding:0; }
body {
  background:var(--bg); color:var(--text);
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  font-size:14px; line-height:1.5; -webkit-font-smoothing:antialiased;
}
.wrap { max-width:640px; margin:0 auto; padding:20px 16px 64px; }
@media (min-width:700px) { .wrap { padding:28px 24px 80px; } }

#bar { position:fixed; top:0; left:0; height:2px; width:100%; background:transparent; z-index:50; }
#bar i { display:block; height:2px; background:var(--accent); transform:scaleX(0); transform-origin:left; transition:transform 400ms linear; }

header { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; margin-bottom:6px; }
h1 { font-size:19px; font-weight:700; letter-spacing:-.01em; margin:0; }
.tag { font-size:12px; color:var(--muted); }
.lede { font-size:13px; color:var(--muted); margin:0 0 18px; }

.health { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:18px; min-height:22px; }
.hb { display:inline-flex; align-items:center; gap:5px; font-size:11px; font-weight:500; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); border:1px solid var(--border); border-radius:4px; padding:3px 7px; }
.hb i { width:5px; height:5px; border-radius:50%; background:var(--faint); flex:none; }
.hb.ok i { background:var(--success); }
.hb.warn i { background:var(--warn); }
.hb.bad i { background:var(--error); }

.control { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:16px; margin-bottom:20px; }
input[type=password] { width:100%; background:#0f0f12; border:1px solid var(--border); border-radius:8px; color:var(--text); padding:11px 12px; font-size:14px; font-family:inherit; outline:none; transition:border-color 150ms ease-out; }
input[type=password]:focus { border-color:var(--accent); }
.opt { display:flex; align-items:flex-start; gap:9px; margin:13px 0 15px; cursor:pointer; }
.opt input { margin:2px 0 0; accent-color:var(--accent); flex:none; }
.opt span { font-size:12.5px; color:var(--muted); line-height:1.45; }
.opt b { color:var(--text); font-weight:500; }
#run { width:100%; height:46px; background:var(--accent); color:#fff; border:0; border-radius:8px; font:600 15px Inter,sans-serif; cursor:pointer; transition:filter 150ms ease-out; }
#run:hover:not(:disabled) { filter:brightness(1.08); }
#run:disabled { background:#27272a; color:var(--faint); cursor:not-allowed; }
.meta { display:flex; justify-content:space-between; align-items:center; margin-top:11px; font-size:11.5px; color:var(--faint); min-height:16px; }

.stage { background:var(--surface); border:1px solid var(--border); border-left:3px solid #27272a; border-radius:10px; margin-bottom:10px; overflow:hidden; transition:border-left-color 250ms ease-out, box-shadow 250ms ease-out; }
.stage.active { border-left-color:var(--accent); animation:glow 2s ease-out infinite; }
.stage.done { border-left-color:var(--success); }
.stage.failed { border-left-color:var(--error); }
@keyframes glow { 0% { box-shadow:0 0 0 0 rgba(99,102,241,.28); } 100% { box-shadow:0 0 0 5px rgba(99,102,241,0); } }
.row { display:flex; align-items:center; gap:11px; padding:14px 16px; }
.ind { width:16px; height:16px; flex:none; display:grid; place-items:center; }
.ind .o { width:11px; height:11px; border:1.5px solid #3f3f46; border-radius:50%; }
.stage.active .ind .o { border-color:var(--warn); animation:beat 1.3s ease-in-out infinite; }
@keyframes beat { 0%,100% { opacity:1; transform:scale(1); } 50% { opacity:.42; transform:scale(.82); } }
.ind svg { display:none; }
.stage.done .ind .o { display:none; }
.stage.done .ind svg { display:block; }
.stage.failed .ind .o { border-color:var(--error); animation:none; }
.tick { stroke:var(--success); stroke-width:2.4; fill:none; stroke-linecap:round; stroke-dasharray:22; stroke-dashoffset:22; transition:stroke-dashoffset 320ms ease-out; }
.stage.done .tick { stroke-dashoffset:0; }
.title { font-size:14.5px; font-weight:500; flex:1; color:var(--muted); transition:color 200ms ease-out; }
.stage.active .title, .stage.done .title { color:var(--text); }
.n { font-size:11px; color:var(--faint); font-variant-numeric:tabular-nums; flex:none; }

.body { max-height:0; opacity:0; overflow:hidden; transition:max-height 320ms ease-out, opacity 200ms ease-out; }
.stage.open .body { max-height:420px; opacity:1; }
.inner { padding:0 16px 15px; border-top:1px solid var(--border); margin-top:0; padding-top:13px; }
.d { display:flex; justify-content:space-between; align-items:center; gap:14px; padding:7px 0; border-bottom:1px solid rgba(255,255,255,.045); opacity:0; transform:translateY(4px); transition:opacity 180ms ease-out, transform 180ms ease-out; }
.stage.open .d { opacity:1; transform:none; }
.stage.open .d:nth-child(1) { transition-delay:40ms; }
.stage.open .d:nth-child(2) { transition-delay:90ms; }
.stage.open .d:nth-child(3) { transition-delay:140ms; }
.stage.open .d:nth-child(4) { transition-delay:190ms; }
.d:last-child { border-bottom:0; }
.k { font-size:11px; font-weight:500; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); flex:none; }
.v { font-size:13.5px; text-align:right; word-break:break-word; }
.v.big { font-weight:600; font-size:15px; }
.hash { font-family:var(--mono); font-size:12.5px; color:#a1a1aa; text-decoration:none; border-bottom:1px dotted rgba(255,255,255,.22); transition:color 150ms ease-out; }
.hash:hover { color:var(--text); border-bottom-color:var(--text); }
.cp { background:0; border:0; padding:2px; margin-left:6px; cursor:pointer; opacity:.34; transition:opacity 150ms ease-out; vertical-align:-2px; }
.cp:hover { opacity:.9; }
.cp svg { stroke:#a1a1aa; fill:none; stroke-width:1.6; }
.badge { display:inline-flex; align-items:center; gap:5px; font-size:11px; font-weight:500; text-transform:uppercase; letter-spacing:.05em; }
.badge i { width:5px; height:5px; border-radius:50%; flex:none; }
.badge.g { color:var(--success); }
.badge.g i { background:var(--success); }
.badge.a { color:var(--warn); }
.badge.a i { background:var(--warn); }
.err { color:var(--error); font-size:13px; padding:7px 0; }

.foot { margin-top:24px; font-size:12px; color:var(--faint); line-height:1.6; }
.foot a { color:var(--muted); }
#toast { position:fixed; bottom:22px; left:50%; transform:translate(-50%,14px); background:var(--surface); border:1px solid var(--border); border-radius:7px; padding:8px 15px; font-size:12.5px; opacity:0; pointer-events:none; transition:opacity 180ms ease-out, transform 180ms ease-out; z-index:60; }
#toast.show { opacity:1; transform:translate(-50%,0); }
</style>
</head>
<body>

<div id="bar"><i id="barfill"></i></div>
<div class="wrap">
<header><h1>keeper-agent</h1><span class="tag">autonomous onchain producer</span></header>
<p class="lede">Finds demand, builds a workflow, verifies it, sells it, gets paid. One run, no human input.</p>

<div class="health" id="health"></div>

<div class="control">
<input type="password" id="secret" placeholder="RUN_SECRET" autocomplete="off" spellcheck="false">
<label class="opt"><input type="checkbox" id="live">
<span><b>Include the live payment.</b> Spends $0.05 of real USDC on Base mainnet from a separate wallet. Leave unchecked to run everything up to the point of sale.</span></label>
<button id="run">Run the agent</button>
<div class="meta"><span id="phase"></span><span id="clock"></span></div>
</div>

<div id="stages"></div>

<p class="foot">Every hash links to a public block explorer. Workflow execution settles on Sepolia per the agent's risk policy; x402 payment settles on Base mainnet. Demo demand events are labeled <span style="font-family:var(--mono);font-size:11.5px">source: seeded</span> in the database and in every API response.</p>
</div>
<div id="toast"></div>

<script>
var STAGES = [
  { id:"s1", t:"Demand logged" },
  { id:"s2", t:"Parameters drafted" },
  { id:"s3", t:"Risk policy cleared" },
  { id:"s4", t:"Built and self-tested onchain" },
  { id:"s5", t:"Execution integrity verified" },
  { id:"s6", t:"Listed and charging" },
  { id:"s7", t:"Paid on Base mainnet" },
  { id:"s8", t:"Service delivered" }
];
var slug = null, t0 = null, timer = null, cur = 0;
function $(i) { return document.getElementById(i); }

function buildStages() {
  var h = "";
  for (var i = 0; i < STAGES.length; i++) {
    var s = STAGES[i];
    h += '<div class="stage" id="' + s.id + '">' +
      '<div class="row"><span class="ind"><span class="o"></span>' +
      '<svg width="15" height="15" viewBox="0 0 24 24"><path class="tick" d="M20 6L9 17l-5-5"/></svg>' +
      '</span><span class="title">' + s.t + '</span><span class="n">' + (i + 1) + '</span></div>' +
      '<div class="body"><div class="inner" id="' + s.id + 'b"></div></div></div>';
  }
  $("stages").innerHTML = h;
}

function trunc(v) {
  if (!v) return "";
  v = String(v);
  return v.length > 16 ? v.slice(0, 6) + "\\u2026" + v.slice(-4) : v;
}

function toast(m) {
  var e = $("toast");
  e.textContent = m;
  e.className = "show";
  setTimeout(function () { e.className = ""; }, 1400);
}

function copy(v) {
  navigator.clipboard.writeText(v).then(function () { toast("Copied"); });
}
window.__cp = copy;

function hashRow(k, v, link) {
  var a = link
    ? '<a class="hash" href="' + link + '" target="_blank" rel="noopener">' + trunc(v) + '</a>'
    : '<span class="hash">' + trunc(v) + '</span>';
  var b = '<button class="cp" onclick="__cp(\\'' + v + '\\')" title="Copy">' +
    '<svg width="13" height="13" viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/>' +
    '<path d="M5 15V5a2 2 0 012-2h10"/></svg></button>';
  return '<div class="d"><span class="k">' + k + '</span><span class="v">' + a + b + '</span></div>';
}

function row(k, v, cls) {
  return '<div class="d"><span class="k">' + k + '</span><span class="v ' + (cls || "") + '">' + v + '</span></div>';
}

function badge(txt, tone) {
  return '<span class="badge ' + tone + '"><i></i>' + txt + '</span>';
}

function setState(id, state, html) {
  var el = $(id);
  if (!el) return;
  el.className = "stage " + state + (html ? " open" : "");
  if (html) $(id + "b").innerHTML = html;
}

function progress(n) { $("barfill").style.transform = "scaleX(" + (n / STAGES.length) + ")"; }
function phase(txt) { $("phase").textContent = txt || ""; }

function startClock() {
  t0 = Date.now();
  timer = setInterval(function () {
    var s = Math.floor((Date.now() - t0) / 1000);
    $("clock").textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }, 1000);
}
function stopClock() { if (timer) { clearInterval(timer); timer = null; } }

function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function api(path) {
  var r = await fetch(path);
  var j = await r.json();
  return { status: r.status, json: j };
}

async function health() {
  var q = slug ? "?slug=" + slug : "";
  try {
    var r = await api("/status" + q);
    var c = r.json.components || {};
    var h = "";
    var map = [["keeperhub_api", "KeeperHub"], ["live_listing", "Listing"], ["buyer_wallet", "Buyer wallet"]];
    for (var i = 0; i < map.length; i++) {
      var k = map[i][0];
      var v = c[k] || {};
      var tone = v.status === "ok" ? "ok" : (v.status === "down" ? "bad" : "warn");
      h += '<span class="hb ' + tone + '"><i></i>' + map[i][1] + '</span>';
    }
    $("health").innerHTML = h;
  } catch (e) {}
}

async function run() {
  var sec = $("secret").value.trim();
  if (!sec) { toast("Enter the secret"); return; }
  var live = $("live").checked;
  $("run").disabled = true; $("secret").disabled = true; $("live").disabled = true;
  $("run").textContent = "Running";
  buildStages(); cur = 0; progress(0); startClock();

  try {
    phase("Logging demand evidence"); setState("s1", "active");
    var a = await api("/ledger/seed?secret=" + encodeURIComponent(sec));
    if (!a.json.seeded) throw { stage: "s1", msg: a.json.error || "could not log demand" };
    setState("s1", "done",
      row("Events", a.json.seeded + " logged") +
      row("Source", badge("seeded", "a")) +
      row("Threshold", "3 required to build")
    );
    progress(++cur);

    phase("Drafting, building, verifying, publishing"); setState("s2", "active");
    var f = await api("/run/factory?secret=" + encodeURIComponent(sec));
    var j = f.json, tr = j.trace || [];
    function step(n) { for (var i = 0; i < tr.length; i++) if (tr[i].step === n) return tr[i]; return null; }
    if (!j.result || j.result.indexOf("PUBLISHED") !== 0) {
      throw { stage: "s2", msg: (j.result || "") + " " + (j.error || "") };
    }
    slug = j.listingSlug;

    var d = step("draft");
    setState("s2", "done",
      row("Workflow", (d && d.params ? d.params.workflow_name : "\\u2014")) +
      row("Threshold", (d && d.params ? d.params.balance_threshold_eth + " ETH" : "\\u2014")) +
      row("Transfer", (d && d.params ? d.params.transfer_amount_eth + " ETH" : "\\u2014")) +
      row("Graph", "fixed template, not model-generated")
    );
    progress(++cur); await wait(420);

    var rk = step("risk_check");
    setState("s3", "done",
      row("Verdict", badge(rk && rk.verdict && rk.verdict.allowed ? "allowed" : "refused", rk && rk.verdict && rk.verdict.allowed ? "g" : "a")) +
      row("Policy", "testnet only, capped amounts") +
      row("Evaluated by", "deterministic code, no model")
    );
    progress(++cur); await wait(420);

    setState("s4", "done",
      hashRow("Self-test tx", j.selfTestTx, j.selfTestTxLink) +
      row("Network", "Sepolia") + row("Gas", "sponsored")
    );
    progress(++cur); await wait(420);

    var ic = step("integrity_check");
    var ig = ic && ic.integrity ? ic.integrity : {};
    setState("s5", "done",
      row("Nodes", (ig.executedNodes ? ig.executedNodes.length : 0) + " of " + (ig.expectedNodes ? ig.expectedNodes.length : 0) + " executed") +
      row("Dropped", (ig.missingNodes && ig.missingNodes.length ? ig.missingNodes.join(", ") : "none")) +
      row("Result", badge(ig.pass ? "verified" : "failed", ig.pass ? "g" : "a"))
    );
    progress(++cur); await wait(420);

    var cl = j.callable || {};
    setState("s6", "done",
      row("Price", "$" + (cl.price != null ? cl.price : j.priceUsd) + " USDC", "big") +
      row("Challenge", badge(cl.is_402 ? "402 payment required" : "not charging", cl.is_402 ? "g" : "a")) +
      hashRow("Paid to", cl.payTo) +
      row("Slug", '<span class="hash">' + j.listingSlug + '</span>')
    );
    progress(++cur);
    health();

    if (!live) {
      phase("Stopped before payment");
      setState("s7", "", row("Skipped", "live payment not selected"));
      setState("s8", "", row("Skipped", "nothing purchased"));
      $("stages").querySelector("#s7").classList.add("open");
      $("stages").querySelector("#s8").classList.add("open");
    } else {
      phase("Paying from a separate wallet"); setState("s7", "active");
      var p = await api("/x402/pay?secret=" + encodeURIComponent(sec) + "&target=" + slug);
      var pj = p.json;
      if (!pj.ok) throw { stage: "s7", msg: pj.error || "payment failed" };
      setState("s7", "done",
        row("Amount", "$" + pj.price_paid_usdc + " USDC", "big") +
        hashRow("Settlement", pj.tx_hash, pj.tx_link) +
        hashRow("Payer", pj.buyer_identity) +
        row("Gas", "paid by facilitator, not the buyer")
      );
      progress(++cur); await wait(420);

      var o = pj.response_body_json && pj.response_body_json.output ? pj.response_body_json.output : {};
      setState("s8", "done",
        hashRow("Execution tx", o.transactionHash, o.transactionLink) +
        row("Network", "Sepolia") +
        row("Status", badge(o.success ? "delivered" : "unknown", o.success ? "g" : "a"))
      );
      progress(++cur);
      phase("Complete");
    }

    $("run").textContent = "Run again";
  } catch (e) {
    var sid = e && e.stage ? e.stage : "s" + (cur + 1);
    setState(sid, "failed", '<div class="err">' + ((e && e.msg) || (e && e.message) || "failed") + '</div>');
    phase("Stopped"); $("run").textContent = "Try again";
  } finally {
    stopClock();
    $("run").disabled = false; $("secret").disabled = false; $("live").disabled = false;
    health();
  }
}

buildStages(); health();
$("run").addEventListener("click", run);
$("secret").addEventListener("keydown", function (e) { if (e.key === "Enter") run(); });
</script>
</body>
</html>`;
