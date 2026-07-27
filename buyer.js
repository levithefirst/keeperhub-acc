// buyer.js — x402 payer client + probe tooling.
// Prefers v2 (PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE).
// Falls back to v1 (X-PAYMENT) only when the wire explicitly says v1.
// Never logs or returns the private key.

const KH_BASE = "https://app.keeperhub.com";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const REFERENCE_SLUG = "helloworld";

const DEFAULT_SWEEP = [
  "helloworld",
  "simple-workflow",
  "eth-price-x402",
  "token-risk-analysis",
  "mythos-x402-circle-gateway",
  "wallet-trust-score-base",
  "buy-me-a-coffee",
  "microtip",
  "checked-transfer-16zk",
];

function resolveTarget(t) {
  if (!t) return null;
  return /^https?:\/\//i.test(t) ? t : `${KH_BASE}/api/mcp/workflows/${t}/call`;
}

function headersToObject(h) {
  const out = {};
  for (const [k, v] of h.entries()) out[k.toLowerCase()] = v;
  return out;
}

function tryB64Json(str) {
  if (!str) return null;
  try { return JSON.parse(Buffer.from(str, "base64").toString("utf8")); } catch { return null; }
}

function tryJson(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch { return null; }
}

async function lanesAvailable() {
  const out = { v1: false, v2: false, notes: [] };
  try { await import("x402-fetch"); out.v1 = true; }
  catch (e) { out.notes.push(`v1 (x402-fetch): ${e.message}`); }
  try {
    await import("@x402/fetch");
    await import("@x402/evm/exact/client");
    out.v2 = true;
  } catch (e) { out.notes.push(`v2 (@x402/fetch + @x402/evm): ${e.message}`); }
  return out;
}

function detectVersion(status, headers, bodyJson) {
  const evidence = [];
  if (headers["payment-required"]) {
    evidence.push("PAYMENT-REQUIRED response header present -> v2");
    return { version: "v2", evidence };
  }
  if (bodyJson?.x402Version === 2 || (bodyJson?.accepted && !bodyJson?.accepts)) {
    evidence.push("body carries v2 markers");
    return { version: "v2", evidence };
  }
  if (bodyJson?.x402Version === 1 || Array.isArray(bodyJson?.accepts)) {
    evidence.push("body carries v1 markers (x402Version 1 or accepts[] array)");
    return { version: "v1", evidence };
  }
  if (status === 402) {
    evidence.push("402 with no explicit marker; defaulting v2 (CORS advertises PAYMENT-SIGNATURE)");
    return { version: "v2", evidence };
  }
  evidence.push(`status ${status}, not a payment challenge`);
  return { version: "unknown", evidence };
}

function extractOffer(headerChallenge, bodyJson) {
  const src = headerChallenge || bodyJson;
  if (!src) return null;
  if (src.accepted) return src.accepted;
  if (Array.isArray(src.accepts)) return src.accepts[0];
  return null;
}

function summariseOffer(offer) {
  if (!offer) return null;
  const amt = offer.maxAmountRequired ?? offer.amount ?? null;
  return {
    scheme: offer.scheme ?? null,
    network: offer.network ?? null,
    asset: offer.asset ?? null,
    asset_is_base_usdc: String(offer.asset || "").toLowerCase() === BASE_USDC.toLowerCase(),
    atomic_amount: amt,
    human_price_usdc: amt != null && !isNaN(Number(amt)) ? Number(amt) / 1e6 : null,
    payTo: offer.payTo ?? null,
    maxTimeoutSeconds: offer.maxTimeoutSeconds ?? null,
    extra: offer.extra ?? null,
  };
}

/** FREE. One unpaid POST. Spends nothing, captures everything. */
export async function probeChallenge({ slug, url, target, body = {}, apiKey } = {}) {
  const finalUrl = resolveTarget(target || url || slug || REFERENCE_SLUG);
  const started = Date.now();

  const res = await fetch(finalUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });

  const headers = headersToObject(res.headers);
  const rawBody = await res.text();
  const bodyJson = tryJson(rawBody);
  const headerChallenge = tryB64Json(headers["payment-required"]);
  const detected = detectVersion(res.status, headers, headerChallenge || bodyJson);
  const lanes = await lanesAvailable();
  const laneReady = detected.version === "v2" ? lanes.v2 : detected.version === "v1" ? lanes.v1 : false;

  return {
    stage: "probe",
    url: finalUrl,
    status: res.status,
    ms: Date.now() - started,
    detected_version: detected.version,
    detection_evidence: detected.evidence,
    lanes,
    lane_ready: laneReady,
    ready_to_pay: res.status === 402 && laneReady,
    cf_ray: headers["cf-ray"] || null,
    server_date: headers["date"] || null,
    cors_allow_headers: headers["access-control-allow-headers"] || null,
    cors_expose_headers: headers["access-control-expose-headers"] || null,
    headers,
    body_raw: rawBody.slice(0, 4000),
    body_json: bodyJson,
    header_challenge: headerChallenge,
    offer_summary: summariseOffer(extractOffer(headerChallenge, bodyJson)),
  };
}

