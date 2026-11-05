import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/tracker/store.mjs';
import { HOUR, WINDOW } from '../src/tracker/model.mjs';
import { collectReddit, redditSource, redditTerms, redditCommunities, redditGrowthRows, REDDIT_INTERVAL } from '../src/tracker/reddit.mjs';
import { chooseRedditTarget, redditTopicCandidates, recordRedditDiscovery, redditPostMovement } from '../src/tracker/reddit-discovery.mjs';
const now=Date.parse('2026-11-04T12:00:00Z');
const post=(id,community,title='Quantum waffle arrives')=>({id:`t3_${id}`,community,title,publishedAt:new Date(now-HOUR).toISOString(),url:`https://www.reddit.com/r/${community}/comments/${id}/example/`,metrics:{}});
const seeds=[post('a','gaming','Quantum waffle arrives'),post('b','movies','A quantum waffle appears'),post('c','news','Meet the quantum waffle')];

test('broad discovery rotates individual Rising feeds with Hot and never schedules r/all',()=>{
  const s=new Store(':memory:',now);try{
    const communities=redditCommunities({});
    assert.ok(communities.includes('politics')&&communities.includes('sports')&&communities.includes('movies'));
    for(const [step,key] of [[0,'community:news:rising'],[1,'popular:hot'],[2,'community:news:rising']]){
      s.set('redditDiscoveryStep',step);assert.equal(chooseRedditTarget(s,communities,{},now).key,key);
    }
    s.set('redditDiscoveryStep',3);s.set('redditNextCommunity',1);const focus=chooseRedditTarget(s,communities,{},now);
    assert.equal(focus.kind,'rising');assert.equal(focus.community,'gaming');
    s.set('redditNextCommunity',2);assert.equal(chooseRedditTarget(s,communities,{},now).community,'movies');
    for(let step=0;step<30;step++){
      s.set('redditDiscoveryStep',step);assert.notEqual(chooseRedditTarget(s,communities,{},now).community,'all');
    }
    assert.throws(()=>redditCommunities({REDDIT_COMMUNITIES:'news,all'}),/actual community/);
  }finally{s.close();}
});

test('cross-community candidates receive bounded follow-up searches with encoded parameters',()=>{
  const s=new Store(':memory:',now);try{
    s.set('redditStrategy','broad');s.ingestReddit(seeds,'all',now);s.set('redditDiscoveryStep',5);
    const target=chooseRedditTarget(s,redditCommunities({}),{},now);
    assert.equal(target.kind,'search');assert.equal(target.query,'quantum waffle');
    const url=new URL(redditSource(target,{}).url);
    assert.equal(url.pathname,'/search.rss');assert.equal(url.searchParams.get('q'),'"quantum waffle"');
    assert.equal(url.searchParams.get('sort'),'new');assert.equal(url.searchParams.get('restrict_sr'),'off');
    assert.equal(url.searchParams.get('t'),'month');
  }finally{s.close();}
});

test('broad results preserve actual communities and duplicate listings do not add uses',async()=>{
  const s=new Store(':memory:',now);try{
    let time=now,calls=0;
    const request=async source=>{calls++;assert.ok(source.url.includes(calls===1?'/news/rising.rss':'/popular/hot.rss'));return {status:'ok',items:calls===1?[seeds[2]]:seeds,headers:{}};};
    await collectReddit(s,{env:{},clock:()=>time,request});
    time+=REDDIT_INTERVAL;await collectReddit(s,{env:{},clock:()=>time,request});
    const r=s.refresh(time),summary=s.redditSummary(time);
    assert.equal(summary.total,3);assert.equal(summary.communityCount,3);assert.equal(summary.feeds.length,2);
    assert.deepEqual(summary.observedCommunities,['gaming','movies','news']);
    assert.equal(r.trends.find(t=>t.key==='quantum waffle').usage[0].last24h,3);
    assert.equal(s.get('redditCoverage'),null,'ranked feeds cannot establish chronological coverage');
    assert.equal(redditGrowthRows(s,time).size,0);
    assert.equal(s.prepare('SELECT COUNT(*) n FROM reddit_observations').get().n,4,'snapshots remain separate from unique-post counts');
    s.prune(time+WINDOW);
    assert.equal(s.prepare('SELECT COUNT(*) n FROM reddit_observations').get().n,0);
    assert.equal(s.prepare('SELECT COUNT(*) n FROM reddit_fetches').get().n,0);
  }finally{s.close();}
});

test('broad discovery does not hop feeds after a rate limit or invent a source community',async()=>{
  const s=new Store(':memory:',now);try{
    await collectReddit(s,{env:{},clock:()=>now,request:async()=>({status:'rate_limited',items:[],detail:'HTTP 429'})});
    assert.equal(s.get('redditDiscoveryStep'),null);
    await collectReddit(s,{env:{},clock:()=>now+REDDIT_INTERVAL,request:()=>assert.fail('must respect shared cooldown')});
    s.ingestReddit([{...post('a','news'),community:''}],'all',now);
    assert.equal(s.redditSummary(now).total,0);
  }finally{s.close();}
});

