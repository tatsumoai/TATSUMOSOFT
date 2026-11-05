import { canonical, DAY, HOUR, WINDOW, iso } from './model.mjs';
import { reddit, redditRss } from '../parsers.mjs';
import { probeHttp, retryAt } from '../probe.mjs';
import { coverageFraction, mergeRanges, MIN_VOLUME, MIN_COVERAGE } from './growth.mjs';
import { chooseRedditTarget, recordRedditDiscovery } from './reddit-discovery.mjs';

export const REDDIT_INTERVAL=5*60000;
const STOP=new Set(('a an the and or but of in on at to from for with by as is are was were be been being it its this that these those i me my mine you your we our they their he she his her them us not no yes just when what why how who where which if then than so too very all any some more most less can could would should will do does did have has had am im its dont cant thats whats into about out up down over under again now today get got make made like really one people someone something meme memes post posts reddit comment comments ootl loop going know thing things look looks think thought say says said still time day want need anyone everyone even much many good bad come comes went way see seen also never always every use used using real').split(' '));
export function redditTerms(title,community='') {
  if(['me irl','meirl','irl','memes','dankmemes',canonical(community)].includes(canonical(title)))return [];
  const tokens=canonical(title).split(' ').filter(Boolean).slice(0,60), found=new Set();
  const useful=word=>word.length>=3 && !STOP.has(word) && !/^\d+$/.test(word);
  for(let i=0;i<tokens.length;i++) {
    if(useful(tokens[i]))found.add(tokens[i]);
    for(let size=2;size<=4 && i+size<=tokens.length;size++) {
      const words=tokens.slice(i,i+size);
      if(useful(words[0]) && useful(words.at(-1)) && words.filter(useful).length>=2)found.add(words.join(' '));
    }
  }
  return [...found];
}
export function redditCommunities(env=process.env) {
  const names=(env.REDDIT_COMMUNITIES || 'news,gaming,movies,sports,technology,memes,worldnews,games,television,nba,politics,Music,nfl,dankmemes,OutOfTheLoop').split(',').map(s=>s.trim().replace(/^r\//,'').toLowerCase());
  if(names.some(s=>['all','popular'].includes(s)))throw new Error('REDDIT_COMMUNITIES needs actual community names, not aggregate feeds');
  if(names.some(s=>! /^[a-z0-9_]{2,21}$/.test(s)))throw new Error('REDDIT_COMMUNITIES needs comma-separated subreddit names');
  return [...new Set(names)];
}
export function redditSource(community,env=process.env) {
  const target=typeof community==='string'?{community,kind:'new',label:`New posts from r/${community}`} : community;
  const authenticated=Boolean(env.REDDIT_ACCESS_TOKEN?.trim());
  const url=new URL(authenticated?'https://oauth.reddit.com':'https://www.reddit.com');
  url.pathname=target.kind==='search'?`/search${authenticated?'':'.rss'}`:`/r/${target.community}/${target.kind}${authenticated?'':'.rss'}`;
  url.searchParams.set('limit','100');
  if(authenticated)url.searchParams.set('raw_json','1');
  if(target.kind==='search') {
    url.searchParams.set('q',`"${target.query}"`);url.searchParams.set('sort','new');url.searchParams.set('t','month');
    url.searchParams.set('restrict_sr','off');url.searchParams.set('type','link');
  }
  return {id:'reddit-posts',name:'Reddit',protocol:'http',format:authenticated?'json':'xml',
    url:url.href,
    parse:authenticated?reddit:redditRss,
    ...(authenticated?{credential:{env:'REDDIT_ACCESS_TOKEN',header:'Authorization',prefix:'Bearer '}}:{}),
    scope:target.label,caveat:'Collected posts from discovery feeds; not platform-wide totals.',docs:'https://www.reddit.com/dev/api/#GET_'+target.kind};
}
export async function collectReddit(store,{env=process.env,request=probeHttp,clock=Date.now}={}) {
  const now=clock(), state=store.prepare('SELECT * FROM source_state WHERE source=?').get('reddit-posts');
  if(state?.next_at>now)return null;
  const communities=redditCommunities(env),target=chooseRedditTarget(store,communities,env,now);
  if(target.waitingUntil) {
    store.state('reddit-posts','waiting','Configured Reddit feeds are paused after access denials.',now,target.waitingUntil);
    return null;
  }
  const source=redditSource(target,env);
  // Reserve the shared host slot before awaiting IO; restarts cannot reset pacing.
  store.state('reddit-posts','collecting',`Checking ${target.label}.`,now,now+REDDIT_INTERVAL);
  store.set('redditCommunities',communities);
  store.set('redditStrategy',env.REDDIT_DISCOVERY==='communities'?'communities':'broad');
  let result;
  try {result=await request(source,{env});}
  catch {result={status:'network_error',items:[],detail:'Reddit request could not be completed.'};}
  const finished=clock();
  const instructedAt=Date.parse(result.retryAfter||'')||Date.parse(retryAt(result.headers?.['retry-after'],finished)||'')||0;
  let next=Math.max(finished+REDDIT_INTERVAL,instructedAt);
  if(result.status==='rate_limited')next=Math.max(next,finished+15*60000);
  if(result.status==='authentication_required')next=Math.max(next,finished+HOUR);
  const denials=result.status==='access_denied'?(store.get('redditConsecutiveDenials')||0)+1:0;
  store.set('redditConsecutiveDenials',denials);
  if(result.status==='access_denied') {
    const pauses=store.get('redditFeedPauses')||{};
    pauses[`${source.format}:${target.key}`]={key:target.key,format:source.format,label:target.label,at:finished,until:Math.max(finished+HOUR,instructedAt)};
    store.set('redditFeedPauses',pauses);
    // One denied resource cannot establish that all Rising feeds are denied.
    // Repeated denials do trigger a shared pause rather than probing more paths.
    if(denials>=2)next=Math.max(next,finished+HOUR);
  }
  store.set('redditLastRequest',{endpoint:source.url,scope:source.scope,format:source.format,status:result.status,httpStatus:result.httpStatus??null,checkedAt:iso(finished),retryAfter:instructedAt?iso(instructedAt):null});
  if(['ok','empty'].includes(result.status)) {
    store.ingestReddit(result.items,target.community,finished);
    const dates=result.items.map(p=>Date.parse(p.publishedAt));
    // A bounded newest-first listing covers only its returned publication interval.
    // Invalid dates cannot establish coverage, and empty feeds establish no history.
    const coverageEnd=finished-Math.max(0,Number(result.headers?.age)||0)*1000;
    if(target.chronological && dates.length && result.items.every(p=>/^t3_[a-z0-9]+$/i.test(p.id)) && dates.every((t,i)=>Number.isFinite(t)&&t<=coverageEnd&&(!i||t<=dates[i-1]))) {
      const ranges=store.get('redditCoverage')||{};
      ranges[target.community]=mergeRanges([...(ranges[target.community]||[]),[Math.max(finished-WINDOW,Math.min(...dates)),coverageEnd]])
        .filter(([,end])=>end>finished-WINDOW);
      store.set('redditCoverage',ranges);
    }
    if(target.index!==undefined)store.set('redditNextCommunity',(target.index+1)%communities.length);
    if(!target.chronological)store.set('redditDiscoveryStep',(store.get('redditDiscoveryStep')||0)+1);
    if(target.kind==='search')store.set('redditTopicSearches',{...(store.get('redditTopicSearches')||{}),[target.query]:finished});
  }
  recordRedditDiscovery(store,target,result,finished);
  store.set('redditMode',source.format==='json'?'Authenticated API':'Public RSS');
  store.state('reddit-posts',result.status,
    ['ok','empty'].includes(result.status)?`${target.label}: ${result.items.length} posts received. One Reddit request every 5 minutes.`:
    `${target.label}: ${result.detail} Next eligible check ${iso(next)}.`,finished,next);
  return result;
}
export function redditGrowthRows(store, now) {
  // Broad Rising/Hot/search samples do not prove complete publication coverage.
  // Feed positions and engagement changes are exposed separately, never as uses.
  if(store.get('redditStrategy')==='broad')return new Map();
  const communities=store.get('redditCommunities')||[], ranges=store.get('redditCoverage')||{};
  if(!communities.length)return new Map();
  const coverage={recent:Math.min(...communities.map(c=>coverageFraction(ranges[c]||[],now-6*HOUR,now))),
    baseline:Math.min(...communities.map(c=>coverageFraction(ranges[c]||[],now-30*HOUR,now-6*HOUR)))};
  if(coverage.recent<MIN_COVERAGE || coverage.baseline<MIN_COVERAGE)return new Map();
  const placeholders=communities.map(()=>'?').join(',');
  const counts=store.prepare(`SELECT u.trend_id,SUM(p.published_at>?) recent,SUM(p.published_at<=?) baseline
    FROM reddit_usage u JOIN reddit_posts p ON p.id=u.post_id WHERE p.published_at>? AND p.published_at<=? AND p.community IN (${placeholders}) GROUP BY u.trend_id`)
    .all(now-6*HOUR,now-6*HOUR,now-30*HOUR,now,...communities);
  return new Map(counts.map(r=>{
    const measured=r.recent>=MIN_VOLUME && r.baseline>=MIN_VOLUME;
    const multiple=measured?(r.recent/6)/(r.baseline/24):null;
    return [r.trend_id,{source:'Reddit',unit:'collected title mentions',status:measured?'measured':'low_volume',multiple,percent:measured?(multiple-1)*100:null,
      recent:{count:r.recent,hours:6,start:iso(now-6*HOUR),end:iso(now)},
      baseline:{count:r.baseline,hours:24,start:iso(now-30*HOUR),end:iso(now-6*HOUR)},
      period:'Last 6 hours vs preceding 24 hours in monitored communities, compared per hour',coverage,communities}];
  }));
}
export function redditUsage(store,trend,now) {
  const rows=store.prepare(`SELECT p.published_at,p.community FROM reddit_usage u JOIN reddit_posts p ON p.id=u.post_id
    WHERE u.trend_id=? AND p.published_at>? AND p.published_at<=?`).all(trend.id,now-WINDOW,now);
  if(!rows.length)return null;
  const since=rows.reduce((earliest,r)=>Math.min(earliest,r.published_at),now);
  const ranges=Object.values(store.get('redditCoverage')||{}).flat();
  return {source:'Reddit',sourceId:'reddit-posts',unit:'posts',kind:'sampled_posts',total:rows.length,
    last24h:rows.filter(r=>r.published_at>now-DAY).length,periodStart:iso(since),periodEnd:iso(now),
    communities:[...new Set(rows.map(r=>r.community))],
    points:Array.from({length:14},(_,i)=>{
      const start=now-(14-i)*DAY,end=start+DAY;
      const count=rows.filter(r=>r.published_at>start&&r.published_at<=end).length;
      return {start:iso(start),end:iso(end),count:count || coverageFraction(ranges,start,end)>0?count:null,partial:true};
    })};
}