/** FREE. Probe many targets at once. One page answers "mine or everyone". */
export async function probeSweep({ targets = DEFAULT_SWEEP, apiKey } = {}) {
  const started = Date.now();
  const results = await Promise.all(
    targets.map(async (t) => {
      try {
        const p = await probeChallenge({ target: t, apiKey });
        return {
          target: t,
          status: p.status,
          version: p.detected_version,
          price_usdc: p.offer_summary?.human_price_usdc ?? null,
          payTo: p.offer_summary?.payTo ?? null,
          network: p.offer_summary?.network ?? null,
          message: p.body_json?.message || p.body_json?.error || null,
          cf_ray: p.cf_ray,
          ms: p.ms,
        };
      } catch (e) {
        return { target: t, status: "FETCH_ERROR", message: e.message };
      }
    })
  );

  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  const payable = results.filter((r) => r.status === 402);

  return {
    stage: "sweep",
    swept_at: new Date().toISOString(),
    total: results.length,
    elapsed_ms: Date.now() - started,
    status_counts: counts,
    distinct_error_messages: [...new Set(results.map((r) => r.message).filter(Boolean))],
    verdict:
      payable.length > 0
        ? `PAYABLE: ${payable.length} target(s) returned a real 402.`
        : counts["503"] === results.length
        ? "ALL 503: every listed workflow is disabled. KeeperHub creates workflows disabled by default, so this is the platform's default state, not an outage. Evidence for the onboarding writeup."
        : "MIXED: statuses differ. read the table.",
    payable_targets: payable,
    results,
  };
}

async function payV2({ url, body, privateKey, apiKey }) {
  const { privateKeyToAccount } = await import("viem/accounts");
  let x402Client, wrapFetchWithPayment;
  try { ({ x402Client, wrapFetchWithPayment } = await import("@x402/fetch")); }
  catch (e) { throw new Error(`X402-V2-NOT-INSTALLED: ${e.message}`); }

  const account = privateKeyToAccount(privateKey);
  const client = new x402Client();

  let registered = null;
  try {
    const evm = await import("@x402/evm/exact/client");
    if (typeof evm.registerExactEvmScheme === "function") {
      evm.registerExactEvmScheme(client, { signer: account });
      registered = "registerExactEvmScheme({signer})";
    } else if (evm.ExactEvmScheme) {
      client.register("eip155:*", new evm.ExactEvmScheme(account));
      registered = "ExactEvmScheme + client.register";
    }
  } catch (e) { throw new Error(`X402-V2-SCHEME-REGISTER-FAILED: ${e.message}`); }
  if (!registered) throw new Error("X402-V2-SCHEME-REGISTER-FAILED: no known export");

  const fetchWithPay = wrapFetchWithPayment(fetch, client);
  const res = await fetchWithPay(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });

  return { res, payer: account.address, lane: `v2/@x402/fetch (${registered})` };
}

async function payV1({ url, body, privateKey, apiKey, maxValueAtomic }) {
  const { createWalletClient, http } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { base } = await import("viem/chains");
  const { wrapFetchWithPayment } = await import("x402-fetch");

  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({ account, transport: http("https://mainnet.base.org"), chain: base });
  const fetchWithPay = wrapFetchWithPayment(fetch, wallet, maxValueAtomic);

  const res = await fetchWithPay(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });

  return { res, payer: account.address, lane: "v1/x402-fetch" };
}

