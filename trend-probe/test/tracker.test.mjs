import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Store } from '../src/tracker/store.mjs';
import { DAY,HOUR,WINDOW,canonical,ageLabel,sixMonthsAgo,rankCandidates } from '../src/tracker/model.mjs';
import { createHandler } from '../src/tracker/server.mjs';
import { importBackfill } from '../src/tracker/import_backfill.mjs';

const now=Date.parse('2026-11-03T15:30:00Z');
const listing=(name,source='google-trends')=>({id:source,status:'ok',items:[{title:name,url:'https://example.com/topic'}]});
const post=(author,id,tag='Cats',time=now)=>({id:`at://did:plc:${author}/app.bsky.feed.post/${id}`,publishedAt:new Date(time).toISOString(),tags:[tag],url:'https://bsky.app/profile/example/post/1'});

test('undated topics stay unknown; dated topics use the six-month cutoff and older evidence takes precedence',()=>{
  assert.equal(ageLabel([],now),'unknown');
  assert.equal(ageLabel([{kind:'occurrence',occurred_at:now-DAY}],now),'new');
  assert.equal(ageLabel([{kind:'origin',occurred_at:now-DAY}],now),'new');
  assert.equal(ageLabel([{kind:'origin',occurred_at:now-DAY},{kind:'occurrence',occurred_at:now-300*DAY}],now),'legacy');
  assert.equal(ageLabel([{kind:'occurrence',occurred_at:sixMonthsAgo(now)}],now),'new');
  assert.equal(ageLabel([{kind:'occurrence',occurred_at:sixMonthsAgo(now)-1}],now),'legacy');
  assert.equal(new Date(sixMonthsAgo(Date.parse('2026-08-31T12:00:00Z'))).toISOString(),'2026-02-28T12:00:00.000Z');
});
test('repeat polls update one hourly signal rather than inventing new mentions',()=>{
  const s=new Store(':memory:',now);try{
    s.ingest(listing('Cats'),now);s.ingest(listing('Cats'),now+60000);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM signals').get().n,1);
    assert.equal(s.refresh(now+60000).trends.length,1);
  }finally{s.close();}
});
test('estimated recent ages distinguish verified origins and yield to older evidence',()=>{
  const s=new Store(':memory:',now);try{
    s.ingest(listing('Cats'),now);
    let row=s.refresh(now).trends[0];
    assert.equal(row.age,'unknown');assert.equal(row.ageEstimated,false);
    s.addEvidence({name:'Cats',date:'2026-11-01',kind:'occurrence',url:'https://example.com/recent',note:'Recent reference'},now);
    row=s.refresh(now).trends[0];
    assert.equal(row.age,'new');assert.equal(row.ageEstimated,true);
    s.addEvidence({name:'Cats',date:'2026-10-31',kind:'origin',url:'https://example.com/origin',note:'Verified origin'},now);
    row=s.refresh(now).trends[0];
    assert.equal(row.age,'new');assert.equal(row.ageEstimated,false);
    s.addEvidence({name:'Cats',date:'2025-01-01',kind:'occurrence',url:'https://example.com/older',note:'Earlier evidence'},now);
    row=s.refresh(now).trends[0];
    assert.equal(row.age,'legacy');assert.equal(row.ageEstimated,false);
  }finally{s.close();}
});
test('replayed posts and repeated authors do not inflate a topic within an hour',()=>{
  const s=new Store(':memory:',now);try{
    s.ingestPost(post('a','1'),now);s.ingestPost(post('a','1'),now);s.ingestPost(post('a','2'),now);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM signals').get().n,1);
    assert.equal(s.refresh(now).trends.length,0,'one author cannot promote a stream-only tag');
    s.ingestPost(post('b','1'),now);s.ingestPost(post('c','1'),now);
    assert.equal(s.refresh(now).trends[0].independentAuthors,3);
    s.ingestPost(post('a','1'),now+HOUR);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM signals').get().n,3,'same old post is not new in a later hour');
  }finally{s.close();}
});
test('age evidence persists after exact 14-day expiry while activity and dedup rows are removed',()=>{
  const s=new Store(':memory:',now);try{
    s.addEvidence({name:'Rickrolling',aliases:['rick roll'],date:'2008-12-10',kind:'occurrence',url:'https://example.com/history',note:'Dated historical record'},now);
    s.ingest(listing('Rick Roll'),now);
    s.ingestPost(post('a','1'),now);
    assert.equal(s.refresh(now).trends[0].age,'legacy');
    assert.equal(s.refresh(now+WINDOW).trends.length,0);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM signals').get().n,0);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM seen_posts').get().n,0);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM evidence').get().n,1);
    s.ingest(listing('Rick Roll'),now+WINDOW+1);
    assert.equal(s.refresh(now+WINDOW+1).trends[0].age,'legacy');
  }finally{s.close();}
});
test('future and old stream records are rejected; only active signals enter rankings',()=>{
  const s=new Store(':memory:',now);try{
    s.ingestPost(post('a','old','Cats',now-WINDOW),now);s.ingestPost(post('a','future','Cats',now+DAY),now);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM signals').get().n,0);
  }finally{s.close();}
});
test('normalization and explicit aliases group topics across sources; identity is first observed on activity',()=>{
  const s=new Store(':memory:',now);try{
    assert.equal(canonical('#Ｃａｔｓ'),'cats');
    s.addEvidence({name:'Rickrolling',aliases:['Rick Roll'],date:'2008-12-10',kind:'occurrence',url:'https://example.com/history',note:'Record'},now);
    assert.equal(s.db.prepare('SELECT first_observed FROM trends').get().first_observed,null);
    s.ingest(listing('Rick Roll'),now);s.ingest(listing('Rickrolling','bluesky-topics'),now);
    const r=s.refresh(now);assert.equal(r.trends.length,1);assert.equal(r.trends[0].sources.length,2);
    assert.equal(r.trends[0].firstObservedAt,new Date(now).toISOString());
  }finally{s.close();}
});
test('daily Mastodon counts are replaced, including corrections to zero, rather than accumulated on every fetch',()=>{
  const s=new Store(':memory:',now);try{
    const r={id:'mastodon-tags',status:'ok',items:[{title:'#cats',url:'https://mastodon.social/tags/cats',history:[{dayUnix:Math.floor(now/DAY)*DAY/1000,accounts:10}]}]};
    s.ingest(r,now);s.ingest(r,now+60000);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM signals').get().n,1);
    r.items[0].history[0].accounts=0;s.ingest(r,now);
    assert.equal(s.refresh(now).trends.length,0);
  }finally{s.close();}
});
test('candidate discovery caps at 100 and reports movement while growth baselines are unavailable',()=>{
  const s=new Store(':memory:',now);try{
    for(let i=0;i<110;i++)s.ingest(listing(`Topic ${i.toString().padStart(3,'0')}`),now);
    let r=s.refresh(now);assert.equal(r.trends.length,100);assert.equal(r.candidateCount,110);
    s.ingest(listing('Topic 109','bluesky-topics'),now);r=s.refresh(now+1000);
    assert.equal(r.trends[0].name,'Topic 109');assert.equal(r.trends[0].movement,null);
    assert.equal(r.trends[0].growth.status,'insufficient_history');assert.equal(r.trends[0].score,undefined,'old opaque score is not public');
    s.ingest(listing('Topic 001','bluesky-topics'),now+DAY);
    assert.ok(s.refresh(now+DAY).trends.find(x=>x.name==='Topic 001').movement>0);
  }finally{s.close();}
});
test('momentum is withheld until a 48-hour baseline exists',()=>{
  const t=[{id:1,canonical:'cats',name:'Cats',kind:'topic',first_observed:now}];
  const signal=[{trend_id:1,source:'google-trends',at:now,weight:1,kind:'listing',url:'https://example.com'}];
  assert.equal(rankCandidates(t,signal,[],now,now)[0].momentum,null);
  assert.equal(rankCandidates(t,signal,[],now,now-3*DAY)[0].momentum,null,'time offline cannot establish a baseline');
  const coverage=Array.from({length:48},(_,i)=>({source:'google-trends',bucket:now-i*HOUR}));
  assert.notEqual(rankCandidates(t,signal,[],now,now-3*DAY,[],coverage)[0].momentum,null);
});
test('database survives restart and source failure retains last success as stale',()=>{
  const dir=mkdtempSync(join(tmpdir(),'trend-test-'));let s;
  try{
    s=new Store(join(dir,'db.sqlite'),now);s.ingest(listing('Cats'),now);s.state('google-trends','ok','working',now);s.refresh(now);s.close();
    s=new Store(join(dir,'db.sqlite'),now+DAY);s.state('google-trends','network_error','failed',now+DAY);
    const r=s.publicRanking(now+DAY);assert.equal(r.trends[0].name,'Cats');assert.equal(r.sources[0].stale,true);assert.equal(r.sources[0].lastSuccessAt,new Date(now).toISOString());
  }finally{
    s?.close();
    if(dirname(resolve(dir))!==resolve(tmpdir())||!basename(dir).startsWith('trend-test-'))throw new Error('Unexpected temporary test directory');
    rmSync(dir,{recursive:true,force:true});
  }
});
test('HTTP API exposes rankings, rejects writes and does not expose database or env files',async()=>{
  const s=new Store(':memory:',now);s.ingest(listing('Cats'),now);s.refresh(now);
  const server=createServer(createHandler(s));server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    assert.equal((await(await fetch(base+'/api/trends')).json()).trends[0].name,'Cats');
    assert.equal((await fetch(base+'/api/trends',{method:'POST'})).status,405);
    assert.equal((await fetch(base+'/trend-probe/data/trends.sqlite')).status,404);
    assert.equal((await fetch(base+'/.env')).status,404);
    assert.equal((await fetch(base+'/tracker.js')).status,200);
  }finally{await new Promise(resolve=>server.close(resolve));s.close();}
});

