import { canonical, HOUR, WINDOW, iso } from './model.mjs';

// Ranking and search feeds discover candidates; their order is not usage volume.
export function redditTopicCandidates(store,now=Date.now(),limit=8) {
  const groups=store.prepare(`SELECT t.term,COUNT(*) posts,COUNT(DISTINCT p.community) breadth,MAX(p.published_at) latest
    FROM reddit_terms t JOIN reddit_posts p ON p.id=t.post_id WHERE p.published_at>? AND p.published_at<=?
    GROUP BY t.term HAVING COUNT(*)>=3 AND COUNT(DISTINCT p.community)>=2
    ORDER BY breadth DESC,posts DESC,LENGTH(t.term) DESC,t.term`).all(now-WINDOW,now);
  const picked=[];
  for(const group of groups) {
    const rows=store.prepare(`SELECT p.id,p.title,p.url,p.community,p.published_at FROM reddit_posts p
      JOIN reddit_terms t ON t.post_id=p.id WHERE t.term=? AND p.published_at>? AND p.published_at<=? ORDER BY p.published_at DESC`).all(group.term,now-WINDOW,now);
    if(!group.term.includes(' ')) {
      // A lone common word is weak evidence. Require a named term or hashtag in
      // several titles, rather than treating any repeated word as a new meme.
      const named=rows.filter(p=>(p.title.match(/#?[\p{L}][\p{L}\p{M}\p{N}]*/gu)||[]).some((word,index)=>
        canonical(word)===group.term && (word.startsWith('#') || (/\p{Lu}/u.test(word) && (word===word.toUpperCase() || index>0 && /^\p{Lu}/u.test(word))))));
      if(named.length<3)continue;
    }
    // Prefer the longer repeated phrase when the exact same posts support it.
    const ids=rows.map(p=>p.id).sort().join(',');
    if(picked.some(p=>p.support===ids && (p.name.includes(group.term)||group.term.includes(p.name))))continue;
    const represented=new Set(),samples=rows.filter(p=>{if(represented.has(p.community))return false;represented.add(p.community);return true;}).slice(0,2);
    picked.push({name:group.term,posts:group.posts,communities:[...new Set(rows.map(p=>p.community))],
      latestPublishedAt:iso(group.latest),samples,support:ids});
    if(picked.length>=limit)break;
  }
  return picked.map(({support,...topic})=>topic);
}

export function chooseRedditTarget(store,communities,env,now) {
  const target=scheduledRedditTarget(store,communities,env,now);
  const format=env.REDDIT_ACCESS_TOKEN?.trim()?'json':'xml',pauses=store.get('redditFeedPauses')||{};
  const paused=key=>pauses[`${format}:${key}`]?.until>now;
  if(!paused(target.key))return target;
  const kind=env.REDDIT_DISCOVERY==='communities'?'new':'rising';
  const start=(store.get('redditNextCommunity')||0)%communities.length;
  for(let offset=0;offset<communities.length;offset++) {
    const index=(start+offset)%communities.length,community=communities[index],key=`community:${community}:${kind}`;
    if(!paused(key))return {key,kind,community,index,chronological:kind==='new',label:`r/${community} · ${kind==='new'?'New':'Rising'}`,replacementFor:target.key};
  }
  return {waitingUntil:Math.min(...Object.values(pauses).filter(p=>p.format===format&&p.until>now).map(p=>p.until))};
}
function scheduledRedditTarget(store,communities,env,now) {
  if(env.REDDIT_DISCOVERY==='communities') {
    const index=(store.get('redditNextCommunity')||0)%communities.length,community=communities[index];
    return {key:`community:${community}:new`,kind:'new',community,label:`r/${community} · New`,chronological:true,index};
  }
  const step=store.get('redditDiscoveryStep')||0,slot=step%6;
  if(slot===1)return {key:'popular:hot',kind:'hot',community:'popular',label:'Popular communities · Hot'};
  if(slot===5) {
    const searches=store.get('redditTopicSearches')||{};
    const topics=redditTopicCandidates(store,now,30).sort((a,b)=>(searches[a.name]||0)-(searches[b.name]||0));
    if(topics.length)return {key:`search:${topics[0].name}`,kind:'search',query:topics[0].name,label:`Follow-up search · ${topics[0].name}`};
  }
  const index=(store.get('redditNextCommunity')||0)%communities.length,community=communities[index];
  return {key:`community:${community}:rising`,kind:'rising',community,index,label:`r/${community} · Rising`};
}

export function recordRedditDiscovery(store,target,result,now) {
  store.transaction(()=>{
    store.prepare('INSERT OR REPLACE INTO reddit_fetches VALUES(?,?,?,?,?,?)')
      .run(target.key,now,target.label,target.kind,result.status,result.items?.length||0);
    if(!['ok','empty'].includes(result.status))return;
    for(const [index,item] of result.items.entries()) {
      if(!store.prepare('SELECT id FROM reddit_posts WHERE id=?').get(item.id))continue;
      store.prepare('INSERT OR REPLACE INTO reddit_observations VALUES(?,?,?,?,?,?)')
        .run(target.key,item.id,now,index+1,Number.isFinite(item.metrics?.score)?item.metrics.score:null,Number.isFinite(item.metrics?.comments)?item.metrics.comments:null);
    }
  });
}

export function redditPostMovement(store,id,now) {
  const rows=store.prepare('SELECT * FROM reddit_observations WHERE post_id=? AND observed_at>? AND observed_at<=? ORDER BY observed_at').all(id,now-6*HOUR,now);
  return movementFromRows(rows);
}
function movementFromRows(rows) {
  const feeds=new Map();
  for(const row of rows) {
    if(row.feed_key.startsWith('search:') || row.feed_key.endsWith(':new'))continue;
    const pair=feeds.get(row.feed_key)||[row,row];pair[1]=row;feeds.set(row.feed_key,pair);
  }
  const moves=[...feeds].flatMap(([feed,[first,last]])=>last.observed_at-first.observed_at>=5*60000 && first.position>last.position?
    [{feed,from:first.position,to:last.position,places:first.position-last.position,fromAt:iso(first.observed_at),toAt:iso(last.observed_at)}]:[]);
  const metricRows=rows.filter(r=>r.comments!==null && r.score!==null),first=metricRows[0],last=metricRows.at(-1);
  const engagement=first && last.observed_at-first.observed_at>=5*60000?{
    commentChange:last.comments-first.comments,scoreChange:last.score-first.score,
    hours:(last.observed_at-first.observed_at)/HOUR,fromAt:iso(first.observed_at),toAt:iso(last.observed_at)}:null;
  return {movement:moves.sort((a,b)=>b.places-a.places)[0]||null,engagement};
}

export function redditDiscoverySummary(store,now) {
  const topics=redditTopicCandidates(store,now),communities=store.prepare('SELECT DISTINCT community FROM reddit_posts WHERE published_at>? AND published_at<=? ORDER BY community').all(now-WINDOW,now).map(r=>r.community);
  const feeds=store.prepare(`SELECT f.* FROM reddit_fetches f JOIN (SELECT feed_key,MAX(checked_at) checked_at FROM reddit_fetches GROUP BY feed_key) latest
    ON f.feed_key=latest.feed_key AND f.checked_at=latest.checked_at ORDER BY f.checked_at DESC LIMIT 12`).all();
  const observations=store.prepare(`SELECT o.* FROM reddit_observations o JOIN reddit_posts p ON p.id=o.post_id
    WHERE o.observed_at>? AND o.observed_at<=? AND p.published_at>? AND p.published_at<=? ORDER BY o.observed_at`).all(now-6*HOUR,now,now-WINDOW,now);
  const perPost=new Map();
  for(const row of observations){if(!perPost.has(row.post_id))perPost.set(row.post_id,[]);perPost.get(row.post_id).push(row);}
  const movers=[...perPost].map(([id,rows])=>({id,...movementFromRows(rows)})).filter(p=>p.movement||p.engagement?.commentChange>0)
    .sort((a,b)=>(b.movement?.places||0)-(a.movement?.places||0)).slice(0,5)
    .map(p=>({...store.prepare('SELECT id,title,url,community,published_at FROM reddit_posts WHERE id=?').get(p.id),...p}));
  const format=store.get('redditMode')==='Authenticated API'?'json':'xml';
  const pausedFeeds=Object.values(store.get('redditFeedPauses')||{}).filter(p=>p.format===format&&p.until>now&&!p.key.startsWith('all:')).sort((a,b)=>b.at-a.at);
  return {strategy:store.get('redditStrategy')||'broad',topics,communityCount:communities.length,observedCommunities:communities,feeds,movers,pausedFeeds,
    fallback:pausedFeeds.length?{blockedFeed:pausedFeeds[0].label,at:iso(pausedFeeds[0].at),reason:'This feed was denied; other documented feeds remain eligible after shared pacing.'}:null,
    focusedCommunities:store.get('redditCommunities')||[],
    notice:{date:'2026-11-13',text:'Reddit has announced that RSS support ends November 13, 2026.',url:'https://support.reddithelp.com/hc/en-us/articles/54353370049684-Changelog-October-8-2026'}};
}