test('one denied RSS feed pauses only that feed and preserves paced access to other Rising feeds',async()=>{
  const s=new Store(':memory:',now);try{
    await collectReddit(s,{env:{},clock:()=>now,request:async()=>({status:'access_denied',items:[],detail:'HTTP 403'})});
    assert.equal(s.get('redditFeedPauses')['xml:community:news:rising'].until,now+HOUR);
    await collectReddit(s,{env:{},clock:()=>now+REDDIT_INTERVAL-1,request:()=>assert.fail('must not bypass shared pacing')});
    await collectReddit(s,{env:{},clock:()=>now+REDDIT_INTERVAL,request:async source=>{
      assert.ok(source.url.includes('/r/gaming/rising.rss'));
      return {status:'ok',items:[post('a','gaming')],headers:{}};
    }});
    assert.equal(s.redditSummary(now+REDDIT_INTERVAL).total,1);
    assert.equal(chooseRedditTarget(s,redditCommunities({}),{},now+REDDIT_INTERVAL).key,'popular:hot','a success resumes the broad discovery schedule');
    s.set('redditDiscoveryStep',0);s.set('redditNextCommunity',0);
    const apiTarget=chooseRedditTarget(s,redditCommunities({}),{REDDIT_ACCESS_TOKEN:'test-token'},now+REDDIT_INTERVAL);
    assert.equal(apiTarget.key,'community:news:rising','an RSS denial does not establish an authenticated API denial');
  }finally{s.close();}
});

test('repeated denials pause all Reddit requests and Retry-After is respected on a 403',async()=>{
  const s=new Store(':memory:',now),other=new Store(':memory:',now);try{
    const denied=async()=>({status:'access_denied',httpStatus:403,items:[],detail:'HTTP 403'});
    await collectReddit(s,{env:{},clock:()=>now,request:denied});
    await collectReddit(s,{env:{},clock:()=>now+REDDIT_INTERVAL,request:denied});
    assert.equal(s.prepare("SELECT next_at FROM source_state WHERE source='reddit-posts'").get().next_at,now+REDDIT_INTERVAL+HOUR);
    await collectReddit(s,{env:{},clock:()=>now+2*REDDIT_INTERVAL,request:()=>assert.fail('repeated denials must stop further probes')});
    await collectReddit(other,{env:{},clock:()=>now,request:async()=>({...await denied(),headers:{'retry-after':'7200'}})});
    assert.equal(other.prepare("SELECT next_at FROM source_state WHERE source='reddit-posts'").get().next_at,now+2*HOUR);
    assert.equal(other.get('redditLastRequest').endpoint,'https://www.reddit.com/r/news/rising.rss?limit=100');
  }finally{s.close();other.close();}
});

test('template titles and single-community repetition are not highlighted as spreading topics',()=>{
  const s=new Store(':memory:',now);try{
    s.set('redditStrategy','broad');
    assert.deepEqual(redditTerms('me_irl','me_irl'),[]);assert.deepEqual(redditTerms('meirl','me_irl'),[]);
    s.ingestReddit(seeds.map(p=>({...p,community:'gaming'})),'all',now);
    assert.equal(redditTopicCandidates(s,now).length,0);assert.equal(s.refresh(now).trends.length,0);
    s.ingestReddit(seeds,'all',now);
    assert.equal(redditTopicCandidates(s,now)[0].name,'quantum waffle');
    assert.equal(new Set(redditTopicCandidates(s,now)[0].samples.map(p=>p.community)).size,2,'supporting links should demonstrate distinct communities');
    assert.equal(s.refresh(now).trends.filter(t=>t.key==='quantum waffle').length,1);
    s.ingestReddit([post('d','memes','me_irl'),post('e','me_irl','me_irl')],'all',now);
    assert.ok(!redditTopicCandidates(s,now).some(t=>t.name==='irl'));
  }finally{s.close();}
});

test('post movement compares the same feed and engagement uses real metric snapshots',()=>{
  const s=new Store(':memory:',now);try{
    const a=post('a','news');s.ingestReddit([a],'all',now);
    const observe=(feed,at,position,metrics={})=>{
      s.prepare('INSERT INTO reddit_observations VALUES(?,?,?,?,?,?)').run(feed,a.id,at,position,metrics.score??null,metrics.comments??null);
    };
    observe('all:rising',now,80,{score:10,comments:5});
    observe('popular:hot',now+REDDIT_INTERVAL,2);
    assert.equal(redditPostMovement(s,a.id,now+REDDIT_INTERVAL).movement,null,'different feed ranks are not comparable');
    observe('all:rising',now+2*REDDIT_INTERVAL,20,{score:22,comments:9});
    const measured=redditPostMovement(s,a.id,now+2*REDDIT_INTERVAL);
    assert.equal(measured.movement.places,60);assert.equal(measured.movement.from,80);assert.equal(measured.movement.to,20);
    assert.equal(measured.engagement.commentChange,4);assert.equal(measured.engagement.scoreChange,12);
    observe('all:rising',now+3*REDDIT_INTERVAL,10);
    assert.equal(redditPostMovement(s,a.id,now+3*REDDIT_INTERVAL).engagement.toAt,measured.engagement.toAt,'RSS cannot manufacture fresh score or comment readings');
  }finally{s.close();}
});