test('source dates precede collection dates and preserve their distinct meanings',()=>{
  const s=new Store(':memory:',now);try{
    s.ingest({id:'google-trends',status:'ok',items:[{title:'Topic report',url:'https://example.com/feed',publishedAt:new Date(now-2*DAY).toISOString()}]},now);
    s.ingest({id:'hacker-news',status:'ok',items:[{title:'Older story',url:'https://example.com/story',publishedAt:new Date(now-4*DAY).toISOString()}]},now);
    const rows=s.refresh(now).trends;
    const g=rows.find(t=>t.name==='Topic report'), hn=rows.find(t=>t.name==='Older story');
    assert.equal(g.firstObservedAt,new Date(now).toISOString());
    assert.equal(g.earliestKnownAt,new Date(now-2*DAY).toISOString());
    assert.equal(g.sourceHistory[0].kind,'trend_feed_published');
    assert.equal(hn.sourceHistory[0].kind,'story_published');
    assert.equal(hn.earliestKnownAt,new Date(now-4*DAY).toISOString());
    assert.equal(g.age,'new');
    assert.equal(g.ageEstimated,true,'recent publication supports only an estimated age');
    s.ingest({id:'google-trends',status:'ok',items:[{title:'Topic report',url:'https://example.com/feed',publishedAt:new Date(now).toISOString()}]},now);
    assert.equal(s.refresh(now).trends.find(t=>t.name==='Topic report').earliestKnownAt,g.earliestKnownAt);
  }finally{s.close();}
});
test('Mastodon uses oldest nonzero usage day, not the oldest empty history bucket',()=>{
  const s=new Store(':memory:',now);try{
    const day=Math.floor(now/DAY)*DAY;
    s.ingest({id:'mastodon-tags',status:'ok',items:[{title:'#Cats',url:'https://example.com/cats',history:[{dayUnix:(day-6*DAY)/1000,accounts:0,uses:0},{dayUnix:(day-3*DAY)/1000,accounts:2,uses:4},{dayUnix:day/1000,accounts:10,uses:20}]}]},now);
    const row=s.refresh(now).trends[0];
    assert.equal(row.earliestKnownAt,new Date(day-3*DAY).toISOString());
    assert.equal(row.sourceHistory[0].precision,'day');
  }finally{s.close();}
});
test('historical source evidence survives retention and automatically establishes legacy; missing dates stay absent',()=>{
  const s=new Store(':memory:',now);try{
    s.ingest({id:'hacker-news',status:'ok',items:[{title:'Old exact story',url:'https://example.com/old',publishedAt:new Date(now-300*DAY).toISOString()}]},now);
    s.ingest(listing('No supplied date','bluesky-topics'),now);
    let rows=s.refresh(now).trends;
    assert.equal(rows.find(t=>t.name==='Old exact story').age,'legacy');
    assert.equal(rows.find(t=>t.name==='No supplied date').earliestKnownAt,null);
    s.prune(now+WINDOW+1);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM source_dates').get().n,1);
    s.ingest(listing('Old exact story','hacker-news'),now+WINDOW+1);
    assert.equal(s.refresh(now+WINDOW+1).trends[0].age,'legacy');
  }finally{s.close();}
});
test('schema upgrade backfills source-derived dates but never treats old poll times as publication dates',()=>{
  const dir=mkdtempSync(join(tmpdir(),'trend-test-'));let s;
  try{
    const path=join(dir,'db.sqlite');s=new Store(path,now);
    s.ingest(listing('Only a poll','google-trends'),now-2*DAY);
    s.ingest({id:'mastodon-tags',status:'ok',items:[{title:'#History',url:'https://example.com/h',history:[{dayUnix:(Math.floor(now/DAY)*DAY-4*DAY)/1000,accounts:3}]}]},now);
    s.db.exec('DROP TABLE source_dates; PRAGMA user_version=1;');s.close();s=new Store(path,now);
    const rows=s.refresh(now).trends;
    assert.equal(rows.find(t=>t.name==='Only a poll').earliestKnownAt,null);
    assert.equal(rows.find(t=>t.name==='#History').sourceHistory[0].kind,'usage_day');
    assert.equal(s.db.prepare('PRAGMA user_version').get().user_version,2);
  }finally{
    s?.close();
    if(dirname(resolve(dir))!==resolve(tmpdir())||!basename(dir).startsWith('trend-test-'))throw new Error('Unexpected temporary test directory');
    rmSync(dir,{recursive:true,force:true});
  }
});


