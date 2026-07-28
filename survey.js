// survey.js — read-only census of KeeperHub's public marketplace.
//
// SAFETY: an unpriced listing returns 200 and EXECUTES on a bare POST, which
// would run a stranger's workflow and could move their funds. So this surveys
// via get_workflow_listing (public, read-only) and only sends a real call to
// listings that carry a price, because those answer 402 without executing.

import { mcpCallTool } from "./mcp.js";

const OPENAPI = "https://app.keeperhub.com/openapi.json";
const CALL_RE = /^\/api\/mcp\/workflows\/([^/]+)\/call$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function listCatalogSlugs() {
  const res = await fetch(OPENAPI);
  const json = await res.json();
  const paths = json?.paths ? Object.keys(json.paths) : [];
  const slugs = paths.map((p) => p.match(CALL_RE)?.[1]).filter(Boolean);
  return { ok: res.ok, status: res.status, pathCount: paths.length, slugs: [...new Set(slugs)] };
}

async function readListing(slug, apiKey) {
  const r = await mcpCallTool({ tool: "get_workflow_listing", args: { slug }, apiKey });
  const p = r.parsed;
  if (!p) return { slug, readable: false, note: r.text?.[0]?.slice(0, 160) || "unreadable" };
  return {
    slug,
    readable: true,
    workflowId: p.id ?? null,
    name: p.name ?? null,
    organizationId: p.organizationId ?? null,
    isListed: p.isListed ?? null,
    priceUsdcPerCall: p.priceUsdcPerCall ?? null,
    workflowType: p.workflowType ?? null,
    category: p.category ?? null,
    chain: p.chain ?? null,
    listedAt: p.listedAt ?? null,
    hasInputSchema: !!p.inputSchema,
  };
}

// only ever called on PRICED listings, which 402 without executing
async function probePriced(slug) {
  try {
    const res = await fetch(`https://app.keeperhub.com/api/mcp/workflows/${slug}/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
    return {
      status: res.status,
      callable: res.status === 402,
      message: body?.message || body?.error || null,
      cf_ray: res.headers.get("cf-ray"),
    };
  } catch (e) {
    return { status: "FETCH_ERROR", callable: false, message: e.message };
  }
}

export async function surveyMarketplace({ apiKey, limit = 0, probe = true, batch = 4, pauseMs = 900 } = {}) {
  const started = Date.now();
  const cat = await listCatalogSlugs();
  const slugs = limit > 0 ? cat.slugs.slice(0, limit) : cat.slugs;

  const rows = [];
  for (let i = 0; i < slugs.length; i += batch) {
    const chunk = slugs.slice(i, i + batch);
    rows.push(...(await Promise.all(chunk.map((s) => readListing(s, apiKey)))));
    if (i + batch < slugs.length) await sleep(pauseMs);
  }

  const priced = rows.filter((r) => r.readable && r.priceUsdcPerCall != null);
  const unpriced = rows.filter((r) => r.readable && r.priceUsdcPerCall == null);
  const unreadable = rows.filter((r) => !r.readable);

  if (probe) {
    for (let i = 0; i < priced.length; i += batch) {
      const chunk = priced.slice(i, i + batch);
      const results = await Promise.all(chunk.map((r) => probePriced(r.slug)));
      chunk.forEach((r, n) => { r.probe = results[n]; });
      if (i + batch < priced.length) await sleep(pauseMs);
    }
  }

  const probed = priced.filter((r) => r.probe);
  const callable = probed.filter((r) => r.probe.callable);
  const disabled = probed.filter((r) => r.probe.status === 503);
  const orgs = new Set(rows.filter((r) => r.organizationId).map((r) => r.organizationId));

  return {
    stage: "marketplace_survey",
    surveyed_at: new Date().toISOString(),
    elapsed_ms: Date.now() - started,
    catalog: { openapi_paths: cat.pathCount, slugs_found: cat.slugs.length, surveyed: slugs.length },
    headline: {
      total_listings: rows.length,
      priced: priced.length,
      unpriced_and_therefore_free: unpriced.length,
      unreadable: unreadable.length,
      distinct_organizations: orgs.size,
      priced_and_callable: callable.length,
      priced_but_disabled_503: disabled.length,
    },
    finding: [
      `${unpriced.length} of ${rows.length} listed workflows carry no price. A listing with a null price does not issue an x402 challenge; it executes for free.`,
      probed.length
        ? `Of the ${probed.length} priced listings probed, ${callable.length} answered a 402 payment challenge and ${disabled.length} returned 503 "the workflow owner has disabled this workflow."`
        : `No priced listings were probed.`,
      `Unpriced listings were deliberately NOT called. A bare POST to a free listing executes it, which would run a stranger's workflow and could spend their funds. They are reported as unprobeable rather than surveyed by execution.`,
    ],
    method: {
      read: "MCP get_workflow_listing (public, no auth, read-only) for every slug in openapi.json",
      probe: "unauthenticated POST, priced listings only, which returns 402 without executing",
      not_done: "no call was made to any unpriced listing",
    },
    rows,
  };
}

export function mountSurveyRoutes(app, { guard, apiKey } = {}) {
  app.get("/survey", async (req, res) => {
    if (guard && !guard(req, res)) return;
    try {
      res.json(await surveyMarketplace({
        apiKey,
        limit: Number(req.query.limit || 0),
        probe: req.query.probe !== "0",
      }));
    } catch (e) {
      res.status(500).json({ error: e.message, stack: e.stack });
    }
  });

  app.get("/survey/slugs", async (req, res) => {
    if (guard && !guard(req, res)) return;
    try { res.json(await listCatalogSlugs()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
}