/** SPENDS REAL USDC. Probes first, never guesses the version, caps the amount. */
export async function paidCall({
  slug, url, target,
  body = {},
  privateKey = process.env.BUYER_PRIVATE_KEY,
  apiKey = process.env.KEEPERHUB_API_KEY,
  maxUsd = 0.5,
  forceVersion = null,
} = {}) {
  const finalUrl = resolveTarget(target || url || slug);
  const trace = { stage: "paid_call", url: finalUrl, started_at: new Date().toISOString() };

  if (!privateKey) return { ...trace, ok: false, error: "BUYER_PRIVATE_KEY not set" };
  if (!finalUrl) return { ...trace, ok: false, error: "need a slug or url" };

  const maxValueAtomic = BigInt(Math.round(maxUsd * 1e6));

  let probe;
  try {
    probe = await probeChallenge({ target: finalUrl, body, apiKey });
    trace.probe = probe;
  } catch (e) {
    return { ...trace, ok: false, error: `PROBE-FAILED: ${e.message}` };
  }

  if (probe.status !== 402) {
    return {
      ...trace,
      ok: false,
      error: `EXPECTED-402-GOT-${probe.status}`,
      hint:
        probe.status === 503 ? "workflow disabled. run /mcp/enable?id=<workflowId> then retry."
        : probe.status === 404 ? "target does not exist."
        : probe.status === 200 ? "returned 200 without payment, not a paid resource."
        : "read probe.body_raw",
    };
  }

  const price = probe.offer_summary?.human_price_usdc;
  if (price != null && price > maxUsd) {
    return { ...trace, ok: false, error: `PRICE-ABOVE-CAP: ${price} > ${maxUsd} USDC` };
  }

  const version = forceVersion || probe.detected_version;
  trace.version_used = version;

  const laneOk = version === "v2" ? probe.lanes.v2 : probe.lanes.v1;
  if (!laneOk) {
    return { ...trace, ok: false, error: `LANE-NOT-INSTALLED-${String(version).toUpperCase()}`, lanes: probe.lanes };
  }

  let result;
  try {
    result = version === "v1"
      ? await payV1({ url: finalUrl, body, privateKey, apiKey, maxValueAtomic })
      : await payV2({ url: finalUrl, body, privateKey, apiKey });
  } catch (e) {
    return { ...trace, ok: false, error: `PAYMENT-FAILED: ${e.message}`, stack: e.stack };
  }

  const { res, payer, lane } = result;
  const headers = headersToObject(res.headers);
  const rawBody = await res.text();

  const settlement =
    tryB64Json(headers["payment-response"]) ||
    tryB64Json(headers["x-payment-response"]) ||
    tryB64Json(headers["payment-receipt"]) ||
    null;

  const txHash = settlement?.transaction || settlement?.txHash || settlement?.transactionHash || null;

  return {
    ...trace,
    ok: res.status >= 200 && res.status < 300,
    lane,
    status: res.status,
    buyer_identity: payer,
    settlement,
    tx_hash: txHash,
    tx_link: txHash ? `https://basescan.org/tx/${txHash}` : null,
    settle_network: settlement?.network || probe.offer_summary?.network || null,
    price_paid_usdc: price,
    response_headers: headers,
    response_body_raw: rawBody.slice(0, 4000),
    response_body_json: tryJson(rawBody),
  };
}

export function mountBuyerRoutes(app, { guard, logRun, apiKey } = {}) {
  app.get("/x402/sweep", async (req, res) => {
    if (guard && !guard(req, res)) return;
    const targets = req.query.targets
      ? String(req.query.targets).split(",").map((s) => s.trim()).filter(Boolean)
      : DEFAULT_SWEEP;
    try { res.json(await probeSweep({ targets, apiKey })); }
    catch (e) { res.status(500).json({ error: e.message, stack: e.stack }); }
  });

  app.get("/x402/probe", async (req, res) => {
    if (guard && !guard(req, res)) return;
    try {
      res.json(await probeChallenge({
        target: req.query.target || req.query.slug || REFERENCE_SLUG,
        body: req.query.body ? JSON.parse(req.query.body) : {},
        apiKey,
      }));
    } catch (e) { res.status(500).json({ error: e.message, stack: e.stack }); }
  });

  app.get("/x402/pay", async (req, res) => {
    if (guard && !guard(req, res)) return;
    const target = req.query.target || req.query.slug;
    if (!target) return res.status(400).json({ error: "need ?target=" });
    try {
      const out = await paidCall({
        target,
        body: req.query.body ? JSON.parse(req.query.body) : {},
        maxUsd: Number(req.query.max || 0.5),
        forceVersion: req.query.force || null,
      });
      if (logRun) {
        await logRun({
          kind: "x402_pay",
          status: out.ok ? "success" : "error",
          tx_hash: out.tx_hash || null,
          tx_link: out.tx_link || null,
          request: { target },
          response: out,
          error: out.error || null,
        });
      }
      res.status(out.ok ? 200 : 502).json(out);
    } catch (e) { res.status(500).json({ error: e.message, stack: e.stack }); }
  });
}

export { REFERENCE_SLUG, BASE_USDC, DEFAULT_SWEEP, lanesAvailable };
