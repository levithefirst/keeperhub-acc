// landing.js — single hero screen for the demo video's opening shot.
// Restyled to match /demo's matte-emerald theme. Same layout, only the
// background and color values changed.

export function mountLandingRoute(app) {
  app.get("/landing", (req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.send('<!doctype html><html lang="en"><head>' +
'<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
'<title>keeper-agent</title>' +
'<link rel="preconnect" href="https://fonts.googleapis.com">' +
'<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
'<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">' +
'<style>' +
'*{box-sizing:border-box;margin:0;padding:0}' +
'html,body{height:100%}' +
'body{' +
'background:radial-gradient(1100px 620px at 50% -12%, rgba(16,185,129,.07), transparent 62%),' +
'linear-gradient(180deg,#070b09 0%,#050807 46%);' +
'background-attachment:fixed;' +
'color:#f2f5f3;' +
'font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
'display:flex;align-items:center;justify-content:center;' +
'padding:32px;-webkit-font-smoothing:antialiased}' +
'.wrap{max-width:760px;text-align:left}' +
'h1{font-size:clamp(28px,5vw,46px);font-weight:700;line-height:1.18;' +
'letter-spacing:-.02em;margin-bottom:20px}' +
'p{font-size:clamp(15px,2vw,18px);font-weight:400;line-height:1.5;' +
'color:rgba(226,240,232,.44);max-width:560px}' +
'</style></head><body>' +
'<div class="wrap">' +
'<h1>An agent that builds, verifies, lists, and sells onchain workflows &mdash; ' +
'then gets paid by a separate wallet.</h1>' +
'<p>No human clicks anything after start. The agent checks its own work before it publishes.</p>' +
'</div>' +
'</body></html>');
  });
}
