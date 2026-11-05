import { XMLParser, XMLValidator } from 'fast-xml-parser';

const array = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
const text = value => typeof value === 'string' ? value.trim() : '';
const number = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
export function safeUrl(value, base) {
  try { const url = new URL(value, base); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}
function list(value, label) {
  if (!Array.isArray(value)) throw new Error(`Expected ${label} array`);
  return value;
}
export function validateItems(items) {
  if (!Array.isArray(items) || items.some(i => !i || typeof i.id !== 'string' || !i.id || typeof i.title !== 'string' || !i.title)) {
    throw new Error('Records are missing usable IDs or titles');
  }
  return [...new Map(items.map(i => [i.id, i])).values()];
}
export function reddit(data) {
  return list(data?.data?.children, 'data.children').map(({ data: p }) => ({
    id: text(p?.name), title: text(p?.title), url: safeUrl(p?.permalink, 'https://www.reddit.com'),
    publishedAt: number(p?.created_utc) === null ? null : date(new Date(Number(p.created_utc) * 1000).toISOString()),
    tags: p?.link_flair_text ? [p.link_flair_text] : [], community: text(p?.subreddit),
    metrics: { score: number(p?.score), comments: number(p?.num_comments), upvoteRatio: number(p?.upvote_ratio) }
  }));
}
export function redditRss(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XML document types and entity declarations are unsupported');
  if (XMLValidator.validate(xml) !== true) throw new Error('Invalid Reddit Atom XML');
  const parsed = new XMLParser({ ignoreAttributes: false, parseTagValue: false }).parse(xml);
  if (!parsed?.feed) throw new Error('Expected an Atom feed');
  return array(parsed.feed.entry).map(p => {
    const links=array(p.link), postLink=links.find(l=>!l['@_rel'] || l['@_rel']==='alternate');
    return {id:text(p.id),title:text(p.title?.['#text'] ?? p.title),url:safeUrl(postLink?.['@_href']),
      publishedAt:date(p.published),updatedAt:date(p.updated),
      community:text(array(p.category)[0]?.['@_term']),tags:[],metrics:{}};
  });
}
export function blueskyTopics(data) {
  return list(data?.topics, 'topics').map(p => ({
    id: text(p.topic), title: text(p.displayName) || text(p.topic), url: safeUrl(p.link, 'https://bsky.app'),
    publishedAt: null, tags: [], metrics: {}
  }));
}
export function mastodonTags(data) {
  return list(data, 'tags').map(p => ({
    id: text(p.name).toLowerCase(), title: `#${text(p.name)}`, url: safeUrl(p.url), publishedAt: null,
    tags: [text(p.name)], metrics: {},
    history: list(p.history, 'history').map(h => ({ dayUnix: number(h.day), accounts: number(h.accounts), uses: number(h.uses) }))
  }));
}
export function hackerNews(data) {
  return list(data?.hits, 'hits').map(p => ({
    id: text(p.objectID), title: text(p.title), url: `https://news.ycombinator.com/item?id=${encodeURIComponent(p.objectID)}`,
    publishedAt: date(p.created_at), tags: [], metrics: { points: number(p.points), comments: number(p.num_comments) }
  }));
}
export function googleTrends(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XML document types and entity declarations are unsupported');
  if (XMLValidator.validate(xml) !== true) throw new Error('Invalid RSS XML');
  const parsed = new XMLParser({ ignoreAttributes: true, parseTagValue: false }).parse(xml);
  if (!parsed?.rss?.channel) throw new Error('Expected an RSS channel');
  return array(parsed.rss.channel.item).map(p => ({
    id: text(p.title).normalize('NFKC').toLowerCase(), title: text(p.title), url: safeUrl(p.link),
    publishedAt: date(p.pubDate), tags: [], metrics: { approximateTraffic: text(p['ht:approx_traffic']) || null },
    relatedLinks: array(p['ht:news_item']).slice(0, 3).map(n => ({
      title: text(n['ht:news_item_title']), url: safeUrl(n['ht:news_item_url'])
    }))
  }));
}
export function youtube(data) {
  return list(data?.items, 'items').map(p => ({
    id: text(p.id), title: text(p.snippet?.title), url: `https://www.youtube.com/watch?v=${encodeURIComponent(p.id)}`,
    publishedAt: date(p.snippet?.publishedAt), tags: array(p.snippet?.tags).filter(t => typeof t === 'string'),
    metrics: { views: number(p.statistics?.viewCount), likes: number(p.statistics?.likeCount), comments: number(p.statistics?.commentCount) }
  }));
}
export function xTrends(data) {
  return list(data?.data, 'data').map(p => ({
    id: text(p.trend_name).toLowerCase(), title: text(p.trend_name),
    url: `https://x.com/search?q=${encodeURIComponent(p.trend_name)}`, publishedAt: null, tags: [],
    metrics: { posts: number(p.tweet_count) }
  }));
}
export function jetstreamPost(event) {
  const c = event?.commit;
  if (event?.kind !== 'commit' || c?.operation !== 'create' || c?.collection !== 'app.bsky.feed.post') return null;
  if (!text(event.did) || !text(c.rkey) || !text(c.record?.text)) return null;
  const tags = new Set(array(c.record.tags).filter(t => typeof t === 'string'));
  for (const facet of array(c.record.facets)) {
    for (const feature of array(facet.features)) {
      if (feature.$type === 'app.bsky.richtext.facet#tag' && text(feature.tag)) tags.add(feature.tag);
    }
  }
  return { id: `at://${event.did}/${c.collection}/${c.rkey}`, title: c.record.text.slice(0, 280),
    url: `https://bsky.app/profile/${encodeURIComponent(event.did)}/post/${encodeURIComponent(c.rkey)}`,
    publishedAt: date(c.record.createdAt), tags: [...tags], metrics: {} };
}