test('24-hour usage counts distinct posts, not author-capped ranking signals or feed polls',()=>{
  const s=new Store(':memory:',now);try{
    s.ingest(listing('Cats'),now);
    s.ingest(listing('No count'),now);
    const repeated={...post('a','1'),tags:['Cats','#cats','CATS']};
    s.ingestPost(repeated,now);s.ingestPost(repeated,now);
    s.ingestPost(post('a','2'),now);
    s.ingestPost(post('b','boundary','Cats',now-DAY),now);
    s.ingestPost(post('b','inside','Cats',now-DAY+1),now);
    let row=s.refresh(now).trends.find(t=>t.name==='Cats');
    assert.equal(row.usage24h.count,3);
    assert.equal(row.usage24h.countingSince,new Date(now).toISOString());
    assert.equal(row.usage24h.partial,true);
    assert.equal(s.refresh(now).trends.find(t=>t.name==='No count').usage24h.count,null);
    assert.equal(s.refresh(now+1).trends.find(t=>t.name==='Cats').usage24h.count,2);
    s.ingest(listing('Cats'),now+DAY);
    assert.equal(s.refresh(now+DAY).trends.find(t=>t.name==='Cats').usage24h.count,0);
    s.prune(now+WINDOW);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM post_usage').get().n,0);
  }finally{s.close();}
});

