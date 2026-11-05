import test from 'node:test';
import assert from 'node:assert/strict';
import { redditRss } from '../src/parsers.mjs';
import { parseResponse } from '../src/probe.mjs';
import { Store } from '../src/tracker/store.mjs';
import { collectReddit, redditSource, redditTerms, redditGrowthRows, REDDIT_INTERVAL } from '../src/tracker/reddit.mjs';
import { DAY, HOUR, WINDOW } from '../src/tracker/model.mjs';
const now=Date.parse('2026-11-04T12:00:00Z');
const post=(id,title='Quantum waffle returns',at=now-HOUR)=>({id:`t3_${id}`,title,url:`https://www.reddit.com/r/memes/comments/${id}/example/`,publishedAt:new Date(at).toISOString(),metrics:{}});

test('Reddit Atom parses IDs, title entities, links and publication dates without fabricating metrics',()=>{
  const xml='<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>t3_abc</id><title><![CDATA[Cats & hats]]></title><published>2026-11-04T10:00:00Z</published><updated>2026-11-04T11:00:00Z</updated><category term="memes"/><link href="https://www.reddit.com/r/memes/comments/abc/title/"/><content type="html">unneeded post body</content></entry></feed>';
  const result=parseResponse(redditSource('memes',{}),xml,'application/atom+xml');
  assert.equal(result.status,'ok');assert.equal(result.items[0].id,'t3_abc');
  assert.equal(result.items[0].title,'Cats & hats');assert.equal(result.items[0].publishedAt,'2026-11-04T10:00:00.000Z');
  assert.equal(result.items[0].community,'memes');assert.deepEqual(result.items[0].metrics,{});
  assert.equal(redditRss(xml.replace('<title>','<title type="text">'))[0].title,'Cats & hats');
  assert.ok(!JSON.stringify(result).includes('unneeded post body'));
  assert.equal(redditRss('<feed><entry><id>t3_a</id><title>Example</title><updated>2026-11-04T11:00:00Z</updated></entry></feed>')[0].publishedAt,null,'an update time is not a publication time');
  assert.throws(()=>redditRss('<!DOCTYPE feed><feed/>'));
  assert.equal(parseResponse(redditSource('memes',{}),'<html>Login</html>','text/html').status,'unexpected_response');
});

test('Reddit requests share a persistent cooldown and honor a longer Retry-After',async()=>{
  const s=new Store(':memory:',now);try{
    let calls=0, time=now;
    const env={REDDIT_DISCOVERY:'communities',REDDIT_COMMUNITIES:'memes,me_irl'};
    await collectReddit(s,{env,clock:()=>time,request:async source=>{calls++;assert.ok(source.url.includes('/memes/new.rss'));return {status:'ok',items:[post('abc')],detail:'ok'};}});
    await collectReddit(s,{env,clock:()=>time+REDDIT_INTERVAL-1,request:()=>assert.fail('early request')});
    assert.equal(calls,1);assert.equal(s.get('redditNextCommunity'),1);
    time+=REDDIT_INTERVAL;
    await collectReddit(s,{env,clock:()=>time,request:async source=>{calls++;assert.ok(source.url.includes('/me_irl/new.rss'));return {status:'rate_limited',items:[],detail:'HTTP 429',retryAfter:new Date(time+HOUR).toISOString()};}});
    assert.equal(s.prepare("SELECT next_at FROM source_state WHERE source='reddit-posts'").get().next_at,time+HOUR);
    assert.equal(s.get('redditNextCommunity'),1,'do not hop communities after a limit');
    await collectReddit(s,{env,clock:()=>time+20*60000,request:()=>assert.fail('cooldown must survive subsequent passes')});
    assert.equal(s.redditSummary(time).total,1,'a failed check retains previously collected posts');
  }finally{s.close();}
});

test('a configured Reddit token chooses the JSON API and an authentication failure pauses it',async()=>{
  const s=new Store(':memory:',now);try{
    const env={REDDIT_DISCOVERY:'communities',REDDIT_ACCESS_TOKEN:'test-token',REDDIT_COMMUNITIES:'memes'};
    await collectReddit(s,{env,clock:()=>now,request:async source=>{
      assert.equal(new URL(source.url).hostname,'oauth.reddit.com');assert.equal(source.format,'json');
      assert.equal(source.credential.env,'REDDIT_ACCESS_TOKEN');assert.ok(!source.url.includes('test-token'));
      return {status:'authentication_required',items:[],detail:'HTTP 401'};
    }});
    assert.equal(s.prepare("SELECT next_at FROM source_state WHERE source='reddit-posts'").get().next_at,now+HOUR);
  }finally{s.close();}
});

