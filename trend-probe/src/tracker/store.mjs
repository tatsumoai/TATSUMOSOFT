import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonical, HOUR, WINDOW, DAY, rankCandidates, iso } from './model.mjs';
import { summarizeUsage } from './usage.mjs';
import { mergeRanges, rankByGrowth } from './growth.mjs';
import { redditTerms, redditGrowthRows, redditUsage } from './reddit.mjs';
import { redditDiscoverySummary, redditTopicCandidates } from './reddit-discovery.mjs';
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 32);

export class Store {
  constructor(path, now = Date.now()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.statements = new Map();
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trends (id INTEGER PRIMARY KEY, canonical TEXT UNIQUE NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, first_observed INTEGER);
      CREATE TABLE IF NOT EXISTS aliases (alias TEXT PRIMARY KEY, trend_id INTEGER NOT NULL REFERENCES trends(id));
      CREATE TABLE IF NOT EXISTS evidence (trend_id INTEGER NOT NULL REFERENCES trends(id), occurred_at INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('origin','occurrence')), url TEXT NOT NULL, note TEXT NOT NULL, PRIMARY KEY(trend_id,url,occurred_at));
      CREATE TABLE IF NOT EXISTS signals (trend_id INTEGER NOT NULL REFERENCES trends(id), source TEXT NOT NULL, bucket INTEGER NOT NULL, signal_key TEXT NOT NULL, at INTEGER NOT NULL, weight REAL NOT NULL, kind TEXT NOT NULL, url TEXT, PRIMARY KEY(trend_id,source,bucket,signal_key));
      CREATE INDEX IF NOT EXISTS signal_age ON signals(at);
      CREATE TABLE IF NOT EXISTS seen_posts (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS post_age ON seen_posts(at);
      CREATE TABLE IF NOT EXISTS post_usage (trend_id INTEGER NOT NULL REFERENCES trends(id),post_id TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(trend_id,post_id));
      CREATE INDEX IF NOT EXISTS usage_age ON post_usage(at);
      CREATE TABLE IF NOT EXISTS daily_usage (trend_id INTEGER NOT NULL REFERENCES trends(id),day INTEGER NOT NULL,uses INTEGER NOT NULL,checked_at INTEGER NOT NULL,PRIMARY KEY(trend_id,day));
      CREATE TABLE IF NOT EXISTS reddit_posts (id TEXT PRIMARY KEY,title TEXT NOT NULL,url TEXT,community TEXT NOT NULL,published_at INTEGER NOT NULL,first_observed INTEGER NOT NULL,checked_at INTEGER NOT NULL,score INTEGER,comments INTEGER);
      CREATE INDEX IF NOT EXISTS reddit_post_age ON reddit_posts(published_at);
      CREATE TABLE IF NOT EXISTS reddit_terms (term TEXT NOT NULL,post_id TEXT NOT NULL REFERENCES reddit_posts(id) ON DELETE CASCADE,PRIMARY KEY(term,post_id));
      CREATE INDEX IF NOT EXISTS reddit_terms_post ON reddit_terms(post_id);
      CREATE TABLE IF NOT EXISTS reddit_usage (trend_id INTEGER NOT NULL REFERENCES trends(id),post_id TEXT NOT NULL REFERENCES reddit_posts(id) ON DELETE CASCADE,PRIMARY KEY(trend_id,post_id));
      CREATE TABLE IF NOT EXISTS reddit_fetches (feed_key TEXT NOT NULL,checked_at INTEGER NOT NULL,label TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,items INTEGER NOT NULL,PRIMARY KEY(feed_key,checked_at));
      CREATE TABLE IF NOT EXISTS reddit_observations (feed_key TEXT NOT NULL,post_id TEXT NOT NULL REFERENCES reddit_posts(id) ON DELETE CASCADE,observed_at INTEGER NOT NULL,position INTEGER NOT NULL,score INTEGER,comments INTEGER,PRIMARY KEY(feed_key,post_id,observed_at));
      CREATE INDEX IF NOT EXISTS reddit_observation_post ON reddit_observations(post_id,observed_at);
      CREATE TABLE IF NOT EXISTS source_state (source TEXT PRIMARY KEY, checked_at INTEGER, success_at INTEGER, status TEXT, detail TEXT, next_at INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS coverage (source TEXT NOT NULL,bucket INTEGER NOT NULL,PRIMARY KEY(source,bucket));
      CREATE TABLE IF NOT EXISTS source_dates (trend_id INTEGER NOT NULL REFERENCES trends(id),source TEXT NOT NULL,kind TEXT NOT NULL,at INTEGER NOT NULL,precision TEXT NOT NULL,url TEXT,PRIMARY KEY(trend_id,source,kind));`);
    if (this.prepare('PRAGMA user_version').get().user_version < 2) {
      this.transaction(() => {
        // Existing post/day timestamps are real source evidence; listing timestamps are only fetch times.
        const groups=this.prepare("SELECT trend_id,source,kind,MIN(at) at FROM signals WHERE kind IN ('post','daily_accounts') GROUP BY trend_id,source,kind").all();
        for (const g of groups) {
          const record=this.prepare('SELECT url FROM signals WHERE trend_id=? AND source=? AND kind=? AND at=? LIMIT 1').get(g.trend_id,g.source,g.kind,g.at);
          this.rememberDate(g.trend_id,g.source,g.kind==='post'?'post_published':'usage_day',g.at,g.kind==='post'?'instant':'day',record?.url,now);
        }
        this.db.exec('PRAGMA user_version=2');
      });
    }
    if (!this.get('startedAt')) this.set('startedAt', now);
    // Old ranking signals were author-capped, so they cannot reconstruct raw post totals.
    if (!this.get('usageCountingSince')) this.set('usageCountingSince', now);
  }
  prepare(query) {
    if (!this.statements.has(query)) this.statements.set(query, this.db.prepare(query));
    return this.statements.get(query);
  }
  get(key) { const r = this.prepare('SELECT value FROM meta WHERE key=?').get(key); return r ? JSON.parse(r.value) : null; }
  set(key, value) { this.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  transaction(fn) {
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE'); this.inTransaction = true;
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch(e) { this.db.exec('ROLLBACK'); throw e; }
    finally { this.inTransaction = false; }
  }
  trend(name, kind, now) {
    const key = canonical(name);
    if (!key || key.length > 200 || key.length < 2) return null;
    const alias = this.prepare('SELECT trend_id FROM aliases WHERE alias=?').get(key);
    if (alias) { if (now !== null) this.prepare('UPDATE trends SET first_observed=COALESCE(first_observed,?) WHERE id=?').run(now,alias.trend_id); return alias.trend_id; }
    this.prepare('INSERT OR IGNORE INTO trends(canonical,name,kind,first_observed) VALUES(?,?,?,?)').run(key, String(name).slice(0, 200), kind, now);
    const id = this.prepare('SELECT id FROM trends WHERE canonical=?').get(key).id;
    if (now !== null) this.prepare('UPDATE trends SET first_observed=COALESCE(first_observed,?) WHERE id=?').run(now,id);
    return id;
  }
  addEvidence({ name, aliases = [], date, kind, url, note }, now = Date.now()) {
    const time = Date.parse(date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(time) || iso(time).slice(0, 10) !== date || time > now) throw new Error('Evidence needs a valid non-future YYYY-MM-DD date');
    if (!['origin','occurrence'].includes(kind) || !/^https?:\/\//.test(url) || !note?.trim()) throw new Error('Evidence requires kind, source URL, and an explanatory note');
    return this.transaction(() => {
      const id = this.trend(name, 'topic', null);
      if (!id) throw new Error('Invalid topic name');
      for (const alias of aliases) {
        const key = canonical(alias);
        const existing = this.prepare('SELECT id FROM trends WHERE canonical=? UNION SELECT trend_id AS id FROM aliases WHERE alias=?').all(key, key);
        if (existing.some(x => x.id !== id)) throw new Error(`Alias already belongs to a different trend: ${alias}`);
        this.prepare('INSERT OR IGNORE INTO aliases VALUES(?,?)').run(key, id);
      }
      this.prepare('INSERT INTO evidence VALUES(?,?,?,?,?) ON CONFLICT(trend_id,url,occurred_at) DO UPDATE SET kind=excluded.kind,note=excluded.note').run(id, time, kind, url, note);
      return id;
    });
  }
  signal({ id, source, at, weight, key = 'listing', kind = 'listing', url, daily = false }, now) {
    if (id === null || at <= now - WINDOW || at > now || !Number.isFinite(weight) || weight < 0) return;
    const bucket = Math.floor(at / (daily ? DAY : HOUR)) * (daily ? DAY : HOUR);
    if (weight === 0) { this.prepare('DELETE FROM signals WHERE trend_id=? AND source=? AND bucket=? AND signal_key=?').run(id,source,bucket,key); return; }
    this.prepare(`INSERT INTO signals VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(trend_id,source,bucket,signal_key) DO UPDATE SET
      weight=excluded.weight,at=MAX(signals.at,excluded.at),url=CASE WHEN excluded.at>=signals.at THEN excluded.url ELSE signals.url END`).run(id, source, bucket, key, at, weight, kind, url || null);
  }
  rememberDate(id, source, kind, at, precision, url, now) {
    if (id===null || !Number.isFinite(at) || at<=0 || at>now) return;
    this.prepare(`INSERT INTO source_dates VALUES(?,?,?,?,?,?)
      ON CONFLICT(trend_id,source,kind) DO UPDATE SET at=excluded.at,precision=excluded.precision,url=excluded.url
      WHERE excluded.at < source_dates.at`).run(id,source,kind,at,precision,url||null);
  }
  ingest(result, now = Date.now()) {
    if (!['ok','empty'].includes(result.status)) return;
    this.transaction(() => {
      for (const [index, item] of result.items.entries()) {
        const id = this.trend(item.title, result.id === 'mastodon-tags' ? 'tag' : result.id === 'hacker-news' ? 'story' : 'topic', now);
        if (result.id === 'mastodon-tags') {
          for (const day of item.history || []) {
            const at = day.dayUnix * 1000;
            if (id !== null && Number.isFinite(at) && at > now-WINDOW && at <= now && Number.isSafeInteger(day.uses) && day.uses >= 0) {
              this.prepare('INSERT INTO daily_usage VALUES(?,?,?,?) ON CONFLICT(trend_id,day) DO UPDATE SET uses=excluded.uses,checked_at=excluded.checked_at').run(id,at,day.uses,now);
            }
            if ((day.uses || 0)>0 || (day.accounts || 0)>0) this.rememberDate(id,result.id,'usage_day',at,'day',item.url,now);
            this.signal({ id, source: result.id, at, weight: Math.log1p(Math.max(0, day.accounts || 0)), kind: 'daily_accounts', url: item.url, daily: true }, now);
          }
        } else {
          if (item.publishedAt) this.rememberDate(id,result.id,result.id==='google-trends'?'trend_feed_published':'story_published',Date.parse(item.publishedAt),'instant',item.url,now);
          // One listing observation per hour. Refreshing the same listing never adds mentions.
          this.signal({ id, source: result.id, at: now, weight: 1 / Math.log2(index + 2), url: item.url }, now);
        }
      }
    });
  }
  ingestPost(item, now = Date.now()) {
    const time = Date.parse(item.publishedAt);
    if (!Number.isFinite(time) || time <= now - WINDOW || time > now + 60000 || !item.tags?.length) return;
    this.transaction(() => {
      const fresh = this.prepare('INSERT OR IGNORE INTO seen_posts VALUES(?,?)').run(hash(item.id), Math.min(time,now)).changes;
      const author = hash(item.id.split('/')[2]);
      for (const [index,tag] of [...new Set(item.tags)].entries()) {
        const id = this.trend(tag, 'tag', now);
        if (id !== null) this.prepare('INSERT OR IGNORE INTO post_usage VALUES(?,?,?)').run(id,hash(item.id),Math.min(time,now));
        // Replay can restore usage missing from old author-capped records without inflating rank.
        if (!fresh || index >= 5) continue;
        this.rememberDate(id,'bluesky-stream','post_published',time,'instant',item.url,now);
        this.signal({ id, source: 'bluesky-stream', at: Math.min(time, now), weight: 1, key: author, kind: 'post', url: item.url }, now);
      }
    });
  }
  ingestReddit(items, community, now = Date.now()) {
    this.transaction(()=>{
      for(const item of items) {
        const published=Date.parse(item.publishedAt);
        if(!/^t3_[a-z0-9]+$/i.test(item.id) || !item.title || !Number.isFinite(published) || published<=now-WINDOW || published>now)continue;
        const actualCommunity=(item.community||community||'').replace(/^r\//i,'').toLowerCase();
        if(!/^[a-z0-9_]{2,21}$/.test(actualCommunity)||['all','popular'].includes(actualCommunity))continue;
        this.prepare(`INSERT INTO reddit_posts VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
          title=excluded.title,url=excluded.url,community=excluded.community,checked_at=excluded.checked_at,score=COALESCE(excluded.score,reddit_posts.score),comments=COALESCE(excluded.comments,reddit_posts.comments)`)
          .run(item.id,item.title.slice(0,1000),item.url||null,actualCommunity,published,now,now,item.metrics?.score??null,item.metrics?.comments??null);
        this.prepare('DELETE FROM reddit_terms WHERE post_id=?').run(item.id);
        this.prepare('DELETE FROM reddit_usage WHERE post_id=?').run(item.id);
        this.prepare("DELETE FROM signals WHERE source='reddit-posts' AND signal_key=?").run(item.id);
        for(const term of redditTerms(item.title,actualCommunity))this.prepare('INSERT OR IGNORE INTO reddit_terms VALUES(?,?)').run(term,item.id);
      }
      this.set('redditDirty',true);
      if(!this.get('redditCollectingSince'))this.set('redditCollectingSince',now);
    });
  }
  syncRedditTopics(now) {
    if(!this.get('redditDirty'))return;
    const qualified=this.get('redditStrategy')==='broad'?new Set(redditTopicCandidates(this,now,Infinity).map(t=>t.name)):null;
    this.transaction(()=>{
      for(const {term,n} of this.prepare('SELECT term,COUNT(*) n FROM reddit_terms GROUP BY term').all()) {
        let id=this.prepare('SELECT trend_id id FROM aliases WHERE alias=? UNION SELECT id FROM trends WHERE canonical=? LIMIT 1').get(term,term)?.id;
        // Existing topics can gain corroborating Reddit evidence immediately.
        // Newly discovered phrases require separate posts before becoming candidates.
        if(!id && n>=3 && (!qualified || qualified.has(term)))id=this.trend(term,'phrase',now);
        if(!id)continue;
        for(const p of this.prepare('SELECT p.* FROM reddit_posts p JOIN reddit_terms t ON t.post_id=p.id WHERE t.term=?').all(term)) {
          this.prepare('INSERT OR IGNORE INTO reddit_usage VALUES(?,?)').run(id,p.id);
          this.rememberDate(id,'reddit-posts','post_published',p.published_at,'instant',p.url,now);
          this.signal({id,source:'reddit-posts',at:p.published_at,weight:1,key:p.id,kind:'reddit_post',url:p.url},now);
        }
      }
      this.set('redditDirty',false);
    });
  }
  redditSummary(now=Date.now()) {
    const counts=this.prepare('SELECT COUNT(*) total,COALESCE(SUM(published_at>?),0) last24h FROM reddit_posts WHERE published_at>? AND published_at<=?').get(now-DAY,now-WINDOW,now);
    return {...counts,communities:this.get('redditCommunities')||[],mode:this.get('redditMode')||'Public RSS',
      collectingSince:this.get('redditCollectingSince')?iso(this.get('redditCollectingSince')):null,...redditDiscoverySummary(this,now),
      recentPosts:this.prepare('SELECT title,url,community,published_at FROM reddit_posts WHERE published_at>? AND published_at<=? ORDER BY published_at DESC LIMIT 5').all(now-WINDOW,now)};
  }
  state(source, status, detail, now, nextAt = 0) {
    if(source==='bluesky-stream' && status==='ok') {
      const previous=this.prepare('SELECT status,success_at FROM source_state WHERE source=?').get(source);
      if(previous?.status==='ok' && now>previous.success_at && now-previous.success_at<=45000) {
        const ranges=mergeRanges([...(this.get('streamUsageCoverage')||[]),[previous.success_at,now]]).filter(([,end])=>end>now-WINDOW);
        this.set('streamUsageCoverage',ranges);
      }
    }
    if (['ok','empty'].includes(status)) this.prepare('INSERT OR IGNORE INTO coverage VALUES(?,?)').run(source,Math.floor(now/HOUR)*HOUR);
    this.prepare(`INSERT INTO source_state VALUES(?,?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET checked_at=excluded.checked_at,
      success_at=COALESCE(excluded.success_at,source_state.success_at),status=excluded.status,detail=excluded.detail,next_at=excluded.next_at`).run(source, now, ['ok','empty'].includes(status) ? now : null, status, detail, nextAt);
  }
  prune(now) {
    this.transaction(() => {
      this.prepare('DELETE FROM signals WHERE at <= ?').run(now - WINDOW);
      this.prepare('DELETE FROM seen_posts WHERE at <= ?').run(now - WINDOW);
      this.prepare('DELETE FROM post_usage WHERE at <= ?').run(now - WINDOW);
      this.prepare('DELETE FROM daily_usage WHERE day <= ?').run(now - WINDOW);
      this.prepare('DELETE FROM reddit_posts WHERE published_at <= ?').run(now - WINDOW);
      this.prepare('DELETE FROM reddit_observations WHERE observed_at <= ?').run(now - WINDOW);
      this.prepare('DELETE FROM reddit_fetches WHERE checked_at <= ?').run(now - WINDOW);
      this.prepare('DELETE FROM coverage WHERE bucket <= ?').run(now - WINDOW);
    });
    // Identifiers, aliases and dated evidence intentionally survive activity expiry.
  }
  refresh(now = Date.now()) {
    this.prune(now);
    this.syncRedditTopics(now);
    const oldRanking = this.get('ranking');
    const previous = oldRanking?.rankingMode==='growth' ? oldRanking.trends : [];
    const signals = this.prepare('SELECT * FROM signals WHERE at > ? AND at <= ?').all(now - WINDOW, now);
    const identities = this.prepare('SELECT * FROM trends WHERE id IN (SELECT DISTINCT trend_id FROM signals)').all();
    const candidates = rankCandidates(identities, signals, this.prepare('SELECT * FROM evidence').all(), now, this.get('startedAt'), [], this.prepare('SELECT * FROM coverage WHERE bucket >= ?').all(now-48*HOUR), this.prepare('SELECT * FROM source_dates').all(), Infinity);
    const counts = new Map(this.prepare('SELECT trend_id,COUNT(*) count FROM post_usage WHERE at > ? AND at <= ? GROUP BY trend_id').all(now-DAY,now).map(r=>[r.trend_id,r.count]));
    const today = new Map(this.prepare('SELECT * FROM daily_usage WHERE day=?').all(Math.floor(now/DAY)*DAY).map(r=>[r.trend_id,r]));
    const dailyRows = this.prepare('SELECT * FROM daily_usage WHERE day>=? AND day<=?').all(Math.floor(now/DAY)*DAY-13*DAY,now);
    const postBuckets = this.prepare('SELECT trend_id,CAST((?-at)/? AS INTEGER) slot,COUNT(*) uses FROM post_usage WHERE at>? AND at<=? GROUP BY trend_id,slot').all(now,DAY,now-WINDOW,now);
    const postWindows=this.prepare('SELECT trend_id,SUM(CASE WHEN at>? THEN 1 ELSE 0 END) recent,SUM(CASE WHEN at<=? THEN 1 ELSE 0 END) baseline FROM post_usage WHERE at>? AND at<=? GROUP BY trend_id').all(now-6*HOUR,now-6*HOUR,now-30*HOUR,now);
    const replay=this.get('usageBackfill');
    const replayRanges=replay?.status==='imported' ? replay.ranges || [[replay.start,replay.end]] : [];
    const {trends,measuredCount}=rankByGrowth(candidates,dailyRows,postWindows,[...replayRanges,...(this.get('streamUsageCoverage')||[])],now,previous,redditGrowthRows(this,now));
    for (const trend of trends) {
      trend.usage = summarizeUsage(trend, dailyRows, postBuckets, now, this.get('usageCountingSince'), this.get('usageBackfill'));
      const reddit=redditUsage(this,trend,now);
      if(reddit)trend.usage.push(reddit);
      const countable = trend.kind === 'tag' || trend.sourceHistory.some(h=>h.sourceId==='bluesky-stream');
      trend.usage24h = { count: countable ? counts.get(trend.id) || 0 : null, source: 'Bluesky',
        windowStart: iso(now-DAY), windowEnd: iso(now), countingSince: iso(this.get('usageCountingSince')), scope: 'captured hashtag posts', partial: true };
      const daily = today.get(trend.id);
      trend.mastodonToday = daily ? { count: daily.uses, date: iso(daily.day).slice(0,10), checkedAt: iso(daily.checked_at), source: 'mastodon.social' } : null;
    }
    const ranking = { updatedAt: iso(now), windowStart: iso(now - WINDOW), windowEnd: iso(now), windowDays: 14,
      collectingSince: iso(this.get('startedAt')), warmingUp: measuredCount===0, rankingMode:'growth', measuredGrowthCount:measuredCount,
      candidateCount: identities.length, trends };
    this.set('ranking', ranking); return ranking;
  }
  publicRanking(now = Date.now()) {
    const ranking = this.get('ranking') || this.refresh(now);
    return { ...ranking, reddit:this.redditSummary(now), stale: now - Date.parse(ranking.updatedAt) > 120000,
      sources: this.prepare('SELECT * FROM source_state').all().map(s => ({ id: s.source, status: s.status, detail: s.detail,
        lastCheckedAt: s.checked_at ? iso(s.checked_at) : null, lastSuccessAt: s.success_at ? iso(s.success_at) : null,
        nextCheckAt:s.next_at?iso(s.next_at):null,
        stale: !s.success_at || now - s.success_at > (s.source==='reddit-posts'?20*60000:s.source === 'bluesky-stream' ? 120000 : 180000) })) };
  }
  close() { this.db.close(); }
}
