import WebSocket from 'ws';
import { jetstreamPost, validateItems } from './parsers.mjs';

export const MAX_BYTES = 2 * 1024 * 1024;
export const USER_AGENT = 'TatsumoTrendProbe/0.1 (+https://tatsumosoft.com; source-access-test)';
const headerNames = ['content-type', 'date', 'age', 'cache-control', 'last-modified', 'retry-after', 'ratelimit-remaining', 'x-ratelimit-remaining'];

export function httpStatus(status) {
  if (status === 401) return 'authentication_required';
  if (status === 402) return 'payment_required';
  if (status === 403) return 'access_denied';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  if (status >= 300 && status < 400) return 'redirect';
  if (status >= 200 && status < 300) return 'ok';
  return 'http_error';
}
export function retryAt(value, now = Date.now()) {
  if (!value) return null;
  const time = /^\d+$/.test(value) ? now + Number(value) * 1000 : Date.parse(value);
  return Number.isFinite(time) ? new Date(Math.max(now, time)).toISOString() : null;
}
function base(source) {
  return { id: source.id, name: source.name, endpoint: source.url, protocol: source.protocol,
    checkedAt: new Date().toISOString(), scope: source.scope, caveat: source.caveat, documentation: source.docs,
    status: null, httpStatus: null, durationMs: 0, headers: {}, recordCount: 0, items: [] };
}
export async function readLimited(response, maxBytes = MAX_BYTES) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const parts = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error('RESPONSE_TOO_LARGE');
      }
      parts.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(parts).toString('utf8');
}
export function parseResponse(source, body, contentType = '') {
  // A 200 login/challenge HTML page must never count as usable API data.
  if (/text\/html/i.test(contentType) || /^\s*(?:<!doctype html|<html|<body)/i.test(body)) {
    return { status: 'unexpected_response', detail: 'Received HTML instead of the expected data feed.', items: [] };
  }
  try {
    const data = source.format === 'json' ? JSON.parse(body) : body;
    const items = validateItems(source.parse(data)).slice(0, 100);
    return { status: items.length ? 'ok' : 'empty',
      detail: items.length ? 'Fetched and validated usable records.' : 'Valid response shape, but no records returned.', items };
  } catch {
    return { status: 'invalid_data', detail: 'Response did not match the expected data schema.', items: [] };
  }
}
export async function probeHttp(source, { env = process.env, fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  const result = base(source);
  const credential = source.credential;
  const token = credential ? env[credential.env]?.trim() : null;
  if (credential && !token) {
    return { ...result, status: 'credentials_missing', detail: `Not requested: set ${credential.env} to test this endpoint.` };
  }
  const headers = { 'User-Agent': USER_AGENT, Accept: source.format === 'xml' ? 'application/atom+xml, application/rss+xml, application/xml, text/xml' : 'application/json' };
  if (credential) headers[credential.header] = (credential.prefix || '') + token;
  const started = performance.now();
  try {
    const response = await fetchImpl(source.url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    result.httpStatus = response.status;
    result.headers = Object.fromEntries(headerNames.flatMap(k => response.headers.has(k) ? [[k, response.headers.get(k)]] : []));
    result.status = httpStatus(response.status);
    if (result.status !== 'ok') {
      await response.body?.cancel();
      result.detail = `HTTP ${response.status}; no automatic retry or alternate-host attempt.`;
      if (result.status === 'rate_limited') result.retryAfter = retryAt(result.headers['retry-after']);
    } else {
      Object.assign(result, parseResponse(source, await readLimited(response), result.headers['content-type']));
      result.recordCount = result.items.length;
    }
  } catch (error) {
    result.status = error.name === 'TimeoutError' || error.name === 'AbortError' ? 'timeout' : error.message === 'RESPONSE_TOO_LARGE' ? 'response_too_large' : 'network_error';
    // Avoid copying upstream response bodies, request headers or credential-bearing error strings.
    result.detail = result.status === 'timeout' ? 'Request exceeded its timeout.' : result.status === 'response_too_large' ? 'Response exceeded the 2 MiB limit.' : 'Connection failed before a usable response was received.';
    result.errorCode = /^[A-Z_0-9]+$/.test(error.cause?.code || '') ? error.cause.code : null;
  }
  result.durationMs = Math.round(performance.now() - started);
  return result;
}
export function probeStream(source, { timeoutMs = 12000, sampleMs = 8000, maxItems = 50 } = {}) {
  const result = base(source);
  const started = performance.now();
  return new Promise(resolve => {
    let done = false, opened = false, received = 0, bytes = 0, invalid = 0, sampleTimer;
    const items = new Map();
    const socket = new WebSocket(source.url, { handshakeTimeout: timeoutMs, maxPayload: 65536, headers: { 'User-Agent': USER_AGENT } });
    function finish(status, detail) {
      if (done) return;
      done = true;
      clearTimeout(totalTimer); clearTimeout(sampleTimer);
      socket.terminate();
      resolve({ ...result, status, detail, durationMs: Math.round(performance.now() - started),
        items: [...items.values()], recordCount: items.size, eventsReceived: received, malformedEvents: invalid, bytesReceived: bytes });
    }
    function finishSample(reason) {
      finish(items.size ? 'ok' : invalid ? 'invalid_data' : 'empty', `${reason} Received ${items.size} validated post-create records.`);
    }
    const totalTimer = setTimeout(() => finish(opened ? 'empty' : 'timeout', 'Stream time limit reached.'), timeoutMs + sampleMs);
    socket.on('open', () => {
      opened = true;
      result.httpStatus = 101;
      sampleTimer = setTimeout(() => finishSample('Sample window ended.'), sampleMs);
    });
    socket.on('message', raw => {
      received++; bytes += raw.length;
      if (bytes > MAX_BYTES) return finishSample('Stream byte cap reached.');
      try { const item = jetstreamPost(JSON.parse(raw.toString())); if (item) items.set(item.id, item); }
      catch { invalid++; }
      if (items.size >= maxItems) finishSample('Record cap reached.');
    });
    socket.on('unexpected-response', (_request, response) => {
      result.httpStatus = response.statusCode;
      result.headers = Object.fromEntries(headerNames.flatMap(k => response.headers[k] ? [[k, String(response.headers[k])]] : []));
      if (response.statusCode === 429) result.retryAfter = retryAt(result.headers['retry-after']);
      response.destroy();
      finish(httpStatus(response.statusCode) === 'ok' ? 'unexpected_response' : httpStatus(response.statusCode), `WebSocket handshake returned HTTP ${response.statusCode}.`);
    });
    socket.on('error', () => finish('network_error', 'WebSocket connection failed.'));
    socket.on('close', () => finishSample('Stream closed.'));
  });
}
export function compare(current, previous) {
  if (!previous || current.status !== 'ok' || previous.status !== 'ok') return null;
  if (current.protocol === 'websocket') return { kind: 'independent_samples', detail: 'Stream samples contain different events by design; not a full mention count.' };
  const before = new Map(previous.items.map(i => [i.id, i]));
  const after = new Set(current.items.map(i => i.id));
  return { kind: 'snapshot_diff', previousCheckedAt: previous.checkedAt,
    added: current.items.filter(i => !before.has(i.id)).length,
    removed: previous.items.filter(i => !after.has(i.id)).length,
    changed: current.items.filter(i => before.has(i.id) && JSON.stringify(before.get(i.id)) !== JSON.stringify(i)).length,
    orderChanged: JSON.stringify(current.items.map(i => i.id)) !== JSON.stringify(previous.items.map(i => i.id)) };
}
export async function runRound(sources, previous = [], options = {}) {
  const results = [];
  let redditNext=0;
  for(const prior of previous.filter(r=>r.id.startsWith('reddit-'))) {
    // Waiting results replace earlier attempts in the next round, so carry the
    // original deadline forward without extending it on each skipped check.
    redditNext=Math.max(redditNext,Date.parse(prior.retryAfter||'')||0);
    if(!prior.httpStatus)continue;
    const delay=prior.status==='rate_limited'?15*60000:['access_denied','authentication_required'].includes(prior.status)?3600000:5*60000;
    redditNext=Math.max(redditNext,(Date.parse(prior.checkedAt)||0)+delay,Date.parse(prior.retryAfter||'')||0);
  }
  for (const source of sources) {
    const prior = previous.find(r => r.id === source.id);
    if(source.id.startsWith('reddit-') && Date.now()<redditNext) {
      results.push({...base(source),status:'waiting',skippedThisRound:true,detail:'Shared Reddit cooldown; no additional feed or format requested.',retryAfter:new Date(redditNext).toISOString(),change:null});
      continue;
    }
    // Respect a denial for the remainder of a multi-round run. No retry storm.
    const blocked = ['access_denied', 'authentication_required', 'payment_required'].includes(prior?.status);
    const cooling = prior?.status === 'rate_limited' && (!prior.retryAfter || Date.parse(prior.retryAfter) > Date.now());
    if (blocked || cooling) {
      results.push({ ...prior, skippedThisRound: true, detail: 'Not re-requested this round after earlier denial or rate limit.', change: null });
      continue;
    }
    const result = source.protocol === 'websocket' ? await probeStream(source, options) : await probeHttp(source, options);
    if(source.id.startsWith('reddit-') && result.httpStatus)redditNext=Math.max(Date.now()+(result.status==='rate_limited'?15*60000:['access_denied','authentication_required'].includes(result.status)?3600000:5*60000),Date.parse(result.retryAfter||'')||0);
    result.change = compare(result, prior);
    results.push(result);
    options.onResult?.(result);
  }
  return results;
}
