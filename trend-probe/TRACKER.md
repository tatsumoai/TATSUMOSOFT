# Trend Radar tracker

## Start the live local tracker

From the repository root, using Node 22.13 or later in the Node 22 series (tested on 22.22.1):

```powershell
npm --prefix trend-probe ci
npm --prefix trend-probe run tracker
```

Open http://127.0.0.1:8794/#trend-radar. This serves the portfolio plus `GET /api/trends` and collects while the process is running. Stop with Ctrl+C. Restarting reuses the database. `TREND_PORT` changes the local port; `TREND_DB_PATH` sets a different persistent database file. Node 22's built-in SQLite module emits an experimental-feature warning; its behavior is covered by the tests here.

For one bounded collection without a server:

```powershell
npm --prefix trend-probe run tracker:collect
```

SQLite lives at `trend-probe/data/trends.sqlite`, using WAL and transactional writes. `data/` is ignored by Git. Stop the tracker before copying the database for a simple backup; while running, the WAL is part of database state. Schema version 2 adds persistent source dates and backfills real post/day timestamps from existing signals. Listing fetch times are never backfilled as publication dates.

## Data and retention

- `trends` and `aliases`: stable identity, canonical name, explicit aliases, first observation. Persist beyond the activity window.
- `evidence`: dated historical occurrences or origins, supporting URL and note. Persist beyond the activity window.
- `source_dates`: earliest source-provided publication or usage date per topic, source, and date type, with precision and source link. This small identity history persists beyond the 14-day activity window. Google trend-feed publication, HN story publication, Mastodon positive usage days, and captured Bluesky post publication remain separately identified. Recent dates establish a lower bound on known usage and an estimated New & Recent label, not a verified new origin; evidence older than six months can establish Legacy automatically.
- `signals`: per-source observations. Removed when they fall outside the trailing 336 hours, using UTC timestamps. Cutoff is exclusive; future events are excluded.
- `seen_posts`: hashes of relevant post IDs for replay deduplication. Removed after 14 days.
- `coverage`: successful collection hours for establishing a genuine momentum baseline. Removed after 14 days.
- `source_state`: last result, last success and next eligible request per collector.
- `reddit_posts`, `reddit_terms`, and `reddit_usage`: distinct Reddit posts, normalized title phrases, and one post/topic match per pair. Publication times determine the 14-day window. Expiring a post removes its phrases and usage; compact dated topic evidence persists.
- `meta`: startup time, stream cursor, and current top 100. Rankings are replaced, not accumulated forever.

Candidates are collected beyond 100. Only the overall top 100 are published. UI age/search filters preserve their overall ranks rather than generating separate top-100 lists. If fewer than 100 qualify, the UI shows the real count.

## Collection and deduplication

Google Trends RSS (US), Bluesky selected topics, Mastodon tags on mastodon.social, and Hacker News front-page stories are requested approximately once a minute. A scheduler checks due times every five seconds and never overlaps a collection pass. Rate-limit responses use Retry-After or a 15-minute cooldown; access denials pause that source for an hour. Failures preserve previous data and appear in source health.

### Reddit discovery

The default is broad discovery. One shared request slot runs every five minutes through a six-step cycle: an individual community's Rising feed, Popular Hot, three more individual Rising feeds, then a follow-up topic search (or another individual Rising feed while evidence is building). The community list interleaves news, gaming, entertainment, sports, technology, politics, and memes; `REDDIT_COMMUNITIES` changes that list. `r/all` is not scheduled, and aggregate names are rejected in the community configuration. These are ranked samples, not a census of Reddit or a complete stream of new posts.

Repeated words alone are weak evidence. New Reddit topics need at least three distinct posts across two actual communities. Multiword phrases are preferred; single words need repeated evidence of a named term or hashtag. Subreddit/template-only titles such as `me_irl` are excluded. The panel shows supporting posts and communities for each candidate. This is literal title matching; semantic grouping, image text, and comment-body analysis are not included. Follow-up searches quote a qualifying phrase, search across Reddit, sort newest first, and request the last month; the database still retains only the trailing 14 days. Search results remain partial samples.

