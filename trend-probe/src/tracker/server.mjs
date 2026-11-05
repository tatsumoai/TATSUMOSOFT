import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openStore, databasePath } from './runtime.mjs';
import { collectOnce, startStream } from './collector.mjs';
export function createHandler(store) {
  const assets = new Map([
    ['/', ['../../../index.html','text/html']],
    ['/tracker.css', ['../../../tracker.css','text/css']],
    ['/tracker.js', ['../../../tracker.js','text/javascript']],
    ['/trend-preview.json', ['../../../trend-preview.json','application/json']],
    ...['Tatsumo_Long.png','headshot.png','HIREWALL.png','ILYSIA.png','FATFOODS.png','LOTT.png','SPIRITS.png','favicon.ico'].map(name => ['/'+name, ['../../../'+name,name.endsWith('.ico') ? 'image/x-icon' : 'image/png']])
  ]);
  return async (req,res) => {
    const send = (code, data) => { res.writeHead(code, {'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(JSON.stringify(data)); };
    try {
      if (req.method !== 'GET') return send(405, {error:'Read-only API'});
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/api/trends') return send(200, store.publicRanking());
      if (url.pathname === '/api/health') return send(200, {ok:true, database:'ready', ...store.publicRanking().sources.reduce((a,s) => ({...a,[s.id]:s.status}),{})});
      const asset = assets.get(url.pathname);
      if (!asset) return send(404, {error:'Not found'});
      const data = await readFile(new URL(asset[0], import.meta.url));
      res.writeHead(200, {'Content-Type':asset[1]+'; charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'}); res.end(data);
    } catch { if (!res.headersSent) send(500, {error:'Unable to load tracker data'}); else res.end(); }
  };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const store = openStore();
  let busy = false, stopping = false;
  const update = async () => { if (busy || stopping) return; busy = true; try { await collectOnce(store, false, false); } catch (e) { console.error('Collection failed:', e.message); } finally { busy = false; } };
  const server = createServer(createHandler(store));
  const port = Number(process.env.TREND_PORT || 8794);
  server.listen(port, '127.0.0.1', () => console.log(`Trend Radar: http://127.0.0.1:${port}/#trend-radar\nDatabase: ${databasePath}`));
  const stopStream = startStream(store);
  void update().then(() => { if (!stopping) store.refresh(); });
  const collectTimer = setInterval(update, 5000);
  const rankTimer = setInterval(() => store.refresh(), 60000);
  const shutdown = async () => {
    if (stopping) return; stopping = true; clearInterval(collectTimer); clearInterval(rankTimer); stopStream();
    server.close();
    while (busy) await new Promise(resolve => setTimeout(resolve,100));
    store.refresh(); store.close();
  };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
