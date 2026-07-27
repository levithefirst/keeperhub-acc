app.get("/run/buyer", async (req, res) => {
  if (!guard(req, res)) return;
  const slug = req.query.slug;
  if (!slug) return res.status(400).json({ error: "need ?slug=" });

  const out = await paidCall({
    slug,
    body: req.query.body ? JSON.parse(req.query.body) : {},
    maxUsd: Number(req.query.max || 1),
    forceVersion: req.query.force || null,
  });

  await logRun({
    kind: "buyer",
    status: out.ok ? "success" : "error",
    tx_hash: out.tx_hash || null,
    tx_link: out.tx_link || null,
    request: { slug },
    response: out,
    error: out.error || null,
  });

  if (out.ok && out.tx_hash) {
    await supabase.from("provenance").update({
      status: "paid_call_confirmed",
      paid_tx_hash: out.tx_hash,
      paid_tx_link: out.tx_link,
    }).eq("listing_slug", slug);
  }

  res.status(out.ok ? 200 : 502).json(out);
});
