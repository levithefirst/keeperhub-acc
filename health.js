// health.js — dependency health checks + resilient fetch wrapper.
// One job: never let a visitor confuse "this one component is down" with
// "the whole project is broken."

const KH = "https://app.keeperhub.com";

/** Retry wrapper for any external fetch. 3 attempts, exponential backoff,
 *  only retries on 5xx / network errors / timeouts — never on 4xx, since a
 *  4xx means the request itself was wrong and retrying won't fix it. */
export async function resilientFetch(url, options = {}, { retries = 3, baseDelayMs = 1000 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.status >= 500 && attempt < retries) {
        lastErr = new Error(`HTTP ${res.status}`);
        await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, attempt)));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, attempt)));
        continue;
      }
    }
  }
  throw new Error(`resilientFetch exhausted ${retries + 1} attempts: ${lastErr?.message}`);
}

async function checkKeeperHub(apiKey) {
  const started = Date.now();
  try {
    const res = await resilientFetch(`${KH}/api/mcp/schemas`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    }, { retries: 1 });
    return { status: res.ok ? "ok" : "degraded", http_status: res.status, latency_ms: Date.now() - started };
  } catch (e) {
    return { status: "down", error: e.message };
  }
}

async function checkListing(slug) {
  if (!slug) return { status: "unknown", note: "no slug configured" };
  const started = Date.now();
  try {
    const res = await resilientFetch(`${KH}/api/mcp/workflows/${slug}/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }, { retries: 1 });
    return {
      status: res.status === 402 ? "ok" : (res.status === 503 ? "degraded" : "unknown"),
      http_status: res.status,
      note: res.status === 402 ? "listing is live and charging" : "listing not answering a payment challenge",
      latency_ms: Date.now() - started,
    };
  } catch (e) {
    return { status: "down", error: e.message };
  }
}

async function checkBuyerBalance() {
  const address = process.env.BUYER_ADDRESS; // optional; set if you want a real onchain balance check
  const minUsd = Number(process.env.MIN_BUYER_USDC || "0.10");
  if (!address) {
    return { status: "unknown", note: "BUYER_ADDRESS not set, cannot check live balance" };
  }
  const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  // balanceOf(address) selector + padded address, read via a public Base RPC
  const data = "0x70a08231000000000000000000000000" + address.slice(2).toLowerCase();
  try {
    const res = await resilientFetch("https://mainnet.base.org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ to: USDC_BASE, data }, "latest"],
      }),
    }, { retries: 1 });
    const json = await res.json();
    const raw = json?.result;
    if (!raw) return { status: "unknown", note: "rpc returned no result" };
    const usdc = Number(BigInt(raw)) / 1e6;
    return {
      status: usdc >= minUsd ? "ok" : "low",
      usdc: usdc.toFixed(4),
      threshold: minUsd,
      note: usdc >= minUsd ? "sufficient for a live payment demo" : "below threshold — live payment demo should be disabled",
    };
  } catch (e) {
    return { status: "unknown", error: e.message };
  }
}

/** The full health snapshot. Every check is independent — one failing
 *  never throws or blocks the others. */
export async function runHealthChecks({ apiKey, slug } = {}) {
  const [keeperhub, listing, buyer] = await Promise.all([
    checkKeeperHub(apiKey),
    checkListing(slug),
    checkBuyerBalance(),
  ]);

  const components = { keeperhub_api: keeperhub, live_listing: listing, buyer_wallet: buyer };
  const statuses = Object.values(components).map((c) => c.status);
  const overall = statuses.includes("down") ? "down"
    : (statuses.includes("degraded") || statuses.includes("low")) ? "degraded"
    : "ok";

  return {
    status: overall,
    checked_at: new Date().toISOString(),
    components,
    live_payment_recommended: buyer.status === "ok" && listing.status === "ok",
  };
}

export function mountHealthRoutes(app, { apiKey } = {}) {
  app.get("/status", async (req, res) => {
    try {
      const slug = req.query.slug || null;
      res.json(await runHealthChecks({ apiKey, slug }));
    } catch (e) {
      res.status(500).json({ status: "down", error: e.message });
    }
  });
}
