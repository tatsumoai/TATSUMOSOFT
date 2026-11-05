import WebSocket from 'ws';
import { sources } from '../sources.mjs';
import { probeHttp, probeStream, retryAt, USER_AGENT } from '../probe.mjs';
import { jetstreamPost } from '../parsers.mjs';
import { collectReddit } from './reddit.mjs';

const httpSources = sources.filter(s => ['bluesky-topics','google-trends','mastodon-tags','hacker-news'].includes(s.id));
const streamSource = sources.find(s => s.id === 'bluesky-stream');
export async function collectOnce(store, sample = true, publish = true) {
  for (const source of httpSources) {
    const state = store.db.prepare('SELECT * FROM source_state WHERE source=?').get(source.id);
    if (state?.next_at > Date.now()) continue;
    const result = await probeHttp(source);
    let next = Date.now() + 60000;
    if (result.status === 'rate_limited') next = Math.max(next, Date.parse(result.retryAfter || '') || Date.now() + 15 * 60000);
    if (['access_denied','authentication_required'].includes(result.status)) next = Date.now() + 60 * 60000;
    if (['network_error','timeout','server_error'].includes(result.status)) next = Date.now() + 5 * 60000;
    store.ingest(result);
    store.state(source.id, result.status, result.detail, Date.now(), next);
  }
  await collectReddit(store);
  if (sample) {
    const result = await probeStream(streamSource);
    for (const item of result.items) store.ingestPost(item);
    store.state(streamSource.id, result.status, 'Bounded connectivity sample; continuous collection starts with the server.', Date.now());
  }
  return publish ? store.refresh() : null;
}

export function startStream(store) {
  let socket, reconnect, flushTimer, heartbeat, stopping = false, queue = [], cursor = null, delay = 1000, lastMessage = Date.now();
  function flush() {
    if (!queue.length) return;
    const batch = queue; queue = [];
    // The database handles event replay and repeated authors idempotently.
    for (const item of batch) store.ingestPost(item);
    if (cursor) store.set('streamCursor', cursor);
  }
  function connect() {
    if (stopping) return;
    const url = new URL(streamSource.url);
    const saved = store.get('streamCursor');
    // Recover short disconnects; do not unexpectedly replay an unbounded archive on restart.
    if (saved && saved > (Date.now() - 5 * 60000) * 1000) url.searchParams.set('cursor', String(saved - 2000000));
    socket = new WebSocket(url, { maxPayload: 65536, handshakeTimeout: 12000, headers: { 'User-Agent': USER_AGENT } });
    let denied = false, retryDelay = null;
    socket.on('open', () => { delay = 1000; lastMessage = Date.now(); store.state(streamSource.id, 'connecting', 'Connected; waiting for events.', Date.now()); });
    socket.on('message', raw => {
      lastMessage = Date.now();
      try {
        const event = JSON.parse(raw.toString());
        if (Number.isFinite(event.time_us)) cursor = Math.max(cursor || 0, event.time_us);
        const item = jetstreamPost(event);
        if (item?.tags.length) queue.push(item);
        if (queue.length >= 500) flush();
      } catch { store.state(streamSource.id, 'invalid_data', 'One or more stream events could not be processed.', Date.now()); }
    });
    socket.on('unexpected-response', (_req, res) => {
      denied = [401,403].includes(res.statusCode);
      if (res.statusCode === 429) retryDelay = Math.max(60000, (Date.parse(retryAt(res.headers['retry-after'])) || Date.now() + 15 * 60000) - Date.now());
      store.state(streamSource.id, 'unavailable', `Stream handshake HTTP ${res.statusCode}.`, Date.now());
      res.destroy(); socket.terminate();
    });
    socket.on('error', () => store.state(streamSource.id, 'unavailable', 'Stream connection interrupted; reconnect pending.', Date.now()));
    socket.on('close', () => {
      flush();
      if (!stopping && !denied) { reconnect = setTimeout(connect, retryDelay || delay); delay = Math.min(60000, delay * 2); }
    });
  }
  flushTimer = setInterval(flush, 1000);
  heartbeat = setInterval(() => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastMessage > 60000) { store.state(streamSource.id, 'stale', 'No stream events for over a minute; reconnecting.', Date.now()); socket.terminate(); }
    else store.state(streamSource.id, 'ok', 'Live post stream. Usage counts distinct captured posts; growth compares recent and baseline rates.', Date.now());
  }, 15000);
  connect();
  return () => { stopping = true; clearTimeout(reconnect); clearInterval(flushTimer); clearInterval(heartbeat); socket?.terminate(); flush(); };
}
