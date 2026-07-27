// buyer.js — x402 payer client with runtime protocol-version detection.
// Pure module: returns a full trace object, persistence stays in index.js.

const KH_BASE = "https://app.keeperhub.com";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const REFERENCE_SLUG = "mcp-test"; // KeeperHub's public $0.01 reference workflow

function callUrl(slug) {
  return `${KH_BASE}/api/mcp/workflows/${slug}/call`;
}

function headersToObject(h) {
  const out = {};
  for (const [k, v] of h.entries()) out[k.toLowerCase()] = v;
  return out;
}

function tryB64Json(str) {
  if (!str) return null;
  try {
    return JSON.parse(Buffer.from(str, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function tryJson(str) {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/**
 * Decide which x402 generation the server speaks, from the raw 402.
 * Returns "v2" | "v1" | "unknown" plus the evidence that decided it.
 */
function detectVersion(status, headers, bodyJson) {
  const evidence = [];

  if (headers["payment-required"]) {
    evidence.push("PAYMENT-REQUIRED response header present");
    return { version: "v2", evidence };
  }
  if (bodyJson?.x402Version === 2) {
    evidence.push("body.x402Version === 2");
    return { version: "v2", evidence };
  }
  if (bodyJson?.accepted && !bodyJson?.accepts) {
    evidence.push("body has singular 'accepted' object (v2 shape)");
    return { version: "v2", evidence };
  }
  if (bodyJson?.x402Version === 1 || Array.isArray(bodyJson?.accepts)) {
    evidence.push("body.x402Version === 1 or accepts[] array present");
    return { version: "v1", evidence };
  }

  evidence.push(`status ${status}, no recognisable x402 marker`);
  return { version: "unknown", evidence };
}

/**
 * STAGE 0. Hit the endpoint with no payment. Costs nothing. Captures everything.
 */
export async function probeChallenge({ slug = REFERENCE_SLUG, body = {}, apiKey } = {}) {
  const url = callUrl(slug);
  const started = Date.now();

  const res = await fetch(url, {
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

  // v2 puts the challenge in a base64 header
  const headerChallenge = tryB64Json(headers["payment-required"]);
  const detected = detectVersion(res.status, headers, headerChallenge || bodyJson);

  // pull out the money fields wherever they live
  const offer =
    headerChallenge?.accepted ||
    bodyJson?.accepted ||
    (Array.isArray(bodyJson?.accepts) ? bodyJson.accepts[0] : null);

  return {
    stage: "probe",
    url,
    status: res.status,
    ms: Date.now() - started,
    detected_version: detected.version,
    detection_evidence: detected.evidence,
    headers,
    body_raw: rawBody,
    body_json: bodyJson,
    header_challenge: headerChallenge,
    offer_summary: offer
      ? {
          scheme: offer.scheme,
          network: offer.network,
          asset: offer.asset,
          asset_is_base_usdc:
            String(offer.asset || "").toLowerCase() === BASE_USDC.toLowerCase(),
          maxAmountRequired: offer.maxAmountRequired,
          human_price_usdc: offer.maxAmountRequired
            ? Number(offer.maxAmountRequired) / 1e6
            : null,
          payTo: offer.payTo,
          maxTimeoutSeconds: offer.maxTimeoutSeconds,
          extra: offer.extra,
        }
      : null,
  };
}

async function payV1({ url, body, privateKey, apiKey, maxValueAtomic }) {
  const { createWalletClient, http } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { base } = await import("viem/chains");
  const { wrapFetchWithPayment } = await import("x402-fetch");

  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({
    account,
    transport: http("https://mainnet.base.org"),
    chain: base,
  });

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

async function payV2({ url, body, privateKey, apiKey }) {
  const { privateKeyToAccount } = await import("viem/accounts");
  const { x402Client, wrapFetchWithPayment } = await import("@x402/fetch");

  const account = privateKeyToAccount(privateKey);
  const client = new x402Client();

  // two documented registration shapes; try both before giving up
  let registered = null;
  try {
    const evm = await import("@x402/evm/exact/client");
    if (typeof evm.registerExactEvmScheme === "function") {
      evm.registerExactEvmScheme(client, { signer: account });
      registered = "registerExactEvmScheme";
    } else if (evm.ExactEvmScheme) {
      client.register("eip155:*", new evm.ExactEvmScheme(account));
      registered = "ExactEvmScheme + client.register";
    }
  } catch (e) {
    throw new Error(`X402-V2-SCHEME-REGISTER-FAILED: ${e.message}`);
  }
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

/**
 * Full paid call. Probes first, then dispatches. Never guesses the version.
 */
export async function paidCall({
  slug,
  body = {},
  privateKey = process.env.BUYER_PRIVATE_KEY,
  apiKey = process.env.KEEPERHUB_API_KEY,
  maxUsd = 1.0,          // hard client-side ceiling. 1 USDC.
  forceVersion = null,   // "v1" | "v2" to override detection
} = {}) {
  const trace = { stage: "paid_call", slug, started_at: new Date().toISOString() };

  if (!privateKey) return { ...trace, ok: false, error: "BUYER_PRIVATE_KEY not set" };
  if (!slug) return { ...trace, ok: false, error: "slug required" };

  const url = callUrl(slug);
  const maxValueAtomic = BigInt(Math.round(maxUsd * 1e6));

  // always probe, even when forcing, so the challenge is on the record
  let probe;
  try {
    probe = await probeChallenge({ slug, body, apiKey });
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
        probe.status === 503
          ? "workflow is listed but not enabled/public. PATCH enabled:true and visibility public first."
          : probe.status === 200
          ? "endpoint returned 200 without payment. it is not a paid listing."
          : "read probe.body_raw",
    };
  }

  const price = probe.offer_summary?.human_price_usdc;
  if (price != null && price > maxUsd) {
    return { ...trace, ok: false, error: `PRICE-ABOVE-CAP: ${price} > ${maxUsd}` };
  }

  const version = forceVersion || probe.detected_version;
  trace.version_used = version;

  if (version === "unknown") {
    return {
      ...trace,
      ok: false,
      error: "X402-VERSION-UNDETECTED",
      hint: "inspect probe.headers and probe.body_raw, then re-run with &force=v1 or &force=v2",
    };
  }

  let result;
  try {
    result = version === "v2"
      ? await payV2({ url, body, privateKey, apiKey })
      : await payV1({ url, body, privateKey, apiKey, maxValueAtomic });
  } catch (e) {
    return { ...trace, ok: false, error: `PAYMENT-FAILED: ${e.message}`, stack: e.stack };
  }

  const { res, payer, lane } = result;
  const headers = headersToObject(res.headers);
  const rawBody = await res.text();

  const settlement =
    tryB64Json(headers["x-payment-response"]) ||
    tryB64Json(headers["payment-response"]) ||
    null;

  return {
    ...trace,
    ok: res.status >= 200 && res.status < 300,
    lane,
    status: res.status,
    buyer_identity: payer,
    settlement,
    tx_hash: settlement?.transaction || settlement?.txHash || null,
    tx_link: settlement?.transaction
      ? `https://basescan.org/tx/${settlement.transaction}`
      : null,
    settle_network: settlement?.network || probe.offer_summary?.network || null,
    price_paid_usdc: price,
    response_headers: headers,
    response_body_raw: rawBody,
    response_body_json: tryJson(rawBody),
  };
}

export { REFERENCE_SLUG, BASE_USDC };
