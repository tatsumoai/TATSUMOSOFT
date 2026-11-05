import { safeUrl } from './parsers.mjs';

export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const e = escapeHtml;
const link = (url, label) => safeUrl(url) ? `<a href="${e(url)}" target="_blank" rel="noopener noreferrer">${e(label)}</a>` : e(label);
export function redact(value, env = process.env) {
  let json = JSON.stringify(value, null, 2);
  for (const name of ['YOUTUBE_API_KEY', 'REDDIT_ACCESS_TOKEN', 'X_BEARER_TOKEN']) {
    const secret = env[name]?.trim();
    if (secret) {
      for (const variant of [secret, encodeURIComponent(secret)]) {
        // Match JSON-escaped credential text too.
        json = json.split(JSON.stringify(variant).slice(1, -1)).join('[REDACTED]');
      }
    }
  }
  return JSON.parse(json);
}
function changeText(change) {
  if (!change) return 'No comparable earlier snapshot in this run.';
  if (change.kind === 'independent_samples') return change.detail;
  return `${change.added} added · ${change.removed} dropped out · ${change.changed} records changed · ${change.orderChanged ? 'list order changed' : 'same list order'}`;
}
export function renderHtml(report) {
  const results = report.rounds.at(-1).results;
  const good = results.filter(r => r.status === 'ok').length;
  const cards = results.map(r => `<article>
    <div class="card-title"><h2>${e(r.name)}</h2><span class="status ${r.status === 'ok' ? 'ok' : r.status === 'credentials_missing' ? 'pending' : 'issue'}">${e(r.status.replaceAll('_', ' '))}</span></div>
    <p>${e(r.scope)}</p>
    <div class="facts"><b>${r.recordCount} records</b><span>HTTP ${e(r.httpStatus ?? '—')}</span><span>${e(r.durationMs)} ms</span><span>${e(r.checkedAt)}</span></div>
    <p>${e(r.detail)}</p><p class="muted">${e(r.caveat)}</p>
    <p class="change">${e(changeText(r.change))}</p>
    <details><summary>Inspect records and request evidence</summary>
      <p class="endpoint">${e(r.endpoint)}</p><p>${link(r.documentation, 'Source documentation')}</p>
      <pre>${e(JSON.stringify(r.headers, null, 2))}</pre>
      ${r.items.length ? `<ol>${r.items.slice(0, 5).map(i => `<li>${link(i.url, i.title)}<br><small>${e(i.publishedAt || 'Source publication time not supplied')}</small><pre>${e(JSON.stringify({ tags: i.tags, metrics: i.metrics, ...(i.history ? { history: i.history } : {}) }, null, 2))}</pre></li>`).join('')}</ol><p class="muted">First five records shown. Full collected sample is in latest.json.</p>` : '<p>No sample records available.</p>'}
    </details></article>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Trend Radar — Source Check</title>
  <style>
  :root{color-scheme:light;--ink:#292321;--muted:#685f5a;--red:#b51631}*{box-sizing:border-box}body{margin:0;background:#faf4e6;color:var(--ink);font:16px/1.55 system-ui,sans-serif}main{max-width:1120px;margin:auto;padding:44px 24px}header{border-bottom:2px solid #dcd2c3;padding-bottom:24px;margin-bottom:24px}h1{font-size:clamp(30px,5vw,48px);letter-spacing:-1.5px;margin:8px 0}h2{font-size:20px;margin:0}.eyebrow{color:var(--red);letter-spacing:.15em;font-size:12px;font-weight:800}.muted,small{color:var(--muted)}.stats{display:flex;flex-wrap:wrap;gap:24px;margin-top:24px}.stats strong{font-size:26px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}article{background:white;border:1px solid #e0d7c9;border-radius:12px;padding:22px;min-width:0}.card-title{display:flex;gap:12px;align-items:start;justify-content:space-between}.status{font-size:11px;text-transform:uppercase;font-weight:800;padding:5px 9px;border-radius:6px;white-space:nowrap}.ok{background:#dff2e6;color:#1d5834}.pending{background:#eeecf4;color:#584776}.issue{background:#f9e4df;color:#8d3022}.facts{display:flex;flex-wrap:wrap;gap:5px 16px;font-size:12px}.facts span:last-child{width:100%;color:var(--muted)}p{margin:14px 0}.change{background:#f5f1e9;padding:10px;font-size:13px;border-radius:5px}summary{cursor:pointer;font-weight:650;color:var(--red)}pre,.endpoint{font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}pre{background:#f8f6f1;padding:10px}a{color:var(--red);overflow-wrap:anywhere}li{padding-bottom:8px}footer{margin-top:28px}button{font:inherit;cursor:pointer;border:1px solid #bfb5a7;background:transparent;border-radius:6px;padding:8px 14px}article[hidden]{display:none}@media(max-width:760px){.grid{grid-template-columns:1fr}.card-title{flex-wrap:wrap}main{padding:24px 16px}}
  </style></head><body><main><header><div class="eyebrow">TATSUMO SOFT / TREND RADAR</div><h1>Which sources can we collect?</h1><p>Real requests, validated samples, and explicit access results.</p>
  <p class="muted">Finished ${e(report.completedAt)} · ${e(report.environment)} · Node ${e(report.nodeVersion)}</p>
  <div class="stats"><span><strong>${good}/${results.length}</strong> returned data</span><span><strong>${report.rounds.length}</strong> check rounds</span><span><strong>${results.reduce((n, r) => n + r.recordCount, 0)}</strong> final-round records</span></div>
  <p class="muted">${e(report.limitations)}</p><button id="toggle" type="button" aria-pressed="false">Show usable sources only</button></header>
  <div class="grid">${cards}</div><footer><h2>Not yet tested</h2>${report.deferred.map(s => `<p><b>${e(s.name)}:</b> ${e(s.reason)}</p>`).join('')}
  <p class="muted">This is an on-demand report. Re-run the probe to refresh it. Records and list changes are source-specific; they are not an internet-wide ranking or proof of trend age.</p></footer></main>
  <script>document.getElementById('toggle').addEventListener('click',function(){const on=this.getAttribute('aria-pressed')!=='true';this.setAttribute('aria-pressed',String(on));this.textContent=on?'Show all sources':'Show usable sources only';document.querySelectorAll('article').forEach(card=>{card.hidden=on&&!card.querySelector('.status.ok')})});</script></body></html>`;
}
