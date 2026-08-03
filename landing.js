// landing.js — hero screen for the demo video's opening shot, now also a
// real entry point into the product via a CTA button. Matches /demo's
// matte-emerald theme with a bit more visual presence: ambient glow,
// a subtle framed badge, and a button that leads straight into /demo.

export function mountLandingRoute(app) {
  app.get("/landing", (req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.send('<!doctype html><html lang="en"><head>' +
'<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
'<title>keeper-agent</title>' +
'<link rel="preconnect" href="https://fonts.googleapis.com">' +
'<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
'<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">' +
'<style>' +
'*{box-sizing:border-box;margin:0;padding:0}' +
'html,body{height:100%}' +
'body{' +
'background:' +
'radial-gradient(900px 500px at 18% -8%, rgba(16,185,129,.14), transparent 60%),' +
'radial-gradient(700px 480px at 88% 108%, rgba(16,185,129,.08), transparent 55%),' +
'linear-gradient(180deg,#070b09 0%,#050807 46%);' +
'background-attachment:fixed;' +
'color:#f2f5f3;' +
'font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
'-webkit-font-smoothing:antialiased;' +
'min-height:100vh;' +
'display:flex;align-items:center;justify-content:center;' +
'padding:32px;position:relative;overflow:hidden}' +
'body::before{content:"";position:absolute;inset:0;' +
'background-image:linear-gradient(rgba(255,255,255,.025) 1px, transparent 1px),' +
'linear-gradient(90deg, rgba(255,255,255,.025) 1px, transparent 1px);' +
'background-size:64px 64px;' +
'mask-image:radial-gradient(700px 500px at 30% 20%, #000, transparent 70%);' +
'pointer-events:none}' +
'.wrap{max-width:720px;text-align:left;position:relative;z-index:1}' +
'.badge{' +
'display:inline-flex;align-items:center;gap:8px;' +
'font-size:11.5px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;' +
'color:rgba(16,185,129,.9);' +
'background:rgba(16,185,129,.08);' +
'border:1px solid rgba(16,185,129,.25);' +
'border-radius:999px;padding:6px 14px;margin-bottom:26px}' +
'.badge i{width:6px;height:6px;border-radius:50%;background:#10b981;' +
'box-shadow:0 0 8px rgba(16,185,129,.8);flex:none;' +
'animation:pulse 2s ease-in-out infinite}' +
'@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}' +
'h1{font-size:clamp(30px,5.4vw,50px);font-weight:800;line-height:1.14;' +
'letter-spacing:-.025em;margin-bottom:22px}' +
'h1 .dim{color:rgba(242,245,243,.5);font-weight:700}' +
'p.lede{font-size:clamp(15px,2vw,18.5px);font-weight:400;line-height:1.55;' +
'color:rgba(226,240,232,.5);max-width:600px;margin-bottom:38px}' +
'.cta-row{display:flex;align-items:center;gap:18px;flex-wrap:wrap}' +
'a.cta{' +
'display:inline-flex;align-items:center;gap:10px;' +
'background:linear-gradient(180deg,#12c98a,#10b981);' +
'color:#04120c;text-decoration:none;' +
'font-weight:700;font-size:15.5px;letter-spacing:-.005em;' +
'padding:14px 26px;border-radius:11px;' +
'box-shadow:0 10px 28px -14px rgba(16,185,129,.85);' +
'transition:filter 160ms ease-out, box-shadow 160ms ease-out, transform 160ms ease-out}' +
'a.cta:hover{filter:brightness(1.07);box-shadow:0 14px 34px -14px rgba(16,185,129,1);transform:translateY(-1px)}' +
'a.cta svg{transition:transform 160ms ease-out}' +
'a.cta:hover svg{transform:translateX(3px)}' +
'.sub-cta{font-size:12.5px;color:rgba(226,240,232,.34)}' +
'.foot{margin-top:56px;font-size:11.5px;color:rgba(226,240,232,.22);' +
'letter-spacing:.03em;display:flex;gap:18px;flex-wrap:wrap}' +
'@media (max-width:480px){.cta-row{flex-direction:column;align-items:flex-start;gap:10px}}' +
'</style></head><body>' +
'<div class="wrap">' +
'<span class="badge"><i></i>Live on Base mainnet</span>' +
'<h1>An agent that builds, verifies, lists, and sells onchain workflows<span class="dim"> — then gets paid by a separate wallet.</span></h1>' +
'<p class="lede">No human clicks anything after start. The agent checks its own work before it publishes.</p>' +
'<div class="cta-row">' +
'<a class="cta" href="/demo">Run the live demo' +
'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg>' +
'</a>' +
'<span class="sub-cta">Real onchain execution. Nothing simulated.</span>' +
'</div>' +
'<div class="foot"><span>KeeperHub Agents Onchain Hackathon</span><span>&middot;</span><span>Built solo, no local dev environment</span></div>' +
'</div>' +
'</body></html>');
  });
}
