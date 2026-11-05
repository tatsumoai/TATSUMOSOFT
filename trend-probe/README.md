# Trend Radar source probe

A fresh, bounded collection tool to establish which sources return usable trend data from the machine running it. Built independently of Hirewall, Jobsearcher, and Squibli. Running the probe does not change the portfolio or deploy anything.

The project now also includes the persistent tracker. See [TRACKER.md](TRACKER.md) for the database, ranking model, collectors, and local homepage preview. The source probe commands below remain independent of the tracker.

## Run

Requires Node.js 22 or later. In PowerShell:

```powershell
cd 'C:\Tatsumo Soft\GitHub\TATSUMOSOFT\trend-probe'
npm ci
npm run probe
```

Open `reports/latest.html` for a readable report. `reports/latest.json` contains every normalized record collected, request timestamps, statuses, selected response headers, coverage limitations, and source documentation links. Each run also produces timestamped files. Reports and credentials are ignored by Git.

To compare two snapshots approximately one minute apart:

```powershell
npm run probe -- --rounds 2 --interval 60
```

To select sources:

```powershell
npm run probe -- --list
npm run probe -- --sources google-trends,bluesky-stream,mastodon-tags
```

Default is one pass, not a background service. Each HTTP source receives one GET per round. There is no pagination, automatic authentication, proxy rotation, browser impersonation, or challenge handling. Redirects are recorded without following them. A denied source is not requested again during the same run; a 429 respects Retry-After or stops until the next manual run. Connections have timeouts and byte limits. Live-stream collection ends after 50 posts or an eight-second sample window. Ctrl+C stops the process; completed rounds are already saved.

Reddit RSS, public JSON, and OAuth checks share one request slot within a probe run: at least five minutes between requests, fifteen minutes after a 429 (longer if Retry-After requires it), and an hour after a denial. Skipped formats show `waiting`; that does not establish whether they work. Do not run Reddit probes alongside the live tracker or restart the probe to bypass a cooldown. The tracker persists its own cooldown across restarts; independent probe processes do not share that database.

## Sources and coverage

| Check | Data collected | Credential |
| --- | --- | --- |
| Reddit public RSS | Latest 100 r/memes post titles, links and publication dates | None |
| Reddit public JSON | Latest 25 r/memes posts, score, flair, comment count | None |
| Bluesky topics | Platform-selected topic names and links | None; experimental endpoint |
| Bluesky Jetstream | Brief sample of new public posts and hashtags | None |
| Google Trends RSS | US search topics, approximate traffic, news links | None |
| Mastodon | Trending tags and daily usage history on mastodon.social | None |
| Hacker News | Front-page titles, points, comment counts | None |
| YouTube | Popular music, movie and gaming videos with tags and metrics | `YOUTUBE_API_KEY` |
| Reddit OAuth | Rising posts in r/memes | `REDDIT_ACCESS_TOKEN` |
| X | US trending topics | `X_BEARER_TOKEN` |

TikTok and Instagram are listed as not tested, not as inaccessible. They have no implemented adapters or configured accounts in this phase. This registry is a starting sample, not an exhaustive survey of the internet. US feeds are an initial configuration choice.

If using credentialed checks, copy `.env.example` to `.env` and populate only the credentials you intend to test. The CLI reads `.env`; do not paste tokens into commands, reports, or source files. Missing credentials skip the request, and do not establish whether access is granted or denied. Existing API entitlements and quotas apply. Tokens are not refreshed automatically.

## Reading the results

- `ok`: validated nonempty records; HTTP success alone is insufficient.
- `empty`: valid schema but no usable entries during this check.
- `access_denied`: observed HTTP 403; it does not identify the underlying reason.
- `authentication_required`, `payment_required`, `rate_limited`: HTTP 401, 402, 429 respectively.
- `credentials_missing`: request not attempted; environment variable is absent.
- `waiting`: request skipped because another Reddit request established a shared cooldown.
- `unexpected_response`: HTML or a non-upgrade stream response, not a usable feed.
- `invalid_data`: response does not match the expected schema.
- `timeout`, `network_error`, `server_error`, `http_error`, `redirect`, `response_too_large`: distinct operational outcomes.

Request times and source publication times are separate. A recent request may return old or cached items. Two-round deltas report additions, removals, record changes, and list-order changes; they do not turn cumulative counts into new mentions. Independent stream samples are labeled as such. Even an unchanged pair does not prove the source is stale; there may simply be no new data.

Access results only describe the host and timestamps recorded. Run the same package on the intended backend with `--label cloud-host-name` before treating local success as production availability. The tool does not infer policy permission from a successful request, or technical failure from policy text.

## Boundary with the tracker

The probe report has source-specific records, separate from the tracker's top 100. No legacy/new classification or forecast is fabricated in the probe. The persistent tracker's candidate grouping, deduplication, 14-day retention, age evidence, and scheduling are described in [TRACKER.md](TRACKER.md). Probe reports remain on disk until removed; they do not expire with the tracker's activity window.

## Verification

```powershell
npm test
```

Tests exercise blocked responses, credential skips, HTML challenges, malformed payloads, rate-limit cooldown, RSS parsing, repeated post IDs, snapshot changes, bounded WebSocket collection, and escaping/redaction. `npm run probe` performs the separate live integration check.
