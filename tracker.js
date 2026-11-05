(() => {
  const root = document.getElementById('trend-radar');
  if (!root) return;
  const $ = id => document.getElementById(id);
  let data = null, age = 'all', busy = false, failed = false;
  const isPreview = () => data?.preview?.kind === 'snapshot';
  const labels = { new: 'New & Recent', legacy: 'Legacy', unknown: 'Age unknown' };
  const make = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
  const urlSafe = url => { try { const u = new URL(url); return ['http:','https:'].includes(u.protocol) ? u.href : null; } catch { return null; } };
  const link = (text, url, className) => { const el = make(urlSafe(url) ? 'a' : 'span', text, className); if (el.tagName === 'A') { el.href = urlSafe(url); el.target = '_blank'; el.rel = 'noopener noreferrer'; } return el; };
  function activityChart(trend) {
    const series=trend.usage?.find(s=>s.kind==='provider_daily') || trend.usage?.find(s=>s.kind==='captured_posts') || trend.usage?.find(s=>s.kind==='sampled_posts');
    if(!series) return make('div','No usage history supplied','radar-usage-note');
    const points=series.points, values=points.map(p=>p.count);
    const width=168, height=48, step=width/values.length;
    const max=Math.max(1,...values.filter(v=>v!==null)), peak=values.indexOf(Math.max(...values.filter(v=>v!==null)));
    const figure=make('figure',undefined,'radar-chart');
    const ns='http://www.w3.org/2000/svg';
    const draw=(tag,attrs)=>{const el=document.createElementNS(ns,tag);for(const [key,value] of Object.entries(attrs))el.setAttribute(key,String(value));return el;};
    const svg=draw('svg',{viewBox:`0 0 ${width} ${height}`,class:'radar-spark',role:'slider',tabindex:0,'aria-label':`${trend.name}: ${series.source} daily ${series.unit}. Use arrow keys to explore days.`,'aria-valuemin':1,'aria-valuemax':values.length});
    const x=i=>(i+0.5)*step, y=i=>height-5-(height-10)*values[i]/max;
    for(let i=0;i<values.length;i++) {
      svg.append(draw('line',{x1:x(i),x2:x(i),y1:3,y2:height-1,stroke:'#d7cdc1','stroke-width':0.5}));
      if(values[i]===null) continue;
      if(i>0 && values[i-1]!==null) svg.append(draw('line',{x1:x(i-1),x2:x(i),y1:y(i-1),y2:y(i),stroke:'#a81632','stroke-width':2}));
      svg.append(draw('circle',{cx:x(i),cy:y(i),r:1.8,fill:'#a81632'}));
    }
    const marker=draw('circle',{r:3.5,fill:'#a81632',stroke:'#faf6ed','stroke-width':1.5});svg.append(marker);
    const shortDate=time=>new Date(time).toLocaleDateString(undefined,{month:'short',day:'numeric',timeZone:series.kind==='provider_daily'?'UTC':undefined});
    const axis=make('div',undefined,'radar-chart-axis');
    for(const i of [0,6,13])axis.append(make('span',shortDate(points[i].start)));
    const caption=make('figcaption',undefined,'radar-chart-caption');
    let selected=Math.max(0,peak);
    const select=(index,initial=false)=>{
      selected=Math.max(0,Math.min(values.length-1,index));
      const point=points[selected], value=values[selected];
      const dates=series.kind==='provider_daily'?`${shortDate(point.start)} (UTC)`:`${shortDate(point.start)} – ${shortDate(point.end)}`;
      const amount=value===null?'History not supplied':`${value.toLocaleString()} ${series.unit}${point.partial?' (partial)':''}`;
      const detail=`${series.source}: ${new Date(point.start).toLocaleString()} – ${new Date(point.end).toLocaleString()}: ${amount}.`;
      caption.textContent=`${initial&&value!==null?'Peak: ':''}${dates} · ${amount}`;
      figure.title=detail;svg.setAttribute('aria-valuenow',selected+1);svg.setAttribute('aria-valuetext',detail);
      marker.setAttribute('visibility',value===null?'hidden':'visible');
      if(value!==null){marker.setAttribute('cx',x(selected));marker.setAttribute('cy',y(selected));}
    };
    const point=event=>{const box=svg.getBoundingClientRect();select(Math.floor((event.clientX-box.left)/box.width*values.length));};
    svg.addEventListener('pointermove',point);svg.addEventListener('pointerdown',point);
    svg.addEventListener('keydown',event=>{
      const next={ArrowLeft:selected-1,ArrowDown:selected-1,ArrowRight:selected+1,ArrowUp:selected+1,Home:0,End:values.length-1}[event.key];
      if(next!==undefined){event.preventDefault();select(next);}
    });
    select(selected,true);
    figure.append(make('div',`${series.source} · ${series.unit}/day`,'radar-usage-note'),svg,axis,caption);return figure;
  }
  function usageCell(trend) {
    const cell=make('td',undefined,'radar-usage');
    const summaries=trend.usage || [];
    if(!summaries.length)cell.append(make('div','Source supplies no usage count','radar-usage-note'));
    for(const summary of summaries) {
      const block=make('div',undefined,'radar-usage-block');
      const date=value=>new Date(value).toLocaleDateString(undefined,{month:'short',day:'numeric',timeZone:'UTC'});
      if(summary.kind==='provider_daily') {
        block.append(make('strong',`${summary.total.toLocaleString()} uses`));
        block.append(make('div',`${summary.source} · ${summary.daysAvailable}/14 days available`,'radar-usage-note'));
        block.append(make('div',`${date(summary.periodStart)} – ${date(summary.points.filter(p=>p.count!==null).at(-1).start)} (UTC)`,'radar-usage-note'));
        if(summary.lastFullDay)block.append(make('div',`${summary.lastFullDay.count.toLocaleString()} on ${date(summary.lastFullDay.date)} · last full day`,'radar-usage-note'));
        block.title=`Source-reported daily usage, checked ${new Date(summary.lastCheckedAt).toLocaleString()}. Missing dates are excluded, not counted as zero. Daily totals cannot establish an exact rolling 24-hour count.`;
      } else if(summary.kind==='sampled_posts') {
        block.append(make('strong',`${summary.last24h.toLocaleString()} posts`));
        block.append(make('div','Reddit · collected title matches in past 24h','radar-usage-note'));
        const range=make('details',undefined,'radar-evidence');range.append(make('summary','Matching Reddit communities'));
        range.append(make('p',`${summary.communities.map(c=>`r/${c}`).join(', ')}. ${summary.total.toLocaleString()} matching posts collected in the 14-day window. Each post counts once per topic. Comments and image text are not included.`));
        block.append(range);
      } else {
        block.append(make('strong',`${summary.last24h.toLocaleString()} posts`));
        block.append(make('div','Bluesky · captured in past 24h','radar-usage-note'));
        const range=make('details',undefined,'radar-evidence');range.append(make('summary',summary.backfillStart?'History replay loaded':'Collection still building'));
        range.append(make('p',`Captured usage within the 14-day window: ${summary.total.toLocaleString()} posts. Available collection begins ${new Date(summary.periodStart).toLocaleString()}. Counts include explicit hashtags, not all text mentions or other platforms.`));
        if(summary.backfillStart)range.append(make('p',`Historical stream replay: ${new Date(summary.backfillStart).toLocaleString()} – ${new Date(summary.backfillEnd).toLocaleString()}. ${isPreview()?'This preview includes only data recorded by the snapshot date.':'Live collection continues beyond that window.'} Stream gaps can still leave missing posts.`));
        block.append(range);
      }
      cell.append(block);
    }
    return cell;
  }
  function growthCell(trend) {
    const cell=make('td',undefined,'radar-growth');
    const growth=trend.growth;
    if(growth?.status!=='measured') {
      cell.append(make('strong','—'),make('div',growth?.status==='low_volume'?'Too little volume to compare':'Building a comparable baseline','radar-usage-note'));
      return cell;
    }
    const percent=Math.round(growth.percent);
    const main=make('strong',`${percent>0?'+':''}${percent.toLocaleString()}%`);
    main.dataset.direction=percent>0?'up':percent<0?'down':'flat';
    cell.append(main,make('div',`${growth.multiple.toFixed(2)}× baseline`,'radar-growth-multiple'),make('div',`Rank uses ${growth.source}`,'radar-usage-note'));
    cell.append(make('div',growth.baseline.days?`Latest day vs ${growth.baseline.days}-day average`:'6h vs preceding 24h','radar-usage-note'));
    const rateHours=growth.baseline.days?24:1, rateUnit=growth.baseline.days?'day':'hour';
    const formatRate=value=>value.toLocaleString(undefined,{maximumFractionDigits:1});
    cell.append(make('div',`Baseline ${formatRate(growth.baseline.count/growth.baseline.hours*rateHours)} → recent ${formatRate(growth.recent.count/growth.recent.hours*rateHours)} ${growth.unit}/${rateUnit}`,'radar-growth-basis'));
    const detail=make('details',undefined,'radar-evidence');detail.append(make('summary','Why this rank?'));
    for(const comparison of trend.growthComparisons || []) {
      if(comparison.status!=='measured')continue;
      const {recent,baseline,unit,source}=comparison;
      const recentRate=recent.count/recent.hours, baselineRate=baseline.count/baseline.hours;
      detail.append(make('p',`${source}: ${comparison.period}.`));
      if(comparison.communities)detail.append(make('p',`Monitored communities: ${comparison.communities.map(c=>`r/${c}`).join(', ')}.`));
      if(baseline.days)detail.append(make('p',`${recent.count.toLocaleString()} ${unit} on ${recent.start.slice(0,10)} (UTC), compared with ${(baseline.count/baseline.days).toFixed(1)} per day over the preceding ${baseline.days} days (${baseline.count.toLocaleString()} total).`));
      else detail.append(make('p',`${recent.count.toLocaleString()} ${unit} in the last 6 hours (${recentRate.toFixed(1)}/hour), compared with ${baseline.count.toLocaleString()} in the preceding 24 hours (${baselineRate.toFixed(1)}/hour).`));
    }
    detail.append(make('p','Growth = (recent rate ÷ baseline rate − 1) × 100. At least 20 observations in each period are required. When multiple sources qualify, the largest measured increase determines rank.'));
    cell.append(detail);return cell;
  }
  function renderReddit() {
    const panel=$('radar-reddit'); if(!panel)return;
    panel.replaceChildren();
    const reddit=data?.reddit, source=data?.sources.find(s=>s.id==='reddit-posts');
    panel.append(make('strong','Reddit discovery'));
    if(!reddit){panel.append(make('p','Waiting for the Reddit collector.'));return;}
    const status=isPreview()?'Recorded snapshot':source?.status==='rate_limited'?'Cooling down after a rate limit':source?.status==='ok'?'Collecting':source?.status==='collecting'?'Checking a discovery feed':source?.status==='empty'?'Latest feed was empty':source?.status==='authentication_required'?'Access token needs attention':source?.status==='access_denied'?'Feed request was denied':source?.status==='waiting'?'Waiting for the next check':source?'Collection interrupted':'Waiting for the first check';
    panel.append(make('span',status,'radar-reddit-status'));
    panel.append(make('p',`${reddit.total.toLocaleString()} distinct posts from ${reddit.communityCount||0} communities · ${reddit.last24h.toLocaleString()} published in the past 24h. Collected samples, not Reddit-wide usage totals.`));
    panel.append(make('p',reddit.strategy==='broad'?'Discovery rotates through individual communities’ Rising feeds covering news, politics, gaming, technology, entertainment, sports, and memes. Popular Hot and topic searches provide additional context.':`Watching ${reddit.communities.map(c=>`r/${c}`).join(', ')}.`));
    if(!isPreview()) {
      if(reddit.fallback)panel.append(make('p',`Temporarily paused: ${(reddit.pausedFeeds?.map(f=>f.label)||[reddit.fallback.blockedFeed]).join('; ')}. Each feed is checked separately; this does not establish that other Rising feeds are unavailable.`));
      panel.append(make('p','One Reddit request every 5 minutes, with longer pauses after rate limits.'));
      if(source?.nextCheckAt)panel.append(make('p',`Next eligible check: ${new Date(source.nextCheckAt).toLocaleTimeString()}.`));
    }
    panel.append(make('h3','Spreading across communities'));
    if(reddit.topics?.length) {
      const list=make('ul',undefined,'radar-reddit-topics');
      for(const topic of reddit.topics) {
        const item=make('li');item.append(link(topic.name,`https://www.reddit.com/search/?q=${encodeURIComponent('"'+topic.name+'"')}&sort=new`));
        item.append(make('span',` · ${topic.posts} collected posts in ${topic.communities.length} communities`));
        const evidence=make('details',undefined,'radar-evidence');evidence.append(make('summary','Show supporting posts'));
        evidence.append(make('p',topic.communities.map(c=>`r/${c}`).join(', ')));
        for(const sample of topic.samples){const p=make('p');p.append(link(sample.title,sample.url));evidence.append(p);}
        item.append(evidence);list.append(item);
      }
      panel.append(list);
    }else panel.append(make('p','No repeated topic has enough evidence across communities yet. At least three distinct posts across two communities are required; template titles are excluded.'));
    if(reddit.movers?.length) {
      const details=make('details',undefined,'radar-evidence');details.append(make('summary','Posts gaining attention'));
      for(const post of reddit.movers) {
        const entry=make('p');entry.append(link(post.title,post.url));
        if(post.movement)entry.append(make('span',` · rose from #${post.movement.from} to #${post.movement.to} in ${post.movement.feed==='popular:hot'?'Popular Hot':post.movement.feed.startsWith('community:')?`r/${post.movement.feed.split(':')[1]} Rising`:'the same Rising feed'}`));
        if(post.engagement)entry.append(make('span',` · net ${post.engagement.commentChange>=0?'+':''}${post.engagement.commentChange} comments, net score ${post.engagement.scoreChange>=0?'+':''}${post.engagement.scoreChange} over ${post.engagement.hours.toFixed(1)}h`));
        details.append(entry);
      }
      details.append(make('p','Feed positions are compared within the same feed. Comments and score changes appear only when supplied by the source; they are separate from post counts.'));
      panel.append(details);
    }
    if(reddit.feeds?.length) {
      const details=make('details',undefined,'radar-evidence');details.append(make('summary','Discovery checks and coverage'));
      for(const feed of reddit.feeds)details.append(make('p',`${feed.label} · ${['ok','empty'].includes(feed.status)?`${feed.items} posts returned`:feed.status.replaceAll('_',' ')} · ${new Date(feed.checked_at).toLocaleString()}`));
      details.append(make('p','Rising, Hot, and search results are selected samples. They discover candidates and show changes in feed position; they cannot establish a complete Reddit usage-growth percentage. Image text and comment bodies are not yet analyzed.'));
      if(reddit.mode==='Public RSS' && reddit.notice){const p=make('p');p.append(link(reddit.notice.text,reddit.notice.url));details.append(p);}
      panel.append(details);
    }
    if(reddit.recentPosts?.length) {
      const details=make('details',undefined,'radar-evidence');details.append(make('summary','Recent Reddit posts'));
      const list=make('ul');for(const post of reddit.recentPosts){const item=make('li');item.append(link(post.title,post.url),make('span',` · r/${post.community}`));list.append(item);}
      details.append(list);panel.append(details);
    }
  }
  function render() {
    renderReddit();
    const body = $('radar-rows'); body.replaceChildren();
    if (!data) { body.append(make('tr', undefined)); body.firstChild.append(Object.assign(make('td','No ranking available yet.','radar-empty'),{colSpan:6})); return; }
    const query = $('radar-search').value.trim().toLocaleLowerCase();
    const ageCounts = data.trends.reduce((counts, trend) => { counts[trend.age] = (counts[trend.age] || 0) + 1; return counts; }, {});
    root.querySelectorAll('button[data-age]').forEach(button => {
      const key = button.dataset.age;
      button.textContent = `${key === 'all' ? 'All trends' : labels[key]} (${key === 'all' ? data.trends.length : ageCounts[key] || 0})`;
    });
    const rows = data.trends.filter(t => (age === 'all' || t.age === age) && t.name.toLocaleLowerCase().includes(query));
    $('radar-summary').textContent = `${rows.length} shown from ${data.trends.length} ranked topics · ${data.candidateCount} active candidates · ${data.measuredGrowthCount || 0} candidates with measurable growth${data.warmingUp ? ' · Building comparable baselines' : ''}`;
    if (!rows.length) {
      const row = make('tr'), td = make('td', undefined, 'radar-empty'); td.colSpan=6;
      let heading = 'No topics match this search.';
      let explanation = 'Try a different search or age filter.';
      if (!query && age === 'new') {
        heading = 'No topics with recent age evidence in the current top 100.';
        explanation = 'New & Recent includes topics whose earliest available evidence is within six months. Estimates can change when older history is found; topics without dated evidence remain Age unknown.';
      } else if (!query && age === 'legacy') {
        heading = 'No legacy topics verified in the current top 100.';
        explanation = 'Legacy requires dated evidence of activity more than six months ago. Topics with only recent evidence appear under New & Recent; those without dates remain Age unknown.';
      } else if (!data.trends.length) {
        heading = 'Collecting the first qualifying topics.';
        explanation = 'The leaderboard fills as source data arrives.';
      }
      td.append(make('strong',heading),make('p',explanation));
      if (!query && (age === 'new' || age === 'legacy') && ageCounts.unknown) {
        const button = make('button', `View ${ageCounts.unknown} topics with unknown age`, 'radar-empty-action');button.type='button';
        button.addEventListener('click',()=>{const filter=root.querySelector('button[data-age="unknown"]');filter.click();filter.focus();});td.append(button);
      }
      row.append(td);body.append(row);
    }
    for (const trend of rows) {
      const row = make('tr');
      const rank = make('td'); rank.append(make('span', String(trend.rank).padStart(2,'0'),'radar-rank'),make('span',trend.movement === null ? 'Entered list' : trend.movement === 0 ? '—' : `${trend.movement > 0 ? '↑' : '↓'} ${Math.abs(trend.movement)}`,'radar-movement')); rank.title='Rank by percentage growth; arrows show movement since the previous ranking refresh';
      const topic = make('td'); const badge=make('span',`${labels[trend.age]}${trend.ageEstimated ? ' · Estimated' : ''}`,'radar-badge');badge.dataset.age=trend.age;
      badge.title=trend.ageEstimated?'Based on the earliest available evidence, not a verified origin. Older history may change this label.':labels[trend.age];
      topic.append(link(trend.name,trend.url,'radar-title'),badge,make('span',trend.kind,'radar-kind'));
      const earliest=trend.earliestKnownAt ? Date.parse(trend.earliestKnownAt) : null;
      if (earliest!==null && Number.isFinite(earliest)) {
        const days=Math.max(0,Math.floor((Date.parse(data.updatedAt)-earliest)/86400000));
        topic.append(make('div',days>=1?`Dated evidence goes back ${days} ${days===1?'day':'days'}`:'Dated evidence available from today','radar-history-age'));
      } else topic.append(make('div','Source history not supplied','radar-history-age'));
      const detail=make('details',undefined,'radar-evidence');detail.append(make('summary','Activity & age evidence'));
      if (trend.ageEstimated) detail.append(make('p','Estimated New & Recent: the earliest available evidence is within six months. This topic may be older; finding earlier evidence can change its label to Legacy.'));
      const descriptions={usage_day:'Hashtag used as far back as',post_published:'Oldest captured post published',trend_feed_published:'Earliest dated trend-feed entry',story_published:'Story published'};
      for (const record of trend.sourceHistory || []) {
        const when=record.precision==='day'?`${record.date.slice(0,10)} (UTC day)`:new Date(record.date).toLocaleString();
        const p=make('p',`${record.source}: ${descriptions[record.kind] || 'Source record dated'} ${when}. `);p.append(link('Source',record.url));detail.append(p);
      }
      if (!trend.sourceHistory?.length) detail.append(make('p','This source has not supplied historical timestamps for this topic.'));
      detail.append(make('p',`Tracker monitoring began ${new Date(trend.firstObservedAt).toLocaleString()}; last detected ${new Date(trend.lastActiveAt).toLocaleString()}. These monitoring times are not the trend’s origin.`));
      if (!trend.evidence.some(e=>e.kind==='origin')) detail.append(make('p','The dates above show how far back the available evidence goes. They do not establish the first-ever use or exact start of its current rise.'));
      for (const proof of trend.evidence) { const p=make('p',`${proof.date} · ${proof.note} `);p.append(link('Source',proof.url));detail.append(p); }
      topic.append(detail);
      const usage=usageCell(trend);
      const growth = growthCell(trend);
      const chart=make('td'); chart.append(activityChart(trend));
      const sources = make('td');for (const source of trend.sources) sources.append(make('div',source,'radar-source'));
      row.append(rank,topic,usage,growth,chart,sources);body.append(row);
    }
    const healthy=data.sources.filter(s=>!s.stale&&s.status==='ok').length;
    const preview=isPreview(), snapshotDate=new Date(data.updatedAt).toLocaleString();
    $('radar-preview').hidden=!preview;
    $('radar-eyebrow').textContent=preview?'TREND RADAR / DATA PREVIEW':'A LIVE EXPERIMENT / TATSUMO SOFT';
    if(preview) {
      $('radar-preview').textContent=`Preview of real data recorded ${snapshotDate}. Rankings, usage totals, and “past 24h” counts refer to that date. Live updates are not connected on this site yet.`;
      $('radar-sources').textContent='Recorded data · Ranked by percentage growth; filters preserve overall rank';
      $('radar-updated').textContent=`Snapshot: ${snapshotDate}`;
      $('radar-coverage').textContent=`Collection began ${new Date(data.collectingSince).toLocaleString()}. This preview preserves the available history as of ${snapshotDate}; missing history remains visible as gaps.`;
      $('radar-status').textContent='Preview snapshot';
      $('radar-status').dataset.state='preview';
      return;
    }
    $('radar-sources').textContent=`${healthy}/${data.sources.length} collectors reporting · Ranked by percentage growth; filters preserve overall rank`;
    $('radar-updated').textContent=`Updated ${new Date(data.updatedAt).toLocaleTimeString()}`;
    $('radar-coverage').textContent=`Collection began ${new Date(data.collectingSince).toLocaleString()}. The available history fills toward 14 days as collection runs. Detailed activity expires; identity and age evidence are retained.`;
    const stale=failed||data.stale||Date.now()-Date.parse(data.updatedAt)>120000||healthy===0;
    $('radar-status').textContent=stale?'Updates delayed':healthy<data.sources.length?'Partial coverage':'Collecting';
    $('radar-status').dataset.state=stale?'stale':'live';
  }
  async function refresh() {
    if (busy) return;busy=true;$('radar-refresh').disabled=true;
    try { data=await loadRanking(root.dataset.api);failed=false;render(); }
    catch {
      failed=true;
      // A failed live request must never replace already displayed live data with an older preview.
      if(root.dataset.preview && (!data || isPreview())) {
        try { const next=await loadRanking(root.dataset.preview);if(next.preview?.kind!=='snapshot')throw new Error('Invalid preview');data=next; } catch { /* Retain the last valid snapshot if available. */ }
      }
      if(data)render();
      else{render();$('radar-status').textContent='Not connected';$('radar-status').dataset.state='stale';$('radar-summary').textContent='The tracker data is unavailable. Please try refreshing.';$('radar-sources').textContent='Source status unavailable';}
    }
    finally {busy=false;$('radar-refresh').disabled=false;}
  }
  async function loadRanking(url) {
    const response=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('Data request failed');
    const next=await response.json();
    if(!Array.isArray(next.trends)||!Array.isArray(next.sources)||!Number.isFinite(Date.parse(next.updatedAt)))throw new Error('Invalid ranking');
    return next;
  }
  root.querySelectorAll('[data-age]').forEach(button=>button.addEventListener('click',()=>{age=button.dataset.age;root.querySelectorAll('[data-age]').forEach(b=>{if(b.tagName==='BUTTON')b.setAttribute('aria-pressed',String(b===button));});render();}));
  $('radar-search').addEventListener('input',render);$('radar-refresh').addEventListener('click',refresh);
  setInterval(()=>{if(!document.hidden)void refresh();},60000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh();});
  void refresh();
})();
