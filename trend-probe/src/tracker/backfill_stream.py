"""Bounded historical Jetstream capture; emits hashtag records, never raw post bodies.

Optional backfill utility: Python with websockets installed.
The live Node collector continues running while this capture is made.
"""
import argparse
import asyncio
import json
from pathlib import Path
import time

import websockets


async def capture(args):
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    state_path = output.with_suffix('.json')
    requested_now = int(time.time() * 1000)
    start = requested_now - args.hours * 3600000
    end = args.until_ms if args.until_ms is not None else requested_now
    if not start < end <= requested_now:
        raise ValueError('The historical end must follow the requested start and cannot be in the future')
    state = dict(status='running', start=start, end=end, firstEvent=None, lastEvent=None,
                 bytes=0, events=0, posts=0, startedAt=requested_now)
    def save():
        state_path.write_text(json.dumps(state), encoding='utf-8')
    save()
    try:
        url = ('wss://jetstream1.us-east.bsky.network/subscribe'
               '?wantedCollections=app.bsky.feed.post&cursor=' + str(start * 1000))
        began = time.monotonic()
        progress = began
        with output.open('w', encoding='utf-8') as records:
            async with websockets.connect(url, open_timeout=15, max_size=2 * 1024 * 1024,
                                          additional_headers={'User-Agent': 'TatsumoTrendRadar/0.1'}) as socket:
                while time.monotonic() - began < args.max_seconds:
                    raw = await asyncio.wait_for(socket.recv(), timeout=30)
                    state['bytes'] += len(raw)
                    if state['bytes'] > args.max_bytes:
                        state['status'] = 'byte_limit'
                        break
                    event = json.loads(raw)
                    stamp = event.get('time_us')
                    if not isinstance(stamp, (int, float)):
                        continue
                    at = stamp / 1000
                    state['firstEvent'] = state['firstEvent'] or at
                    state['lastEvent'] = at
                    state['events'] += 1
                    # A clamped cursor must not silently be called a complete backfill.
                    if state['events'] == 1 and at > start + 60000:
                        state['status'] = 'history_truncated'
                        break
                    if at > end:
                        state['status'] = 'complete'
                        break
                    commit = event.get('commit') or {}
                    record = commit.get('record') or {}
                    if event.get('kind') == 'commit' and commit.get('operation') == 'create' and commit.get('collection') == 'app.bsky.feed.post':
                        tags = {tag for tag in record.get('tags', []) if isinstance(tag, str) and tag.strip()}
                        for facet in record.get('facets', []):
                            for feature in facet.get('features', []):
                                if feature.get('$type') == 'app.bsky.richtext.facet#tag' and isinstance(feature.get('tag'), str):
                                    tags.add(feature['tag'])
                        if tags and event.get('did') and commit.get('rkey') and record.get('createdAt'):
                            did, key = event['did'], commit['rkey']
                            item = dict(id=f'at://{did}/app.bsky.feed.post/{key}', tags=sorted(tags),
                                        publishedAt=record['createdAt'], url=f'https://bsky.app/profile/{did}/post/{key}')
                            records.write(json.dumps(item, ensure_ascii=True) + '\n')
                            state['posts'] += 1
                    if time.monotonic() - progress >= 30:
                        save()
                        print(json.dumps(state), flush=True)
                        progress = time.monotonic()
                else:
                    state['status'] = 'time_limit'
    except Exception as error:
        state['status'] = 'failed'
        state['error'] = type(error).__name__
    finally:
        save()
        print(json.dumps(state), flush=True)
    return 0 if state['status'] == 'complete' else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--hours', type=int, default=24, choices=range(1, 37))
    parser.add_argument('--until-ms', type=int, help='Optional historical end, to fill only an older missing interval')
    parser.add_argument('--output', default='data/bluesky-backfill.ndjson')
    parser.add_argument('--max-seconds', type=int, default=900)
    parser.add_argument('--max-bytes', type=int, default=5 * 1024 ** 3)
    raise SystemExit(asyncio.run(capture(parser.parse_args())))
