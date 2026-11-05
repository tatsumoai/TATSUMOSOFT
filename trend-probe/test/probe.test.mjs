import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { sources } from '../src/sources.mjs';
import { googleTrends, reddit, validateItems, jetstreamPost } from '../src/parsers.mjs';
import { probeHttp, probeStream, runRound, compare, readLimited, retryAt } from '../src/probe.mjs';
import { redact, renderHtml } from '../src/report.mjs';

const source = sources.find(s => s.id === 'hacker-news');
const result = (items, extra = {}) => ({ id: source.id, name: source.name, status: 'ok', protocol: 'http', items, checkedAt: new Date().toISOString(), ...extra });
const item = { id: '1', title: 'Example', metrics: { points: 2 } };

test('valid JSON produces usable records, HTML 200 and wrong JSON do not', async () => {
  for (const [body, type, expected] of [
    [JSON.stringify({ hits: [{ objectID: '1', title: 'Real title', points: 2 }] }), 'application/json', 'ok'],
    ['<html>Sign in</html>', 'text/html', 'unexpected_response'],
    ['{"error":"login"}', 'application/json', 'invalid_data'],
    ['{"hits":[]}', 'application/json', 'empty'],
    ['{"hits":[{}]}', 'application/json', 'invalid_data']
  ]) {
    const actual = await probeHttp(source, { fetchImpl: async () => new Response(body, { headers: { 'content-type': type } }) });
    assert.equal(actual.status, expected);
  }
});
test('HTTP errors keep status and retry guidance without saving body or credentials', async () => {
  const actual = await probeHttp(source, { fetchImpl: async () => new Response('private error content', { status: 429, headers: { 'Retry-After': '120' } }) });
  assert.equal(actual.status, 'rate_limited');
  assert.equal(actual.httpStatus, 429);
  assert.ok(Date.parse(actual.retryAfter) >= Date.now() + 115000);
  assert.ok(!JSON.stringify(actual).includes('private error content'));
  assert.equal(retryAt('Wed, 21 Oct 2099 07:28:00 GMT'), '2099-10-21T07:28:00.000Z');
});
test('missing credentials make no request', async () => {
  const actual = await probeHttp(sources.find(s => s.id === 'youtube'), { env: {}, fetchImpl: () => assert.fail('must not fetch') });
  assert.equal(actual.status, 'credentials_missing');
  assert.equal(actual.httpStatus, null);
});
test('denied requests are not retried during subsequent rounds', async () => {
  const previous = [result([], { status: 'access_denied' })];
  const [actual] = await runRound([source], previous, { fetchImpl: () => assert.fail('must not retry') });
  assert.equal(actual.skippedThisRound, true);
  assert.equal(actual.checkedAt, previous[0].checkedAt);
});
test('rate limiting with no retry timestamp stops further requests in this run', async () => {
  const [actual] = await runRound([source], [result([], { status: 'rate_limited' })], { fetchImpl: () => assert.fail('must not retry') });
  assert.equal(actual.skippedThisRound, true);
});

test('Reddit formats share one cooldown across repeated probe rounds', async () => {
  const selected=sources.filter(s=>s.id.startsWith('reddit-'));
  assert.ok(selected.length>=2);
  let calls=0;
  const options={env:{REDDIT_ACCESS_TOKEN:'test-token'},fetchImpl:async()=>{
    calls++;
    return new Response('slow down',{status:429,headers:{'Retry-After':'1800'}});
  }};
  const first=await runRound(selected,[],options);
  assert.equal(calls,1,'a limit must not trigger a different Reddit format');
  const second=await runRound(selected,first,options);
  const third=await runRound(selected,second,options);
  assert.equal(calls,1,'the deadline survives rounds made entirely of waiting results');
  assert.ok(third.every(r=>r.status==='waiting' && r.retryAfter===first[0].retryAfter));
});
test('bounded bodies and timeouts are distinguished from invalid source data', async () => {
  await assert.rejects(readLimited(new Response('x'.repeat(20)), 10), /RESPONSE_TOO_LARGE/);
  const actual = await probeHttp(source, { fetchImpl: () => { throw new DOMException('timeout', 'TimeoutError'); } });
  assert.equal(actual.status, 'timeout');
});
test('RSS handles single items, CDATA, entities, namespaced metrics and timestamps', () => {
  const rows = googleTrends('<rss><channel><item><title><![CDATA[Cats & hats]]></title><link>https://example.com/?a=1&amp;b=2</link><pubDate>Tue, 03 Nov 2026 12:00:00 GMT</pubDate><ht:approx_traffic>2,000+</ht:approx_traffic></item></channel></rss>');
  assert.equal(rows[0].title, 'Cats & hats');
  assert.equal(rows[0].metrics.approximateTraffic, '2,000+');
  assert.equal(rows[0].publishedAt, '2026-11-03T12:00:00.000Z');
  assert.equal(rows[0].url, 'https://example.com/?a=1&b=2');
  assert.throws(() => googleTrends('<!DOCTYPE rss><rss/>'));
  assert.throws(() => googleTrends('<not-rss/>'));
});
test('post IDs deduplicate Reddit records without adding their score twice', () => {
  const p = { data: { name: 't3_abc', title: 'Test', created_utc: 1793707200, permalink: '/r/memes/comments/abc/', score: 5, num_comments: 2 } };
  const items = validateItems(reddit({ data: { children: [p, p] } }));
  assert.equal(items.length, 1);
  assert.equal(items[0].metrics.score, 5);
});
test('snapshot comparison measures adds, drops, metric changes and order changes', () => {
  const change = compare(result([{ ...item, metrics: { points: 3 } }, { ...item, id: '3' }]), result([item, { ...item, id: '2' }]));
  assert.deepEqual([change.added, change.removed, change.changed, change.orderChanged], [1, 1, 1, true]);
  assert.equal(compare(result([], { status: 'empty' }), result([item])), null);
});
const postEvent = { kind: 'commit', did: 'did:plc:example', commit: { operation: 'create', collection: 'app.bsky.feed.post', rkey: '123', record: { text: 'A new #trend', createdAt: '2026-11-03T12:00:00Z', facets: [{ features: [{ $type: 'app.bsky.richtext.facet#tag', tag: 'trend' }] }] } } };
test('stream parser extracts hashtags and ignores deletes', () => {
  assert.deepEqual(jetstreamPost(postEvent).tags, ['trend']);
  assert.equal(jetstreamPost({ ...postEvent, commit: { ...postEvent.commit, operation: 'delete' } }), null);
});
test('real local WebSocket validates and caps event collection', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  server.on('connection', socket => socket.send(JSON.stringify(postEvent)));
  try {
    const actual = await probeStream({ ...source, protocol: 'websocket', url: `ws://127.0.0.1:${server.address().port}` }, { maxItems: 1, sampleMs: 1000 });
    assert.equal(actual.status, 'ok');
    assert.equal(actual.recordCount, 1);
    assert.equal(actual.httpStatus, 101);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('report escapes untrusted text and URLs and redacts known credentials', () => {
  const report = { rounds: [{ results: [{ ...result([{ ...item, title: '<script>alert(1)</script>', url: 'javascript:alert(1)' }]), recordCount: 1, headers: {}, status: 'ok' }] }], deferred: [] };
  const html = renderHtml(report);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.equal(redact({ message: 'contains secret-token' }, { X_BEARER_TOKEN: 'secret-token' }).message, 'contains [REDACTED]');
});
