export const DAY = 86400000, HOUR = 3600000, WINDOW = 14 * DAY;
export const iso = time => new Date(time).toISOString();
export function canonical(text) {
  return String(text).normalize('NFKC').toLowerCase().replace(/^#+/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}
export function sixMonthsAgo(now) {
  const d = new Date(now), day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 6);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}
export function ageLabel(evidence, now) {
  const valid = evidence.filter(e => Number.isFinite(e.occurred_at) && e.occurred_at <= now);
  if (valid.some(e => e.occurred_at < sixMonthsAgo(now))) return 'legacy';
  if (valid.length) return 'new';
  return 'unknown';
}
const family = source => source.startsWith('bluesky') ? 'Bluesky' : ({ 'reddit-posts':'Reddit', 'google-trends': 'Google Trends', 'mastodon-tags': 'Mastodon', 'hacker-news': 'Hacker News' }[source] || source);
export function rankCandidates(trends, signals, evidence, now, startedAt, previous = [], coverage = [], sourceDates = [], limit = 100) {
  const groups = new Map();
  const proofByTrend = new Map(), datesByTrend = new Map();
  for (const record of evidence) {
    if (!proofByTrend.has(record.trend_id)) proofByTrend.set(record.trend_id, []);
    proofByTrend.get(record.trend_id).push(record);
  }
  for (const record of sourceDates) {
    if (record.at > now) continue;
    if (!datesByTrend.has(record.trend_id)) datesByTrend.set(record.trend_id, []);
    datesByTrend.get(record.trend_id).push(record);
  }
  for (const s of signals) {
    if (s.at <= now - WINDOW || s.at > now) continue;
    if (!groups.has(s.trend_id)) groups.set(s.trend_id, []);
    groups.get(s.trend_id).push(s);
  }
  const previousRanks = new Map(previous.map(t => [t.id, t.rank]));
  const rows = [];
  for (const t of trends) {
    const activity = groups.get(t.id);
    if (!activity) continue;
    const authors = new Set(activity.filter(s => s.kind === 'post').map(s => s.signal_key));
    if (!activity.some(s => s.kind !== 'post') && authors.size < 3) continue;
    const bySource = new Map(), recent = new Map(), prior = new Map();
    const daily = Array(14).fill(0);
    for (const s of activity) {
      const f = family(s.source), age = now - s.at;
      bySource.set(f, (bySource.get(f) || 0) + s.weight * Math.pow(0.5, age / (48 * HOUR)));
      const slot = Math.min(13, Math.floor(age / DAY)); daily[13 - slot] += s.weight;
      const map = age < 6 * HOUR ? recent : age < 48 * HOUR ? prior : null;
      if (map) map.set(f, (map.get(f) || 0) + s.weight);
    }
    // Compare like-for-like sources. No acceleration claim during the first 48h.
    let momentum = null;
    const activeSources = [...new Set(activity.map(s => s.source))];
    const baselineReady = activeSources.every(source => {
      const hours = coverage.filter(c => c.source === source && c.bucket >= now - 48 * HOUR && c.bucket <= now);
      return hours.length >= 36 && hours.filter(c => c.bucket >= now - 6 * HOUR).length >= 4;
    });
    if (now - startedAt >= 48 * HOUR && baselineReady) {
      const a = [...recent.values()].reduce((n, v) => n + Math.log1p(v / 6), 0);
      const b = [...prior.values()].reduce((n, v) => n + Math.log1p(v / 42), 0);
      momentum = Math.max(-1, Math.min(2, (a - b) / Math.max(0.5, b)));
    }
    const base = [...bySource.values()].reduce((n, v) => n + Math.log1p(v), 0);
    const score = 10 * base * (1 + 0.15 * (bySource.size - 1)) * (1 + 0.2 * Math.max(0, momentum || 0));
    const proof = proofByTrend.get(t.id) || [];
    const history = (datesByTrend.get(t.id) || []).sort((a,b)=>a.at-b.at);
    const ageProof = [...proof,...history.map(e=>({kind:'occurrence',occurred_at:e.at}))];
    const oldest = ageProof.length ? Math.min(...ageProof.map(e=>e.occurred_at)) : null;
    const newest = activity.reduce((a, b) => a.at > b.at ? a : b);
    rows.push({ id: t.id, name: t.name, key: t.canonical, kind: t.kind, score: Math.round(score * 100) / 100,
      age: ageLabel(ageProof, now), evidence: proof.map(e => ({ date: iso(e.occurred_at).slice(0, 10), kind: e.kind, url: e.url, note: e.note })),
      ageEstimated: ageLabel(ageProof, now) === 'new' && !proof.some(e => e.kind === 'origin' && Number.isFinite(e.occurred_at) && e.occurred_at <= now),
      earliestKnownAt: oldest===null?null:iso(oldest),
      sourceHistory: history.map(e=>({source:family(e.source),sourceId:e.source,kind:e.kind,date:iso(e.at),precision:e.precision,url:e.url})),
      firstObservedAt: iso(t.first_observed), lastActiveAt: iso(newest.at), url: newest.url,
      sources: [...bySource.keys()], independentAuthors: authors.size, momentum,
      dailyActivity: daily.map(n => Math.round(n * 100) / 100) });
  }
  rows.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  return rows.slice(0, limit).map((r, i) => ({ ...r, rank: i + 1, movement: previousRanks.has(r.id) ? previousRanks.get(r.id) - i - 1 : null }));
}
