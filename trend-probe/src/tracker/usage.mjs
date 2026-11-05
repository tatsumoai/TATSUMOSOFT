import { DAY, iso } from './model.mjs';

// Keep provider aggregates and captured posts separate: their scopes and clocks differ.
export function summarizeUsage(trend, dailyRows, postRows, now, countingSince, replay) {
  const today = Math.floor(now / DAY) * DAY;
  const sourceRows = dailyRows.filter(r => r.trend_id === trend.id);
  const postBuckets = postRows.filter(r => r.trend_id === trend.id);
  const summaries = [];
  const days = Array.from({ length: 14 }, (_, i) => today - (13 - i) * DAY);
  const byDay = new Map(sourceRows.map(r => [r.day, r]));
  const known = days.filter(day => byDay.has(day));
  if (known.length) {
    const previous = byDay.get(today - DAY);
    summaries.push({ source: 'mastodon.social', sourceId: 'mastodon-tags', unit: 'uses',
      kind: 'provider_daily', total: known.reduce((sum, day) => sum + byDay.get(day).uses, 0),
      daysAvailable: known.length, windowDays: 14, periodStart: iso(known[0]),
      periodEnd: iso(Math.min(now, known.at(-1) + DAY)),
      lastFullDay: previous ? { date: iso(today - DAY).slice(0, 10), count: previous.uses } : null,
      lastCheckedAt: iso(Math.max(...known.map(day => byDay.get(day).checked_at))),
      points: days.map(day => ({ start: iso(day), end: iso(Math.min(day + DAY, now)),
        count: byDay.has(day) ? byDay.get(day).uses : null, partial: day === today })) });
  }
  const countable = trend.kind === 'tag' || trend.sourceHistory.some(h => h.sourceId === 'bluesky-stream');
  if (countable) {
    const backfilled = replay?.status === 'imported';
    const since = backfilled ? Math.min(countingSince, replay.earliestStart ?? replay.start) : countingSince;
    const bySlot = new Map(postBuckets.map(r => [r.slot, r.uses]));
    summaries.push({ source: 'Bluesky', sourceId: 'bluesky-stream', unit: 'posts', kind: 'captured_posts',
      total: postBuckets.reduce((sum, row) => sum + row.uses, 0),
      last24h: bySlot.get(0) || 0, periodStart: iso(Math.max(now - 14 * DAY, since)), periodEnd: iso(now),
      backfillStart: backfilled ? iso(replay.start) : null, backfillEnd: backfilled ? iso(replay.end) : null,
      points: Array.from({ length: 14 }, (_, i) => {
        const start = now - (14 - i) * DAY, end = start + DAY;
        return { start: iso(start), end: iso(end), count: end <= since ? null : bySlot.get(13 - i) || 0,
          partial: true };
      }) });
  }
  return summaries;
}
