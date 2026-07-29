// demo.js — a single sequencer page for recording the video.
// Same backend endpoints as everything else, just no tab-switching.
// The secret is typed into the page at runtime; it is never stored here.

export function mountDemoRoute(app) {
  app.get("/demo", (req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>keeper-agent // demo</title>
<style>
body{background:#0b0b0d;color:#ddd;font-family:ui-monospace,monospace;padding:20px;font-size:15px;max-width:720px;margin:0 auto}
h1{color:#CC2222;font-size:22px;margin-bottom:2px}
.sub{color:#888;margin-bottom:20px}
input{background:#151518;border:1px solid #333;color:#ddd;padding:10px;width:100%;box-sizing:border-box;font-size:15px;margin-bottom:20px}
.step{border:1px solid #262629;border-radius:8px;padding:16px;margin-bottom:14px;background:#111113}
.step h2{font-size:16px;margin:0 0 6px 0;color:#eee}
.step p{color:#999;margin:0 0 12px 0;font-size:13px}
button{background:#CC2222;color:#fff;border:none;padding:10px 18px;border-radius:6px;font-size:14px;font-family:inherit;cursor:pointer}
button:disabled{background:#333;color:#777;cursor:default}
button.danger{background:#8a1a1a}
.result{margin-top:12px;padding:12px;background:#0b0b0d;border:1px solid #222;border-radius:6px;font-size:13px;white-space:pre-wrap;word-break:break-all;display:none}
.result.show{display:block}
.line{margin:2px 0}
.ok{color:#4ade80}.err{color:#f87171}.wait{color:#facc15}
a{color:#ff6b6b}
.score{font-size:14px;line-height:1.9}
.pending{color:#555}
</style></head>
<body>
<h1>keeper-agent</h1>
<div class="sub">demand &rarr; build &rarr; verify &rarr; sell &rarr; deliver</div>

<input id="secret" placeholder="RUN_SECRET" type="password" />

<div class="step">
  <h2>1. Log demand</h2>
  <p>Seeds three labeled demo requests. The agent will not build without evidence.</p>
  <button onclick="doSeed()">Seed evidence</button>
  <div id="r-seed" class="result"></div>
</div>

<div class="step">
  <h2>2. Build, prove, publish</h2>
  <p>Drafts parameters, runs the risk policy, creates the workflow, self-tests it onchain, verifies every node executed, then lists it for sale. Takes up to a minute.</p>
  <button onclick="doFactory()">Run factory</button>
  <div id="r-factory" class="result"></div>
</div>

<div class="step">
  <h2>3. Confirm it's charging</h2>
  <p>Hits the live marketplace listing with no payment attached. Should return a real 402.</p>
  <button onclick="doProbe()" id="btn-probe" disabled>Probe listing</button>
  <div id="r-probe" class="result"></div>
</div>

<div class="step">
  <h2>4. Pay it</h2>
  <p>Spends real USDC on Base mainnet from a separate wallet. This is not a simulation.</p>
  <button class="danger" onclick="doPay()" id="btn-pay" disabled>Pay $0.05</button>
  <div id="r-pay" class="result"></div>
</div>

<div class="step">
  <h2>scoreboard</h2>
  <div class="score" id="score">
    <div class="line pending" id="s1">&#9675; demand detected</div>
    <div class="line pending" id="s2">&#9675; workflow generated</div>
    <div class="line pending" id="s3">&#9675; integrity verified</div>
    <div class="line pending" id="s4">&#9675; listed for sale</div>
    <div class="line pending" id="s5">&#9675; payment settled on Base</div>
    <div class="line pending" id="s6">&#9675; service delivered</div>
  </div>
</div>

<script>
let currentSlug = null;
const S = (id) => document.getElementById(id);
const secret = () => S('secret').value.trim();
const show = (id, html) => { const el = S(id); el.innerHTML = html; el.classList.add('show'); };
const mark = (id) => { const el = S(id); el.classList.remove('pending'); el.classList.add('ok'); el.innerHTML = el.innerHTML.replace('&#9675;','&#10003;'); };

async function call(path) {
  const r = await fetch(path);
  const j = await r.json();
  return { status: r.status, json: j };
}

async function doSeed() {
  if (!secret()) return alert('enter the secret first');
  show('r-seed', 'running...');
  const { json } = await call('/ledger/seed?secret=' + encodeURIComponent(secret()));
  show('r-seed', (json.seeded ? '<span class="ok">' + json.seeded + ' events logged, labeled source=seeded</span>' : JSON.stringify(json)));
  if (json.seeded) mark('s1');
}

async function doFactory() {
  if (!secret()) return alert('enter the secret first');
  show('r-factory', '<span class="wait">building... this takes up to a minute</span>');
  const { json } = await call('/run/factory?secret=' + encodeURIComponent(secret()));
  if (json.result && json.result.startsWith('PUBLISHED')) {
    currentSlug = json.listingSlug;
    mark('s2'); mark('s3'); mark('s4');
    show('r-factory',
      '<span class="ok">' + json.result + '</span>\\n' +
      'self-test tx: <a href="' + json.selfTestTxLink + '" target="_blank">' + json.selfTestTx + '</a>\\n' +
      'listing: ' + json.listingSlug + ' at $' + json.priceUsd
    );
    S('btn-probe').disabled = false;
  } else {
    show('r-factory', '<span class="err">' + (json.result || json.error) + '</span>\\n' + JSON.stringify(json, null, 2).slice(0, 800));
  }
}

async function doProbe() {
  if (!currentSlug) return alert('run the factory first');
  show('r-probe', 'probing...');
  const { json } = await call('/x402/probe?secret=' + encodeURIComponent(secret()) + '&target=' + currentSlug);
  if (json.status === 402) {
    show('r-probe', '<span class="ok">402 Payment Required</span>\\nprice: $' + json.offer_summary.human_price_usdc + ' USDC\\nnetwork: ' + json.offer_summary.network + '\\npayTo: ' + json.offer_summary.payTo);
    S('btn-pay').disabled = false;
  } else {
    show('r-probe', '<span class="err">status ' + json.status + '</span>');
  }
}

async function doPay() {
  if (!currentSlug) return;
  if (!confirm('This spends real USDC on Base mainnet. Continue?')) return;
  show('r-pay', '<span class="wait">paying...</span>');
  const { json } = await call('/x402/pay?secret=' + encodeURIComponent(secret()) + '&target=' + currentSlug);
  if (json.ok) {
    mark('s5'); mark('s6');
    show('r-pay',
      '<span class="ok">settled</span>\\n' +
      'payment tx: <a href="' + json.tx_link + '" target="_blank">' + json.tx_hash + '</a>\\n' +
      'buyer: ' + json.buyer_identity + '\\n' +
      (json.response_body_json && json.response_body_json.output && json.response_body_json.output.transactionLink
        ? 'delivered execution: <a href="' + json.response_body_json.output.transactionLink + '" target="_blank">' + json.response_body_json.output.transactionHash + '</a>'
        : '')
    );
  } else {
    show('r-pay', '<span class="err">' + json.error + '</span>');
  }
}
</script>
</body></html>`);
  });
}