test('Reddit listing coverage needs valid newest-first dates and respects cache age',async()=>{
  const s=new Store(':memory:',now);try{
    const env={REDDIT_DISCOVERY:'communities',REDDIT_COMMUNITIES:'memes'};
    await collectReddit(s,{env,clock:()=>now,request:async()=>({status:'ok',items:[post('old','Quantum waffle',now-2*HOUR),post('new')],headers:{}})});
    assert.equal(s.get('redditCoverage'),null,'out-of-order results cannot claim continuous coverage');
    const later=now+REDDIT_INTERVAL;
    await collectReddit(s,{env,clock:()=>later,request:async()=>({status:'ok',items:[post('new'),post('old','Quantum waffle',now-2*HOUR)],headers:{age:'120'}})});
    assert.deepEqual(s.get('redditCoverage').memes,[[now-2*HOUR,later-120000]]);
    await collectReddit(s,{env,clock:()=>later+REDDIT_INTERVAL,request:async()=>({status:'ok',items:[{...post('undated'),publishedAt:null}],headers:{}})});
    assert.deepEqual(s.get('redditCoverage').memes,[[now-2*HOUR,later-120000]],'undated records do not fill a gap');
  }finally{s.close();}
});

test('Reddit title matches deduplicate posts, promote repeated phrases, and preserve source-specific totals',()=>{
  const s=new Store(':memory:',now);try{
    const items=[post('a'),post('b'),post('c')];
    assert.ok(redditTerms('THE quantum waffle and the quantum waffle').includes('quantum waffle'));
    assert.ok(!redditTerms('the and it').length);
    s.ingestReddit(items.slice(0,2),'memes',now);
    assert.equal(s.refresh(now).trends.length,0,'two titles cannot create an arbitrary new topic');
    s.ingestReddit(items,'memes',now);s.ingestReddit(items,'memes',now);
    const r=s.refresh(now), topic=r.trends.find(t=>t.key==='quantum waffle');
    assert.ok(topic);assert.deepEqual(topic.sources,['Reddit']);
    assert.equal(topic.usage.length,1);assert.equal(topic.usage[0].source,'Reddit');assert.equal(topic.usage[0].last24h,3);
    assert.equal(topic.growth.status,'insufficient_history');assert.equal(topic.age,'new');
    assert.equal(s.redditSummary(now).total,3);assert.equal(s.prepare('SELECT COUNT(*) n FROM reddit_usage WHERE trend_id=?').get(topic.id).n,3);
    s.ingestReddit([post('a','An edited unrelated headline')],'memes',now);
    assert.equal(s.refresh(now).trends.find(t=>t.id===topic.id).usage[0].last24h,2,'edited titles remove their previous matching usage');
    s.refresh(now+WINDOW);
    assert.equal(s.prepare('SELECT COUNT(*) n FROM reddit_posts').get().n,0);
    assert.equal(s.prepare('SELECT COUNT(*) n FROM reddit_terms').get().n,0);
    assert.equal(s.prepare('SELECT COUNT(*) n FROM reddit_usage').get().n,0);
    assert.ok(s.prepare('SELECT COUNT(*) n FROM source_dates').get().n>0);
  }finally{s.close();}
});

test('Reddit growth requires coverage across every monitored community and uses publication-time counts',()=>{
  const s=new Store(':memory:',now);try{
    s.set('redditCommunities',['memes','me_irl']);
    const items=[...Array.from({length:30},(_,i)=>post(`r${i}`,'Quantum waffle',now-HOUR)),...Array.from({length:40},(_,i)=>post(`b${i}`,'Quantum waffle',now-12*HOUR))];
    s.ingestReddit(items,'memes',now);s.syncRedditTopics(now);
    assert.equal(redditGrowthRows(s,now).size,0);
    s.set('redditCoverage',{memes:[[now-30*HOUR,now]]});
    assert.equal(redditGrowthRows(s,now).size,0,'one covered community cannot stand in for the others');
    s.set('redditCoverage',{memes:[[now-30*HOUR,now]],me_irl:[[now-30*HOUR,now]]});
    const r=s.refresh(now).trends.find(t=>t.key==='quantum waffle');
    assert.equal(r.growth.source,'Reddit');assert.equal(r.growth.multiple,3);assert.equal(r.growth.percent,200);
    assert.equal(r.growth.recent.count,30);assert.equal(r.growth.baseline.count,40);
    s.set('redditCoverage',{memes:[[now-20*HOUR,now]],me_irl:[[now-30*HOUR,now]]});
    assert.equal(s.refresh(now).trends.find(t=>t.key==='quantum waffle').growth.status,'insufficient_history');
  }finally{s.close();}
});

test('Reddit charts leave wholly unobserved days as gaps',()=>{
  const s=new Store(':memory:',now);try{
    s.ingestReddit([post('a','Quantum waffle',now-3*DAY-HOUR),post('b'),post('c')],'memes',now);
    const series=s.refresh(now).trends.find(t=>t.key==='quantum waffle').usage[0];
    assert.equal(series.total,3);assert.equal(series.last24h,2);
    assert.equal(series.points.at(-1).count,2);
    assert.equal(series.points.at(-2).count,null,'an unsampled day cannot be reported as zero');
    assert.equal(series.points.at(-4).count,1);
  }finally{s.close();}
});
