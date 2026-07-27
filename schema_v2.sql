// buyer.js | milestone 2
// the second identity. a genuinely separate wallet (BUYER_PRIVATE_KEY) that
// discovers the listed workflow and pays for it over x402. the facilitator
// pays gas, so this wallet only needs testnet USDC, no ETH.
// packages: x402-fetch + viem. protocol version of the target is auto-probed:
// if the wrapped fetch fails, we surface the RAW 402 challenge so the fix is
// one paste away instead of guesswork.

import { privateKeyToAccount } from "viem/accounts";

let wrapFetchWithPayment = null;
try {
  ({ wrapFetchWithPayment } = await import("x402-fetch"));
} catch {
  // package missing; buyer endpoint will report it instead of crashing the app
}

export async function paidCall(slug, inputs = {}) {
  const url = `https://app.keeperhub.com/api/mcp/workflows/${slug}/call`;
  const trace = [];

  if (!process.env.BUYER_PRIVATE_KEY) {
    return { ok: false, error: "BUYER_PRIVATE_KEY env var not set", trace };
  }

  const account = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY);
  trace.push({ step: "buyer_identity", address: account.address });

  // step 1: probe without payment so we capture the real 402 challenge shape
  const probe = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inputs }),
  });
  const probeText = await probe.text();
  let probeJson;
  try { probeJson = JSON.parse(probeText); } catch { probeJson = { nonJsonBody: probeText.slice(0, 2000) }; }
  trace.push({ step: "probe", status: probe.status, challenge: probeJson });

  if (probe.status !== 402 && probe.ok) {
    // workflow answered without payment (free listing or price not applied yet)
    return { ok: true, paid: false, result: probeJson, trace };
  }

  if (!wrapFetchWithPayment) {
    return { ok: false, error: "x402-fetch package not installed, but the 402 challenge above is captured for wiring", trace };
  }

  // step 2: real paid call. maxValue caps spend at $0.25 as a hard safety.
  try {
    const fetchWithPay = wrapFetchWithPayment(fetch, account, { maxValue: BigInt(250000) }); // 0.25 USDC, 6 decimals
    const res = await fetchWithPay(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputs }),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { nonJsonBody: text.slice(0, 2000) }; }
    trace.push({ step: "paid_call", status: res.status, body: json, paymentResponseHeader: res.headers.get("x-payment-response") || res.headers.get("payment-response") || null });
    return { ok: res.ok, paid: true, result: json, trace };
  } catch (err) {
    trace.push({ step: "paid_call_error", error: String(err).slice(0, 1500) });
    return { ok: false, error: "paid call failed, see trace (likely protocol version or missing testnet USDC in buyer wallet)", trace };
  }
}
