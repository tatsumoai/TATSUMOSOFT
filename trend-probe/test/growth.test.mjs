import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY,HOUR } from '../src/tracker/model.mjs';
import { coverageFraction,mastodonGrowth,blueskyGrowth,rankByGrowth } from '../src/tracker/growth.mjs';
import { Store } from '../src/tracker/store.mjs';

const now=Date.parse('2026-11-04T12:00:00Z'),today=Math.floor(now/DAY)*DAY;
const row=(offset,uses)=>({trend_id:1,day:today-offset*DAY,uses,checked_at:now});
const candidate=(id,score)=>({id,key:`topic ${id}`,name:`Topic ${id}`,score});

test('daily growth is explainable from counts and excludes the incomplete current day',()=>{
  const result=mastodonGrowth([row(0,1),row(1,626),row(2,292),row(3,185),row(4,165),row(5,159),row(6,177)],now);
  assert.equal(result.status,'measured');
  assert.equal(result.baseline.count,978);assert.equal(result.baseline.days,5);
  assert.ok(Math.abs(result.multiple-626/195.6)<1e-10);
  assert.ok(Math.abs(result.percent-220.040899795501)<1e-8);
  assert.equal(mastodonGrowth([row(1,100),row(3,100),row(4,100),row(5,100)],now),null,'missing adjacent days cannot be skipped');
  assert.equal(mastodonGrowth([{...row(1,100),checked_at:today-1},row(2,100),row(3,100),row(4,100)],now),null,'an old partial snapshot is not a complete day');
});

test('stream comparisons normalize different time windows and reject sparse coverage',()=>{
  const growth=blueskyGrowth({recent:120,baseline:240},now,{recent:1,baseline:1});
  assert.equal(growth.multiple,2);assert.equal(growth.percent,100);
  assert.equal(blueskyGrowth({recent:120,baseline:240},now,{recent:0.94,baseline:1}),null);
  const ranges=[[now-30*HOUR,now-10*HOUR],[now-12*HOUR,now-6*HOUR]];
  assert.equal(coverageFraction(ranges,now-30*HOUR,now-6*HOUR),1,'overlapping replay windows count once');
  assert.equal(coverageFraction([[now-30*HOUR,now-18*HOUR]],now-30*HOUR,now-6*HOUR),0.5);
});

test('tiny or zero baselines do not produce inflated or infinite growth',()=>{
  for(const baseline of [0,1,19]) {
    const result=blueskyGrowth({recent:100,baseline},now,{recent:1,baseline:1});
    assert.equal(result.status,'low_volume');assert.equal(result.percent,null);
  }
  assert.equal(blueskyGrowth({recent:2,baseline:20},now,{recent:1,baseline:1}).status,'low_volume');
});

test('fastest growth wins over raw volume and old strength; cutoff occurs after growth ranking',()=>{
  const candidates=Array.from({length:110},(_,i)=>candidate(i,10000-i));
  const counts=candidates.map(c=>({trend_id:c.id,recent:1000,baseline:4000}));
  counts[109]={trend_id:109,recent:60,baseline:40};
  const result=rankByGrowth(candidates,[],counts,[[now-30*HOUR,now]],now,[{id:109,rank:50}]);
  assert.equal(result.trends.length,100);assert.equal(result.measuredCount,110);
  assert.equal(result.trends[0].id,109);assert.equal(result.trends[0].growth.multiple,6);
  assert.equal(result.trends[0].growth.percent,500);assert.equal(result.trends[0].movement,49);
  assert.equal(result.trends[0].score,undefined);
});

test('store ranks growth from source data, without treating listing polls as uses',()=>{
  const store=new Store(':memory:',now);
  try {
    store.ingest({id:'mastodon-tags',status:'ok',items:[
      {title:'#Steady',url:'https://example.com/steady',history:[1,2,3,4].map(n=>({dayUnix:(today-n*DAY)/1000,uses:1000,accounts:500}))},
      {title:'#Rising',url:'https://example.com/rising',history:[1,2,3,4].map(n=>({dayUnix:(today-n*DAY)/1000,uses:n===1?90:30,accounts:20}))}
    ]},now);
    const ranking=store.refresh(now);
    assert.equal(ranking.trends[0].name,'#Rising');assert.equal(ranking.trends[0].growth.percent,200);
    assert.equal(ranking.measuredGrowthCount,2);assert.equal(ranking.warmingUp,false);
    store.state('bluesky-stream','ok','live',now);store.state('bluesky-stream','ok','live',now+15000);
    store.state('bluesky-stream','ok','live',now+HOUR);
    assert.deepEqual(store.get('streamUsageCoverage'),[[now,now+15000]],'offline intervals cannot become coverage');
  }finally{store.close();}
});
