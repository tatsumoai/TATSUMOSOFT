import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/tracker/store.mjs';
import { previewSnapshot } from '../src/tracker/export_preview.mjs';

test('preview retains the recorded ranking and its time window without reranking', () => {
  const recordedAt = Date.parse('2026-11-03T18:00:00Z');
  const store = new Store(':memory:', recordedAt);
  try {
    store.ingest({ id: 'google-trends', status: 'ok', items: [{ title: 'Example topic', url: 'https://example.com/topic' }] }, recordedAt);
    const ranking = store.refresh(recordedAt);
    const originalSummary = store.redditSummary;
    let summaryTime;
    store.redditSummary = function(now) { summaryTime = now; return originalSummary.call(this, now); };
    store.refresh = () => { throw new Error('Export must not rerank'); };
    const exportedAt = recordedAt + 2 * 86400000;
    const preview = previewSnapshot(store, exportedAt);
    assert.equal(preview.updatedAt, ranking.updatedAt);
    assert.equal(preview.windowStart, ranking.windowStart);
    assert.equal(summaryTime, recordedAt, 'Reddit counts use the same snapshot window');
    assert.deepEqual(preview.trends, ranking.trends);
    assert.equal(preview.preview.kind, 'snapshot');
    assert.equal(preview.preview.exportedAt, new Date(exportedAt).toISOString());
    assert.equal(preview.stale, true);
    assert.deepEqual(store.get('ranking'), ranking);
  } finally { store.close(); }
});

test('preview refuses an uncollected database instead of manufacturing a fresh ranking', () => {
  const store = new Store(':memory:');
  try {
    assert.throws(() => previewSnapshot(store), /Collect and rank real data/);
    assert.equal(store.get('ranking'), null);
  } finally { store.close(); }
});