`reddit_fetches` records feed provenance and outcomes. `reddit_observations` stores position and any supplied score/comment metrics per check, separately from unique-post usage. A post appearing in Rising, Hot, and a search counts once per topic. Each entry's actual community is retained; aggregate feed names such as `all` never become a community. Feed movement compares the same post in the same ranked feed at least five minutes apart. JSON score and comment deltas retain their actual observation window; RSS never fabricates those metrics. Feed position and engagement are discovery evidence, not usage totals or percentage growth. Both new tables expire after 14 days, and deleting an expired post cascades to its observations.

Public Atom RSS is used without a token. Setting `REDDIT_ACCESS_TOKEN` selects the authenticated JSON transport for the same discovery plan. Tokens are not acquired or refreshed automatically. Request pacing is persisted before each request and shared across all Reddit feeds, communities, and formats. A 403 pauses that specific feed and transport for at least an hour; the next regular slot can check another individual Rising feed. Two consecutive access denials pause all Reddit collection for at least an hour. A 401 also pauses all collection for an hour; a 429 pauses it for at least fifteen minutes. A longer supplied Retry-After is always honored across Reddit. These minimum pauses are collector safeguards, not durations inferred from the HTTP status itself. Failures never trigger an immediate alternate request or switch the plan to New feeds. Active paused feeds appear on the page, and prior data remains available. The exact last endpoint, HTTP status, and any supplied retry time are retained locally for diagnosis.