test('Mastodon calendar-day uses stay separate, replace repeated polls and accept zero corrections',()=>{
  const s=new Store(':memory:',now);try{
    const day=Math.floor(now/DAY)*DAY;
    const r={id:'mastodon-tags',status:'ok',items:[{title:'#Cats',url:'https://example.com/cats',history:[{dayUnix:day/1000,accounts:3,uses:20},{dayUnix:(day-DAY)/1000,accounts:2,uses:50}]}]};
    s.ingest(r,now);s.ingest(r,now);
    let row=s.refresh(now).trends[0];
    assert.equal(row.mastodonToday.count,20);
    assert.equal(row.usage24h.count,0);
    r.items[0].history[0].uses=0;s.ingest(r,now);
    assert.equal(s.refresh(now).trends[0].mastodonToday.count,0);
    assert.equal(s.refresh(day+DAY).trends[0].mastodonToday,null);
    s.prune(now+WINDOW);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM daily_usage').get().n,0);
  }finally{s.close();}
});

test('usage histories preserve real daily totals, missing dates and the last complete day',()=>{
  const s=new Store(':memory:',now);try{
    const day=Math.floor(now/DAY)*DAY;
    s.ingest({id:'mastodon-tags',status:'ok',items:[{title:'#Vote',url:'https://example.com/vote',history:[
      {dayUnix:day/1000,uses:7,accounts:7}, {dayUnix:(day-DAY)/1000,uses:626,accounts:407},
      {dayUnix:(day-2*DAY)/1000,uses:292,accounts:148}, {dayUnix:(day-3*DAY)/1000,uses:0,accounts:0}
    ]}]},now);
    const summary=s.refresh(now).trends[0].usage[0];
    assert.equal(summary.total,925);
    assert.equal(summary.daysAvailable,4);
    assert.equal(summary.lastFullDay.count,626);
    assert.equal(summary.points[9].count,null,'missing history must not appear as a zero');
    assert.equal(summary.points[10].count,0,'a supplied zero is retained');
    assert.equal(summary.points[13].partial,true,'today is an incomplete UTC day');
  }finally{s.close();}
});

