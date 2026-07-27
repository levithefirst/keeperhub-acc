// mcp.js — JSON-RPC 2.0 client for KeeperHub's remote MCP server.
// The browser becomes an MCP client: list tools, call any tool, zero deploys.

const MCP_BASE = "https://app.keeperhub.com";
let SESSION = { id: null, initialized: false, endpoint: null };

function mcpUrl(slug) {
  return slug ? `${MCP_BASE}/mcp/w/${slug}` : `${MCP_BASE}/mcp`;
}

function parseBody(text, contentType = "") {
  if (!text) return null;
  if (contentType.includes("text/event-stream") || text.startsWith("event:") || text.includes("\ndata:")) {
    const frames = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        const p = line.slice(5).trim();
        if (p && p !== "[DONE]") {
          try { frames.push(JSON.parse(p)); } catch { frames.push({ unparsed: p }); }
        }
      }
    }
    return frames.length === 1 ? frames[0] : frames;
  }
  try { return JSON.parse(text); } catch { return { unparsed: text.slice(0, 3000) }; }
}

async function rpc({ method, params = {}, id = Date.now(), apiKey, slug, notify = false }) {
  const url = mcpUrl(slug);
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...(SESSION.id ? { "Mcp-Session-Id": SESSION.id } : {}),
  };
  const payload = notify
    ? { jsonrpc: "2.0", method, params }
    : { jsonrpc: "2.0", id, method, params };

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
  const sid = res.headers.get("mcp-session-id");
  if (sid) SESSION.id = sid;
  const ct = res.headers.get("content-type") || "";
  const raw = await res.text();

  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    contentType: ct,
    session_id: SESSION.id,
    body: parseBody(raw, ct),
    raw: raw.slice(0, 3000),
  };
}

export async function mcpInit({ apiKey, slug, force = false } = {}) {
  if (SESSION.initialized && !force && SESSION.endpoint === mcpUrl(slug)) {
    return { cached: true, initialized: true, session_id: SESSION.id, endpoint: SESSION.endpoint };
  }
  SESSION = { id: null, initialized: false, endpoint: mcpUrl(slug) };

  const init = await rpc({
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "keeper-agent", version: "0.4.0" },
    },
    apiKey, slug,
  });

  if (!init.ok) return { ...init, stage: "initialize", initialized: false };

  const ack = await rpc({ method: "notifications/initialized", apiKey, slug, notify: true });
  SESSION.initialized = true;

  return {
    stage: "initialize",
    initialized: true,
    endpoint: SESSION.endpoint,
    session_id: SESSION.id,
    server_info: init.body?.result?.serverInfo ?? null,
    protocol_version: init.body?.result?.protocolVersion ?? null,
    ack_status: ack.status,
    init_raw: init.body,
  };
}

export async function mcpListTools({ apiKey, slug } = {}) {
  const init = await mcpInit({ apiKey, slug });
  if (!init.initialized) return { stage: "tools/list", failed_at: "initialize", init };

  const out = await rpc({ method: "tools/list", apiKey, slug });
  const tools = out.body?.result?.tools ?? [];

  return {
    stage: "tools/list",
    endpoint: mcpUrl(slug),
    status: out.status,
    count: tools.length,
    names: tools.map((t) => t.name),
    tools: tools.map((t) => ({
      name: t.name,
      title: t.title ?? null,
      description: (t.description || "").slice(0, 240),
      required: t.inputSchema?.required ?? null,
      properties: t.inputSchema?.properties ? Object.keys(t.inputSchema.properties) : null,
    })),
    error: out.body?.error ?? null,
    raw_if_empty: tools.length === 0 ? out.raw : undefined,
  };
}

export async function mcpCallTool({ tool, args = {}, apiKey, slug } = {}) {
  if (!tool) return { ok: false, error: "need a tool name" };

  const init = await mcpInit({ apiKey, slug });
  if (!init.initialized) return { stage: "tools/call", failed_at: "initialize", init };

  const out = await rpc({ method: "tools/call", params: { name: tool, arguments: args }, apiKey, slug });
  const result = out.body?.result ?? null;

  const texts = Array.isArray(result?.content)
    ? result.content.filter((c) => c.type === "text").map((c) => c.text)
    : [];
  let parsed = null;
  for (const t of texts) {
    try { parsed = JSON.parse(t); break; } catch { /* plain text, keep it */ }
  }

  return {
    stage: "tools/call",
    endpoint: mcpUrl(slug),
    tool, args,
    ok: out.ok && !result?.isError && !out.body?.error,
    status: out.status,
    is_error: result?.isError ?? false,
    text: texts,
    parsed,
    structured: result?.structuredContent ?? null,
    rpc_error: out.body?.error ?? null,
    raw: parsed ? undefined : out.raw,
  };
}

/**
 * Flip a workflow on. KeeperHub creates workflows DISABLED by default, which is
 * why listed workflows 503 with "the workflow owner has disabled this workflow".
 * Tries the documented arg name first, falls back to the alternate.
 */
export async function enableWorkflow({ id, apiKey } = {}) {
  let r = await mcpCallTool({ tool: "update_workflow", args: { workflowId: String(id), enabled: true }, apiKey });
  if (!r.ok) {
    const alt = await mcpCallTool({ tool: "update_workflow", args: { id: String(id), enabled: true }, apiKey });
    if (alt.ok) return { ...alt, arg_name_used: "id" };
    return { ...r, arg_name_used: "workflowId", alt_attempt: alt };
  }
  return { ...r, arg_name_used: "workflowId" };
}

export function mountMcpRoutes(app, { guard, apiKey } = {}) {
  const wrap = (fn) => async (req, res) => {
    if (guard && !guard(req, res)) return;
    try { res.json(await fn(req)); }
    catch (e) { res.status(500).json({ error: e.message, stack: e.stack }); }
  };

  app.get("/mcp/init", wrap((req) => mcpInit({ apiKey, slug: req.query.slug, force: true })));
  app.get("/mcp/tools", wrap((req) => mcpListTools({ apiKey, slug: req.query.slug })));

  app.get("/mcp/call", wrap(async (req) => {
    let args = {};
    if (req.query.args) {
      try { args = JSON.parse(req.query.args); }
      catch { return { error: "?args= must be valid JSON" }; }
    }
    return mcpCallTool({ tool: req.query.tool, args, apiKey, slug: req.query.slug });
  }));

  app.get("/mcp/enable", wrap(async (req) => {
    const id = req.query.id;
    if (!id) return { error: "need ?id=<workflowId>" };

    const update = await enableWorkflow({ id, apiKey });
    const readback = await mcpCallTool({ tool: "get_workflow", args: { workflowId: String(id) }, apiKey });
    const slug = req.query.slug || null;
    const listing = slug
      ? await mcpCallTool({ tool: "get_workflow_listing", args: { slug }, apiKey })
      : null;

    return {
      stage: "enable",
      workflow_id: id,
      update_ok: update.ok,
      arg_name_used: update.arg_name_used,
      update,
      readback_enabled: readback.parsed?.enabled ?? readback.structured?.enabled ?? "see readback",
      readback,
      listing,
      next: `then hit /x402/probe?secret=...&target=${slug || "<slug>"} — a 402 means it worked.`,
    };
  }));
}

export { mcpUrl, MCP_BASE };
