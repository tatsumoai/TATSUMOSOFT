import { DAY, HOUR, iso } from './model.mjs';

export const MIN_VOLUME = 20;
export const MIN_COVERAGE = 0.95;
export function mergeRanges(ranges) {
  const merged = [];
  for (const [start,end] of ranges.filter(r => Array.isArray(r) && r.length===2 && r.every(Number.isFinite) && r[1]>r[0]).sort((a,b)=>a[0]-b[0])) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1],end);
    else merged.push([start,end]);
  }
  return merged;
}
export function coverageFraction(ranges, start, end) {
  return mergeRanges(ranges.map(([a,b])=>[Math.max(a,start),Math.min(b,end)]))
    .reduce((total,[a,b])=>total+b-a,0)/(end-start);
}
function comparison(source, unit, recent, baseline, extra={}) {
  const details = { source, unit, recent, baseline, ...extra };
  if (recent.count < MIN_VOLUME || baseline.count < MIN_VOLUME) return { ...details, status:'low_volume', percent:null, multiple:null };
  const multiple=(recent.count/recent.hours)/(baseline.count/baseline.hours);
  return { ...details, status:'measured', multiple, percent:(multiple-1)*100 };
}
export function mastodonGrowth(rows, now) {
  const today=Math.floor(now/DAY)*DAY, recentDay=today-DAY;
  const byDay=new Map(rows.map(row=>[row.day,row]));
  const recent=byDay.get(recentDay);
  if (!recent || recent.checked_at<today) return null;
  const baseline=[];
  // Only consecutive, completed UTC days. Never compare partial today with whole days.
  for(let day=today-2*DAY;day>=today-13*DAY;day-=DAY) {
    const row=byDay.get(day);
    if(!row || row.checked_at<day+DAY) break;
    baseline.push(row);
  }
  if(baseline.length<3) return null;
  return comparison('mastodon.social','uses',
    {count:recent.uses,hours:24,start:iso(recentDay),end:iso(today)},
    {count:baseline.reduce((sum,r)=>sum+r.uses,0),hours:baseline.length*24,days:baseline.length,start:iso(baseline.at(-1).day),end:iso(recentDay)},
    {period:'Latest complete UTC day vs preceding daily average'});
}
export function blueskyGrowth(row, now, coverage) {
  if (!row || coverage.recent<MIN_COVERAGE || coverage.baseline<MIN_COVERAGE) return null;
  return comparison('Bluesky','captured posts',
    {count:row.recent,hours:6,start:iso(now-6*HOUR),end:iso(now)},
    {count:row.baseline,hours:24,start:iso(now-30*HOUR),end:iso(now-6*HOUR)},
    {period:'Last 6 hours vs preceding 24 hours, compared per hour',coverage});
}
export function rankByGrowth(candidates, dailyRows, postRows, ranges, now, previous=[], redditGrowth=new Map()) {
  const daily=new Map(), posts=new Map(postRows.map(r=>[r.trend_id,r]));
  for(const row of dailyRows) { if(!daily.has(row.trend_id))daily.set(row.trend_id,[]);daily.get(row.trend_id).push(row); }
  const coverage={recent:coverageFraction(ranges,now-6*HOUR,now),baseline:coverageFraction(ranges,now-30*HOUR,now-6*HOUR)};
  const rows=candidates.map(candidate=>{
    const { score:activityStrength, ...row }=candidate;
    const comparisons=[mastodonGrowth(daily.get(row.id)||[],now),blueskyGrowth(posts.get(row.id),now,coverage),redditGrowth.get(row.id)].filter(Boolean);
    const measured=comparisons.filter(c=>c.status==='measured').sort((a,b)=>b.percent-a.percent || b.recent.count-a.recent.count);
    return {...row,activityStrength,growth:measured[0] || comparisons[0] || {status:'insufficient_history',percent:null,multiple:null},growthComparisons:comparisons};
  });
  const measuredCount=rows.filter(row=>row.growth.status==='measured').length;
  rows.sort((a,b)=>{
    const am=a.growth.status==='measured',bm=b.growth.status==='measured';
    if(am!==bm)return am?-1:1;
    if(am)return b.growth.percent-a.growth.percent || b.growth.recent.count-a.growth.recent.count || a.key.localeCompare(b.key);
    return b.activityStrength-a.activityStrength || a.key.localeCompare(b.key);
  });
  const previousRanks=new Map(previous.map(row=>[row.id,row.rank]));
  return {measuredCount,trends:rows.slice(0,100).map(({activityStrength,...row},index)=>({...row,rank:index+1,
    movement:previousRanks.has(row.id)?previousRanks.get(row.id)-index-1:null}))};
}