test('historical replay restores previously capped usage without duplicates or regressing activity time',()=>{
  const s=new Store(':memory:',now);try{
    s.ingest(listing('Cats'),now);
    const recent=post('a','recent','Cats',now);
    const older=post('a','older','Cats',now-1000);
    s.ingestPost(recent,now);
    s.db.exec('DELETE FROM post_usage'); // Simulate pre-usage-tracking records.
    s.ingestPost(recent,now);s.ingestPost(recent,now);s.ingestPost(older,now);
    assert.equal(s.refresh(now).trends.find(t=>t.key==='cats').usage24h.count,2);
    assert.equal(s.db.prepare("SELECT at FROM signals WHERE kind='post'").get().at,now);
    const many={...post('b','many'),tags:['One','Two','Three','Four','Five','Six']};
    s.ingestPost(many,now);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM post_usage u JOIN trends t ON t.id=u.trend_id WHERE t.canonical='six'").get().n,1);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM signals s JOIN trends t ON t.id=s.trend_id WHERE t.canonical='six'").get().n,0,'rank anti-spam limit remains separate');
  }finally{s.close();}
});

test('backfill import requires complete coverage, is idempotent and records its actual window',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'trend-test-'));const s=new Store(':memory:');
  try{
    const end=Date.now()-1000,start=end-DAY,path=join(dir,'capture.ndjson'),report=join(dir,'capture.json');
    const state={status:'complete',start,end,firstEvent:start+10,lastEvent:end+10,posts:2};
    const item=post('a','historical','Cats',end-10000);
    writeFileSync(path,JSON.stringify(item)+'\n'+JSON.stringify(item)+'\n');
    writeFileSync(report,JSON.stringify({...state,status:'time_limit'}));
    await assert.rejects(importBackfill(s,path),/not completed/);
    writeFileSync(report,JSON.stringify(state));
    s.ingest(listing('Cats'));
    await importBackfill(s,path);await importBackfill(s,path);
    const row=s.refresh().trends[0];
    assert.equal(row.usage24h.count,1);
    assert.equal(row.usage[0].backfillStart,new Date(start).toISOString());
    assert.equal(s.get('usageBackfill').status,'imported');
  }finally{
    s.close();
    if(dirname(resolve(dir))!==resolve(tmpdir())||!basename(dir).startsWith('trend-test-'))throw new Error('Unexpected temporary test directory');
    rmSync(dir,{recursive:true,force:true});
  }
});