Reddit announced that RSS support ends **November 13, 2026** and that new public API access requests stopped **October 31, 2026**. RSS works in the current local checks, but it is a temporary data connection. An existing approved token may support the JSON adapter; that connection is not live-verified without one. The collection transport is separate from discovery, storage, and ranking so another verified data provider can be added without rebuilding them. Source: [Reddit's October 8 changelog](https://support.reddithelp.com/hc/en-us/articles/54353370049684-Changelog-October-8-2026).

The older chronological collection mode remains available explicitly with `REDDIT_DISCOVERY=communities`. That mode can use newest-first publication intervals to establish coverage for a six-hour versus preceding-24-hour title-mention comparison, requiring 95% coverage in every monitored community and 20 observations in each period. Broad discovery never inherits those completeness claims. Its candidates can still gain measurable growth from other supported sources.

Bluesky Jetstream is a persistent connection, not the source checker's bounded sample. It collects hashtags from public post-create events, with all valid explicit hashtags retained for usage counts. Ranking keeps its separate five-tag-per-post contribution limit. Matching is Unicode-normalized, case-insensitive, and punctuation-normalized; exact names and curated aliases group across sources. Untagged Bluesky phrases are not extracted. Semantic headline grouping and image-meme recognition are not included.

Post IDs are deduplicated across reconnects and restarts. For ranking, an author contributes at most once per tag per UTC hour. Separately, `post_usage` records each distinct captured post/tag pair for rolling 24-hour usage counts, including repeated posts by one author. Canonical variants of a tag in one post count once. `usageCountingSince` records when this feature began; older author-capped ranking signals are not fabricated into post counts. Counts are partial observations, not complete network totals. The UI shows source-specific usage summaries: Mastodon sums all supplied daily counts inside the 14-calendar-day view, displays the number of dates available and the previous complete UTC day, and Bluesky shows distinct captured posts in the rolling 24 hours. Do not extrapolate these into internet-wide totals. Charts use raw source counts, with null gaps for dates without supplied history; ranking weights are no longer plotted as uses. A direct anonymous Bluesky searchPosts request for #vote over the preceding 24 hours returned HTTP 403 from this host on 2026-11-04 UTC; no historical search count was obtained. `daily_usage` stores Mastodon raw uses by UTC date, updated rather than added on repeated polls, and shown separately as today (UTC). Both tables expire after 14 days. Feed listings, search traffic and story engagement are not mixed into usage counts. Stream-only candidates require at least three independent authors within the activity window. Account and post identifiers are stored as hashes; raw post bodies and author profiles are not stored. A representative public post link remains as evidence of activity. This reduces repetitive spam but is not a complete bot-detection system.

Listing sources contribute one observation per topic/source/hour; repeated polls replace that observation, never add fabricated mentions. The position weight is `1 / log2(position + 1)` for the source response order (one-indexed). That is a source-order heuristic, not a claim that all upstream lists have identical ranking semantics. Mastodon daily account counts are replaced by date, including corrections to zero; they are not repeatedly added as fresh mentions.

The stream reconnects with capped exponential delays, resumes short interruptions using a saved cursor, and deduplicates overlap. After a gap longer than five minutes it resumes live rather than claiming complete backfill. Coverage and source status are shown so missing collection is visible.

## Ranking by growth

Ranking runs once per minute and prioritizes the fastest increase in source-specific usage rates. The public API and page show measured growth, replacing the former composite score:

```
multiple = (recent count / recent hours) / (baseline count / baseline hours)
growth percent = (multiple - 1) * 100
```

For example, 626 uses in the latest complete day compared with 978 uses over the preceding five days means `626 / (978 / 5) = 3.2004` times the usual daily rate, or **+220%**. The comparison periods never overlap.

- **Mastodon:** compare the latest complete UTC day with the average of the preceding consecutive complete days. Require at least three baseline days; use up to twelve within the 14-calendar-day view. Exclude partial today, missing days, and snapshots collected before their day ended.
- **Bluesky:** compare the last six hours with the preceding 24 hours, normalized per hour. Both periods must have at least 95% recorded collection coverage. Completed replay windows and continuous live heartbeats establish coverage; overlapping windows are merged and genuine gaps remain gaps.
- **Reddit:** broad Rising/Hot/search discovery does not claim a complete usage-growth rate. It reports community spread, within-feed position changes, and source-supplied engagement separately. The optional chronological community mode retains its guarded six-hour versus preceding-24-hour comparison; its counts never merge with other platforms.
- **Volume:** require at least 20 observations in each comparison period. Zero or tiny baselines never produce infinite growth or put one-to-two-post changes at the top.
- **Multiple sources:** retain each comparison separately. Rank a topic by its strongest qualifying source-specific growth, naming that source and showing the counts and periods in “Why this rank?” Counts from different platforms are never summed.
- **Top 100:** calculate growth for every eligible active candidate before selecting 100. Sort measured growth descending, then recent count and canonical name for ties. Candidates without comparable history follow measured candidates, show no invented percentage, and retain the existing activity-based discovery order until a comparison is possible.

Feed listings, author-hour signals, decay, and platform breadth still help discover candidates and order those awaiting a usable baseline; they do not become usage counts or measured growth. Stream-only candidates still require three independent authors. Movement compares with the previous growth ranking. The API exposes `rankingMode: 'growth'`, `measuredGrowthCount`, the selected `growth`, and `growthComparisons`; it no longer exposes the former opaque score. Charts display raw source counts with explicit missing-history gaps. Growth measures recent attention, not a sales forecast.

## Age labels

- **Legacy**: dated evidence is older than six calendar months as of ranking time.
- **New & Recent**: earliest dated evidence is within six months and no older evidence contradicts it. The API sets `ageEstimated: true` and the UI marks the badge Estimated unless verified origin evidence exists. Older evidence can reclassify it as Legacy.
- **Age unknown**: no dated source or curated evidence is available. Collection timestamps alone never establish age. Recent occurrence evidence supports only an estimate, not proof of a new trend.

Legacy takes precedence, and labels are recalculated as time passes. The included Rickrolling record uses the dated Know Your Meme entry as proof of prior existence, with aliases for Rickroll and Rick Roll. This identity does not create fake current activity or force it into the leaderboard.

Add researched evidence locally (nothing in the public API can mutate labels):

```powershell
npm --prefix trend-probe run tracker:evidence -- --name 'Topic name' --date 'YYYY-MM-DD' --kind occurrence --url 'https://source.example/article' --note 'What the dated source establishes'
```

Use `--kind origin` only when the source establishes the trend's origin, not merely a recent reference. Optional `--aliases 'alternative name,another name'` maps variants; conflicting identities are rejected instead of silently merged. Evidence is validated structurally, but verifying its factual meaning is an editorial task. There is no automated historical verification service in this version. Add durable seed evidence to `config/age-evidence.json` if it should accompany a new deployment.

## Website / deployment boundary

`index.html` embeds the panel; `tracker.js` polls `/api/trends` every minute while visible. Changing the section's `data-api` changes the endpoint. Values from sources are rendered as text and links allow only HTTP(S). Failures retain the last displayed snapshot with a delayed-update indicator. The API is read-only and serves an explicit static-file allowlist; it never serves `.env`, database files, or source code.

The portfolio publishes from GitHub through the existing Cloudflare Pages integration. When `/api/trends` is unavailable, the page loads `trend-preview.json` and explicitly labels it as a dated preview. Counts and charts retain their original windows; exporting never changes the ranking's collection date. A failed live request keeps previously loaded live data instead of replacing it with the preview. A successful live API response automatically replaces the preview.

Export the current saved ranking before publishing a new preview:

```powershell
npm --prefix trend-probe run tracker:preview
```

This exports only the public API response, with snapshot metadata. Commit `trend-preview.json` with the site; SQLite, raw replay files, credentials, and local reports remain ignored. No collector runs on the static deployment, and refreshing the preview does not collect new data.

The current server binds to loopback for local review. Continuous updates still require a Node service with persistent storage and a same-origin proxy for `/api/trends` (or an explicitly configured cross-origin API). A static website host alone cannot run the database or continuous stream. The existing demo Worker remains separate.

## Verify

```powershell
npm --prefix trend-probe test
```

Tests cover exact window expiry, replay/author deduplication, daily count corrections, growth-rate arithmetic, complete-day and stream-coverage baselines, tiny-volume guards, top-100 selection after growth calculation, discovery ordering and rank movement, six-calendar-month boundaries, evidence retention and aliases, restart persistence, health staleness, API behavior, and static-file isolation. Reddit checks cover Atom parsing, shared cooldowns, individual-feed pauses, repeated-denial pacing, Retry-After, optional JSON authentication, individual Rising rotation without r/all, follow-up search encoding, actual community provenance, cross-community topic qualification, template filtering, title-match deduplication and edits, within-feed movement, engagement snapshots, retention, and growth coverage across communities. Synthetic records are confined to tests and never inserted into the live database.


## Historical replay

The live stream and historical search are different interfaces. A denied search request does not prevent using the documented Jetstream timestamp cursor for retained history. The optional one-pass capture requires Python and `websockets`; the regular server remains Node-only. Run from `trend-probe`:

```powershell
python src/tracker/backfill_stream.py --hours 24
if ($LASTEXITCODE -eq 0) { node src/tracker/import_backfill.mjs data/bluesky-backfill.ndjson }
```

The capture pins its end time, requests the preceding 24 hours, and keeps only minimal hashtag post records under ignored `data/`. Use `--hours 35` to request enough history for the six-hour versus preceding-24-hour comparison. Optional `--until-ms <UTC epoch milliseconds>` stops at an earlier endpoint, allowing a missing older segment to be filled without downloading already imported history again. The adjacent JSON report records requested and received timestamps, transferred bytes, event count and completion status. It stops on errors, an unexpectedly clamped start, a byte limit (default 5 GiB) or a time limit (default 900 seconds). This is a deliberate one-time history import, not a job automatically repeated on every server restart. Raw network transfer can be several GiB because the relay filters by record collection, not by hashtag. No raw post text is stored. A complete capture can be imported repeatedly without inflating usage or author contributions. Incomplete captures never declare historical coverage. Previously seen posts can fill missing usage records without being counted twice in ranking.

`usageBackfill` metadata retains the union of completed imported ranges; `streamUsageCoverage` retains continuous live collection ranges. Gaps between ranges are not filled by assumption. `usage` API summaries retain per-source units, actual dates and missing days. Mastodon's initial history normally covers seven UTC dates; continuous collection accumulates toward 14. Jetstream's documented socket replay lookback is currently approximately 36 hours, so a replay does not supply two weeks of Bluesky history. Full 14-day retrospective coverage remains incomplete; the UI shows available history explicitly. Primary references: [Mastodon Tag history](https://docs.joinmastodon.org/entities/Tag/), [Jetstream timestamp cursors](https://github.com/bluesky-social/jetstream-legacy#consuming-jetstream), [current lookback rules](https://github.com/bluesky-social/jetstream/blob/main/docs/README.md).
