// Cloudflare Pages Function: GET /api/research-engine?module=<health|options|intraday|stock|sectors|biotech>
//
// Security:
// - ALPACA_API_KEY and ALPACA_SECRET_KEY exist only as Pages environment secrets.
// - All data modules require a valid premium bearer token or X-Research-Cron.
// - Health reveals configuration booleans only, never secret values.
//
// Optional persistence:
// - Bind a D1 database as RESEARCH_DB and apply migrations/0001_research_engine.sql.

const DATA_BASE = 'https://data.alpaca.markets';
const PAPER_BASE = 'https://paper-api.alpaca.markets';
const EQUITY_FEED = 'iex';
const OPTION_FEED = 'indicative';
const ET_FORMATTER = new Intl.DateTimeFormat('en-US', {timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});

export async function onRequestGet(context) {
  const request = context.request;
  const url = new URL(request.url);
  const module = (url.searchParams.get('module') || 'health').toLowerCase();

  if (module === 'health') {
    return json({
      ok: true,
      module: 'health',
      configured: {
        alpaca: Boolean(context.env.ALPACA_API_KEY && context.env.ALPACA_SECRET_KEY),
        database: Boolean(context.env.RESEARCH_DB),
        premiumSecret: Boolean(context.env.PREMIUM_ACCESS_CODES),
        scheduledRefresh: Boolean(context.env.RESEARCH_CRON_SECRET),
      },
      feeds: { equities: 'Alpaca IEX', options: 'Alpaca Indicative' },
      limitations: [
        'Basic equities are IEX-only rather than the consolidated SIP.',
        'Basic options use an indicative feed; trades are delayed and quotes are modified.',
        'Alpaca historical options begin in February 2024.',
        'Asia/London futures-session levels require a separate CME NQ/ES source.',
      ],
      asOf: new Date().toISOString(),
    });
  }

  const authorized = await authorize(request, context.env);
  if (!authorized) return json({ok:false,error:'A valid premium session is required.'}, 401);
  if (!context.env.ALPACA_API_KEY || !context.env.ALPACA_SECRET_KEY) {
    return json({ok:false,error:'Alpaca is not configured on the server. Add ALPACA_API_KEY and ALPACA_SECRET_KEY to Cloudflare Pages secrets.'}, 503);
  }

  try {
    let result;
    if (module === 'options') result = await optionsModule(url.searchParams, context.env);
    else if (module === 'intraday') result = await intradayModule(url.searchParams, context.env);
    else if (module === 'stock') result = await stockModule(url.searchParams, context.env);
    else if (module === 'sectors') result = await sectorsModule(context.env);
    else if (module === 'biotech') result = await biotechModule(context.env);
    else return json({ok:false,error:'Unknown research module.'}, 400);

    const response = {ok:true,module,mode:result.mode || 'observed',source:result.source,asOf:new Date().toISOString(),parameters:result.parameters || {},data:result.data};
    await saveSnapshot(context.env, module, canonicalKey(module, url.searchParams), response);
    return json(response);
  } catch (error) {
    const fallback = await loadLatest(context.env, canonicalKey(module, url.searchParams));
    if (fallback) {
      fallback.ok = true; fallback.cached = true; fallback.warning = `Live refresh failed; displaying the latest saved snapshot. ${describe(error)}`;
      return json(fallback, 200);
    }
    return json({ok:false,module,error:describe(error)}, error.status || 502);
  }
}

async function authorize(request, env) {
  const cron = request.headers.get('X-Research-Cron') || '';
  if (cron && env.RESEARCH_CRON_SECRET && timingSafeEqual(cron, env.RESEARCH_CRON_SECRET)) return true;
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token || !env.PREMIUM_ACCESS_CODES) return false;
  const payload = await verifyToken(token, env.PREMIUM_ACCESS_CODES);
  return Boolean(payload && Number(payload.exp) > Date.now());
}

async function optionsModule(params, env) {
  const symbol = cleanSymbol(params.get('symbol') || 'QQQ');
  const expiryDays = clampInt(params.get('expiryDays'), 1, 45, 7);
  const spot = await fetchSpot(symbol, env);
  const start = isoDate(new Date());
  const end = isoDate(new Date(Date.now() + expiryDays * 86400000));
  const strikeLow = Math.max(1, spot * .90), strikeHigh = spot * 1.10;
  const [contracts, snapshots] = await Promise.all([
    fetchOptionContracts(symbol, start, end, strikeLow, strikeHigh, env),
    fetchOptionChain(symbol, start, end, strikeLow, strikeHigh, env),
  ]);
  const contractMap = new Map(contracts.map((c) => [c.symbol, c]));
  const byStrike = new Map();
  let joined = 0;
  for (const [contractSymbol, snapshot] of Object.entries(snapshots)) {
    const contract = contractMap.get(contractSymbol);
    if (!contract) continue;
    const gamma = finite(snapshot.greeks?.gamma ?? snapshot.gamma);
    const oi = finite(contract.open_interest ?? contract.openInterest);
    const strike = finite(contract.strike_price ?? contract.strikePrice);
    if (gamma === null || oi === null || strike === null || oi <= 0) continue;
    const type = String(contract.type || '').toLowerCase();
    const raw = gamma * oi * 100 * spot * spot * .01 / 1_000_000;
    const signed = type === 'put' ? -raw : raw;
    const row = byStrike.get(strike) || {strike,callGexMm:0,putGexMm:0,netGexMm:0,openInterest:0};
    if (type === 'put') row.putGexMm += signed; else row.callGexMm += signed;
    row.netGexMm += signed; row.openInterest += oi; byStrike.set(strike, row); joined++;
  }
  const gexByStrike = [...byStrike.values()].sort((a,b)=>a.strike-b.strike);
  const netGexMm = gexByStrike.reduce((sum,row)=>sum+row.netGexMm,0);
  return {
    mode:'observed + modeled',
    source:{equities:'Alpaca IEX',options:'Alpaca Indicative',contracts:'Alpaca Trading API contract metadata'},
    parameters:{symbol,expiryStart:start,expiryEnd:end,strikeRange:[strikeLow,strikeHigh]},
    data:{
      spot, netGexMm, gammaFlip:findGammaFlip(gexByStrike, spot), contractsAnalyzed:joined,
      contractsReturned:contracts.length, snapshotsReturned:Object.keys(snapshots).length,
      precision:'indicative', precisionNote:'Free indicative quotes; exact contract-path research requires OPRA.',
      signConvention:'Calls positive; puts negative. This is a dealer-positioning model assumption, not observed positioning.',
      gexByStrike,
    },
  };
}

async function intradayModule(params, env) {
  const symbol = cleanSymbol(params.get('symbol') || 'QQQ');
  const days = clampInt(params.get('days'), 5, 40, 20);
  const paired = symbol === 'QQQ' ? 'SPY' : 'QQQ';
  const start = new Date(Date.now() - Math.ceil(days * 1.8) * 86400000).toISOString();
  const barsBySymbol = await fetchStockBars([symbol, paired], '1Min', start, new Date().toISOString(), env, 25);
  const primary = groupEtDays(barsBySymbol[symbol] || []);
  const comparison = groupEtDays(barsBySymbol[paired] || []);
  const events = buildIntradayEvents(primary, days);
  const smt = buildSmtEvents(primary, comparison, symbol, paired, days);
  const allEvents = events.concat(smt);
  return {
    mode:'observed', source:{equities:'Alpaca IEX one-minute bars'}, parameters:{symbol,paired,days},
    data:{
      conditions:summarizeConditions(allEvents), timing:summarizeTiming(allEvents),
      eventCount:allEvents.length,
      unavailable:[
        {condition:'Asia High/Low',reason:'QQQ/SPY do not trade through the Asia futures session.'},
        {condition:'London High/Low',reason:'Requires NQ/ES data from a CME-licensed source.'},
        {condition:'Exact option decay',reason:'Requires historical OPRA bid/ask-aware contract data.'},
      ],
      definitions:{sweep:'Crosses the stored level from the expected side; an opening gap beyond the level is not counted.',continuation:'Extends 0.15% beyond the level before reversing 0.15%.',reversal:'Returns 0.15% through the swept level before continuation.',continuationModel:'Sweep → same-direction FVG → retest → post-sweep extreme break.',smt:'One ETF takes its prior-day extreme and the paired ETF remains unmatched for at least five minutes; outcome is measured from confirmation.'},
    },
  };
}

async function stockModule(params, env) {
  const symbol = cleanSymbol(params.get('symbol') || 'NVDA');
  const lookback = clampInt(params.get('lookback'), 120, 2190, 365);
  const horizon = clampInt(params.get('horizon'), 5, 120, 20);
  const pivot = clampInt(params.get('pivot'), 2, 12, 5);
  const timeframe = ['daily','weekly','combined'].includes(params.get('timeframe')) ? params.get('timeframe') : 'combined';
  const start = new Date(Date.now() - lookback * 86400000).toISOString();
  const daily = (await fetchStockBars([symbol], '1Day', start, new Date().toISOString(), env, 15))[symbol] || [];
  if (daily.length < pivot * 2 + 25) throw statusError('Not enough adjusted daily bars were returned for this study.', 422);
  const weekly = resampleWeekly(daily);
  const sets = timeframe === 'daily' ? [{name:'Daily',bars:daily,pivot,horizon}] : timeframe === 'weekly' ? [{name:'Weekly',bars:weekly,pivot:2,horizon:Math.max(4,Math.round(horizon/5))}] : [{name:'Daily',bars:daily,pivot,horizon},{name:'Weekly',bars:weekly,pivot:2,horizon:Math.max(4,Math.round(horizon/5))}];
  const analyses = sets.map((x)=>({...x,result:analyseFib(x.bars,x.pivot,x.horizon,x.name)}));
  const fibStats = combineFibStats(analyses.map((x)=>x.result));
  const last = daily[daily.length-1], close = finite(last.c), return20 = daily.length>20 ? close / finite(daily[daily.length-21].c) - 1 : null;
  const allEvents = analyses.flatMap((x)=>x.result.events);
  const best = fibStats.filter((x)=>x.touches>=5).sort((a,b)=>(b.fillRate||0)-(a.fillRate||0))[0];
  return {
    mode:'observed', source:{equities:'Alpaca adjusted daily IEX bars'}, parameters:{symbol,lookback,horizon,pivot,timeframe},
    data:{
      summary:{lastPrice:close,lastDate:String(last.t||'').slice(0,10),return20,atr14Pct:atrPct(daily,14),setups:allEvents.length,bestFib:best?(best.level*100).toFixed(1)+'%':'Insufficient N'},
      fibStats, latestSwing:analyses[0].result.latestSwing, timeframeBreakdown:analyses.map((x)=>({timeframe:x.name,events:x.result.events.length,stats:x.result.stats})),
    },
  };
}

async function sectorsModule(env) {
  const sectors = [
    ['XLK','Technology'],['XLF','Financials'],['XLE','Energy'],['XLV','Healthcare'],['XLI','Industrials'],
    ['XLY','Consumer Discretionary'],['XLP','Consumer Staples'],['XLU','Utilities'],['XLB','Materials'],['XLRE','Real Estate'],['XLC','Communication Services'],
  ];
  const symbols = ['QQQ', ...sectors.map((x)=>x[0])];
  const start = new Date(Date.now() - 120 * 86400000).toISOString();
  const bars = await fetchStockBars(symbols,'1Day',start,new Date().toISOString(),env,15);
  const qqq = metrics(bars.QQQ || []), benchmarkReturn20 = qqq.return20;
  const rows = sectors.map(([etf,sector])=>({etf,sector,...metrics(bars[etf]||[])})).map((r)=>({...r,relativeStrength:r.return20===null||benchmarkReturn20===null?null:r.return20-benchmarkReturn20})).sort((a,b)=>(b.relativeStrength??-Infinity)-(a.relativeStrength??-Infinity));
  return {mode:'observed',source:{equities:'Alpaca adjusted daily IEX bars'},data:{benchmark:'QQQ',benchmarkReturn20,rows,breadthDefinition:'Up-day share of the ETF itself over 20 sessions; not constituent breadth.'}};
}

async function biotechModule(env) {
  const universe = [['XBI','ETF'],['IBB','ETF'],['MRNA','Large cap'],['BNTX','Large cap'],['CRSP','Gene editing'],['EDIT','Gene editing'],['NTLA','Gene editing'],['REGN','Large cap'],['VRTX','Large cap'],['BIIB','Large cap']];
  const symbols = universe.map((x)=>x[0]);
  const start = new Date(Date.now() - 120 * 86400000).toISOString();
  const bars = await fetchStockBars(symbols,'1Day',start,new Date().toISOString(),env,15);
  const rows = universe.map(([ticker,type])=>{
    const m=metrics(bars[ticker]||[]); const riskFlag=m.atr14Pct!==null&&m.atr14Pct>=.06||m.volumeRatio!==null&&m.volumeRatio>=2.5||m.gap!==null&&Math.abs(m.gap)>=.06?'HIGH':m.atr14Pct!==null&&m.atr14Pct>=.04||m.volumeRatio!==null&&m.volumeRatio>=1.8?'REVIEW':'LOW';
    return {ticker,type,...m,riskFlag,catalyst:null,catalystStatus:'Not available from Alpaca'};
  });
  return {mode:'observed price/volume only',source:{equities:'Alpaca adjusted daily IEX bars',catalysts:'Not connected'},data:{rows,missingFields:['Clinical catalyst date','FDA/PDUFA date','Trial phase','Cash runway','Dilution risk','Validated short interest']}};
}

async function fetchSpot(symbol, env) {
  const data = await alpaca(`${DATA_BASE}/v2/stocks/${encodeURIComponent(symbol)}/snapshot`,{feed:EQUITY_FEED},env);
  const candidates=[data.latestTrade?.p,data.latest_trade?.price,data.minuteBar?.c,data.minute_bar?.close,data.dailyBar?.c,data.daily_bar?.close,data.prevDailyBar?.c];
  const spot=candidates.map(finite).find((x)=>x!==null);
  if(spot===undefined) throw statusError(`No current ${symbol} spot price was returned.`,422);
  return spot;
}

async function fetchOptionContracts(symbol, start, end, strikeLow, strikeHigh, env) {
  let pageToken=null, rows=[];
  for(let page=0;page<20;page++){
    const data=await alpaca(`${PAPER_BASE}/v2/options/contracts`,{underlying_symbols:symbol,status:'active',expiration_date_gte:start,expiration_date_lte:end,strike_price_gte:strikeLow.toFixed(2),strike_price_lte:strikeHigh.toFixed(2),limit:1000,page_token:pageToken},env);
    rows.push(...(data.option_contracts||[])); pageToken=data.next_page_token||data.page_token||null; if(!pageToken)break;
  }
  return rows;
}

async function fetchOptionChain(symbol, start, end, strikeLow, strikeHigh, env) {
  let pageToken=null, output={};
  for(let page=0;page<20;page++){
    const data=await alpaca(`${DATA_BASE}/v1beta1/options/snapshots/${encodeURIComponent(symbol)}`,{feed:OPTION_FEED,expiration_date_gte:start,expiration_date_lte:end,strike_price_gte:strikeLow.toFixed(2),strike_price_lte:strikeHigh.toFixed(2),limit:1000,page_token:pageToken},env);
    Object.assign(output,data.snapshots||{}); pageToken=data.next_page_token||null; if(!pageToken)break;
  }
  return output;
}

async function fetchStockBars(symbols,timeframe,start,end,env,maxPages=20) {
  let pageToken=null, output=Object.fromEntries(symbols.map((s)=>[s,[]]));
  for(let page=0;page<maxPages;page++){
    const data=await alpaca(`${DATA_BASE}/v2/stocks/bars`,{symbols:symbols.join(','),timeframe,start,end,adjustment:'all',feed:EQUITY_FEED,sort:'asc',limit:10000,page_token:pageToken},env);
    for(const [symbol,rows] of Object.entries(data.bars||{})) output[symbol]=(output[symbol]||[]).concat(rows||[]);
    pageToken=data.next_page_token||null;if(!pageToken)break;
  }
  for(const symbol of Object.keys(output)) output[symbol].sort((a,b)=>String(a.t).localeCompare(String(b.t)));
  return output;
}

async function alpaca(base, params, env) {
  const url=new URL(base);for(const [key,value] of Object.entries(params||{}))if(value!==null&&value!==undefined&&value!=='')url.searchParams.set(key,String(value));
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),15000);
  let res;
  try{res=await fetch(url.toString(),{headers:{'APCA-API-KEY-ID':env.ALPACA_API_KEY,'APCA-API-SECRET-KEY':env.ALPACA_SECRET_KEY,'Accept':'application/json'},signal:controller.signal});}
  catch(error){throw statusError(error.name==='AbortError'?'Alpaca request timed out.':'Could not reach Alpaca.',502)}finally{clearTimeout(timeout)}
  const text=await res.text();let data;try{data=JSON.parse(text)}catch{throw statusError(`Alpaca returned non-JSON (${res.status}).`,502)}
  if(!res.ok)throw statusError(`Alpaca ${res.status}: ${data.message||data.error||'request failed'}`,res.status);
  return data;
}

function analyseFib(bars,pivot,horizon,timeframe) {
  const fibs=[.382,.5,.618],events=[],swingHighs=[];
  for(let i=pivot;i<bars.length-pivot;i++){
    const high=finite(bars[i].h);if(high===null)continue;let isHigh=true;
    for(let j=i-pivot;j<=i+pivot;j++)if(j!==i&&finite(bars[j].h)!==null&&finite(bars[j].h)>high){isHigh=false;break}
    if(isHigh)swingHighs.push(i);
  }
  for(let s=0;s<swingHighs.length;s++){
    const hi=swingHighs[s],lowStart=Math.max(0,hi-60),lowIndex=argMin(bars,lowStart,hi,'l');if(lowIndex===null||lowIndex>=hi)continue;
    const low=finite(bars[lowIndex].l),high=finite(bars[hi].h);if(low===null||high===null||high<=low)continue;
    const searchEnd=Math.min(bars.length-1,hi+horizon,swingHighs[s+1]??bars.length-1);
    for(const level of fibs){const price=high-(high-low)*level;let touch=null;for(let j=hi+1;j<=searchEnd;j++){if(finite(bars[j].l)!==null&&finite(bars[j].l)<=price){touch=j;break}}if(touch===null)continue;
      const outcomeEnd=Math.min(bars.length-1,touch+horizon);let maxHigh=-Infinity,minLow=Infinity,fillIndex=null,newHigh=false;
      for(let j=touch;j<=outcomeEnd;j++){const h=finite(bars[j].h),l=finite(bars[j].l);if(h!==null){maxHigh=Math.max(maxHigh,h);if(fillIndex===null&&h>=high)fillIndex=j;if(h>high*1.001)newHigh=true}if(l!==null)minLow=Math.min(minLow,l)}
      events.push({timeframe,level,touchDate:dateOnly(bars[touch].t),filled:fillIndex!==null,newHigh,daysToFill:fillIndex===null?null:fillIndex-touch,mfe:Number.isFinite(maxHigh)?maxHigh/price-1:null,mae:Number.isFinite(minLow)?minLow/price-1:null,low,high,lowDate:dateOnly(bars[lowIndex].t),highDate:dateOnly(bars[hi].t)});
    }
  }
  const stats=statsFromFibEvents(events);let latestSwing=null;
  const lastHigh=swingHighs.at(-1);if(lastHigh!==undefined){const lowIndex=argMin(bars,Math.max(0,lastHigh-60),lastHigh,'l'),low=lowIndex===null?null:finite(bars[lowIndex].l),high=finite(bars[lastHigh].h);if(low!==null&&high!==null)latestSwing={lowDate:dateOnly(bars[lowIndex].t),low,highDate:dateOnly(bars[lastHigh].t),high,levels:Object.fromEntries(fibs.map((f)=>[String(f),high-(high-low)*f])),status:`${timeframe} pivot ${pivot}`}}
  return {events,stats,latestSwing};
}

function statsFromFibEvents(events) {
  return [.382,.5,.618].map((level)=>{const rows=events.filter((e)=>e.level===level),filled=rows.filter((e)=>e.filled),newHigh=rows.filter((e)=>e.newHigh);return{level,touches:rows.length,fillRate:rows.length?filled.length/rows.length:null,newHighRate:rows.length?newHigh.length/rows.length:null,medianDays:median(filled.map((e)=>e.daysToFill)),medianMfe:median(rows.map((e)=>e.mfe)),medianMae:median(rows.map((e)=>e.mae))}});
}
function combineFibStats(results){return statsFromFibEvents(results.flatMap((r)=>r.events))}

function buildIntradayEvents(daysMap,limitDays) {
  const dates=[...daysMap.keys()].sort().slice(-limitDays-1),events=[];
  for(let i=1;i<dates.length;i++){
    const prev=splitSession(daysMap.get(dates[i-1])||[]),cur=splitSession(daysMap.get(dates[i])||[]);if(!prev.rth.length||!cur.rth.length)continue;
    const vwap=cumulativeVwap(cur.rth);
    const levels=[['PDH','high',maxField(prev.rth,'h')],['PDL','low',minField(prev.rth,'l')]];
    if(cur.pre.length){levels.push(['Premarket High','high',maxField(cur.pre,'h')],['Premarket Low','low',minField(cur.pre,'l')])}
    for(const [condition,direction,level] of levels){if(level===null)continue;const event=classifySweep(cur.rth,level,direction,condition,dates[i],vwap);if(event)events.push(event)}
    if(cur.rth.length>15){const opening=cur.rth.slice(0,15),after=cur.rth.slice(15),afterVwap=vwap.slice(15),high=maxField(opening,'h'),low=minField(opening,'l');if(high!==null){const event=classifySweep(after,high,'high','Opening Range High',dates[i],afterVwap);if(event)events.push(event)}if(low!==null){const event=classifySweep(after,low,'low','Opening Range Low',dates[i],afterVwap);if(event)events.push(event)}}
    if(cur.rth.length>60){const initial=cur.rth.slice(0,60),after=cur.rth.slice(60),afterVwap=vwap.slice(60),high=maxField(initial,'h'),low=minField(initial,'l');if(high!==null){const event=classifySweep(after,high,'high','Initial Balance High',dates[i],afterVwap);if(event)events.push(event)}if(low!==null){const event=classifySweep(after,low,'low','Initial Balance Low',dates[i],afterVwap);if(event)events.push(event)}}
  }
  return events;
}

function classifySweep(bars,level,direction,condition,date,vwapSeries=[]) {
  const idx=findSweepIndex(bars,level,direction);if(idx<0)return null;
  const entry=finite(bars[idx].c)??level,window=bars.slice(idx,Math.min(bars.length,idx+91));let max=-Infinity,min=Infinity,continuationAt=null,reversalAt=null;
  for(let i=0;i<window.length;i++){const h=finite(window[i].h),l=finite(window[i].l);if(h!==null)max=Math.max(max,h);if(l!==null)min=Math.min(min,l);if(direction==='high'){if(continuationAt===null&&h!==null&&h>=level*1.0015)continuationAt=i;if(reversalAt===null&&l!==null&&l<=level*.9985)reversalAt=i}else{if(continuationAt===null&&l!==null&&l<=level*.9985)continuationAt=i;if(reversalAt===null&&h!==null&&h>=level*1.0015)reversalAt=i}}
  const continuation=continuationAt!==null&&(reversalAt===null||continuationAt<reversalAt),reversal=reversalAt!==null&&(continuationAt===null||reversalAt<continuationAt),time=etParts(bars[idx].t).time;
  const model=detectContinuationModel(bars,idx,direction);
  let vwapHit=vwapSeries.length?false:null,minutesToVwap=null;
  for(let j=idx+1;j<Math.min(bars.length,idx+91);j++){const value=finite(vwapSeries[j]),high=finite(bars[j].h),low=finite(bars[j].l);if(value!==null&&high!==null&&low!==null&&low<=value&&high>=value){vwapHit=true;minutesToVwap=j-idx;break}}
  return{date,condition,direction,time,minute:timeToMinute(time),continuation,reversal,continuationModel:model,vwapHit,minutesToVwap,mfe:direction==='high'?(max/entry-1):(entry/min-1),mae:direction==='high'?(min/entry-1):-(max/entry-1)};
}

function detectContinuationModel(bars,sweepIndex,direction) {
  const fvgEnd=Math.min(bars.length-1,sweepIndex+30);
  for(let i=sweepIndex+2;i<=fvgEnd;i++){
    const a=bars[i-2],c=bars[i],bull=finite(c.l)!==null&&finite(a.h)!==null&&finite(c.l)>finite(a.h),bear=finite(c.h)!==null&&finite(a.l)!==null&&finite(c.h)<finite(a.l);
    if((direction==='high'&&!bull)||(direction==='low'&&!bear))continue;
    const zoneLow=direction==='high'?finite(a.h):finite(c.h),zoneHigh=direction==='high'?finite(c.l):finite(a.l),retestEnd=Math.min(bars.length-1,i+60);let retest=null;
    if(zoneLow===null||zoneHigh===null)continue;
    for(let j=i+1;j<=retestEnd;j++){const low=finite(bars[j].l),high=finite(bars[j].h);if(low!==null&&high!==null&&low<=zoneHigh&&high>=zoneLow){retest=j;break}}if(retest===null)continue;
    const pre=bars.slice(sweepIndex,retest+1),extreme=direction==='high'?maxField(pre,'h'):minField(pre,'l'),breakEnd=Math.min(bars.length-1,retest+90);
    if(extreme===null)continue;
    for(let j=retest+1;j<=breakEnd;j++){const value=finite(direction==='high'?bars[j].h:bars[j].l);if(value!==null&&(direction==='high'?value>extreme:value<extreme))return true}
  }
  return false;
}

function buildSmtEvents(primary,comparison,symbol,paired,limitDays) {
  const dates=[...primary.keys()].filter((d)=>comparison.has(d)).sort().slice(-limitDays-1),events=[];
  for(let i=1;i<dates.length;i++){
    const date=dates[i],pPrev=splitSession(primary.get(dates[i-1])||[]),pCur=splitSession(primary.get(date)||[]),cPrev=splitSession(comparison.get(dates[i-1])||[]),cCur=splitSession(comparison.get(date)||[]);if(!pPrev.rth.length||!pCur.rth.length||!cPrev.rth.length||!cCur.rth.length)continue;
    const pHigh=maxField(pPrev.rth,'h'),cHigh=maxField(cPrev.rth,'h'),pLow=minField(pPrev.rth,'l'),cLow=minField(cPrev.rth,'l');
    if([pHigh,cHigh,pLow,cLow].some((value)=>value===null))continue;
    const pHighIndex=findSweepIndex(pCur.rth,pHigh,'high'),cHighIndex=findSweepIndex(cCur.rth,cHigh,'high'),pLowIndex=findSweepIndex(pCur.rth,pLow,'low'),cLowIndex=findSweepIndex(cCur.rth,cLow,'low');
    const highEvent=confirmedSmtEvent(pCur.rth,cCur.rth,pHighIndex,cHighIndex,'down',`${symbol}/${paired} SMT high divergence`,date);if(highEvent)events.push(highEvent);
    const lowEvent=confirmedSmtEvent(pCur.rth,cCur.rth,pLowIndex,cLowIndex,'up',`${symbol}/${paired} SMT low divergence`,date);if(lowEvent)events.push(lowEvent);
  }
  return events;
}

function confirmedSmtEvent(primaryBars,comparisonBars,primaryIndex,comparisonIndex,expectedDirection,condition,date){
  if(primaryIndex<0&&comparisonIndex<0)return null;
  const primaryTime=primaryIndex>=0?Date.parse(primaryBars[primaryIndex]?.t):Infinity,comparisonTime=comparisonIndex>=0?Date.parse(comparisonBars[comparisonIndex]?.t):Infinity;
  if(!Number.isFinite(primaryTime)&&!Number.isFinite(comparisonTime))return null;
  const firstTime=Math.min(primaryTime,comparisonTime),otherTime=primaryTime<=comparisonTime?comparisonTime:primaryTime,confirmationTime=firstTime+5*60000;
  if(otherTime<=confirmationTime)return null;
  const index=primaryBars.findIndex((bar)=>Date.parse(bar.t)>=confirmationTime);if(index<0)return null;
  return classifyDirectionalOutcome(primaryBars,index,expectedDirection,condition,date);
}

function classifyDirectionalOutcome(bars,index,expectedDirection,condition,date){
  const entry=finite(bars[index]?.c);if(entry===null)return null;const window=bars.slice(index,Math.min(bars.length,index+91));let max=-Infinity,min=Infinity,continuationAt=null,reversalAt=null;
  for(let i=0;i<window.length;i++){const h=finite(window[i].h),l=finite(window[i].l);if(h!==null)max=Math.max(max,h);if(l!==null)min=Math.min(min,l);if(expectedDirection==='up'){if(continuationAt===null&&h!==null&&h>=entry*1.0015)continuationAt=i;if(reversalAt===null&&l!==null&&l<=entry*.9985)reversalAt=i}else{if(continuationAt===null&&l!==null&&l<=entry*.9985)continuationAt=i;if(reversalAt===null&&h!==null&&h>=entry*1.0015)reversalAt=i}}
  const continuation=continuationAt!==null&&(reversalAt===null||continuationAt<reversalAt),reversal=reversalAt!==null&&(continuationAt===null||reversalAt<continuationAt),time=etParts(bars[index].t).time;
  return{date,condition,direction:expectedDirection,time,minute:timeToMinute(time),continuation,reversal,continuationModel:false,mfe:expectedDirection==='up'?(max/entry-1):(entry/min-1),mae:expectedDirection==='up'?(min/entry-1):-(max/entry-1)};
}

function summarizeConditions(events) {
  const groups=new Map();for(const e of events){const g=groups.get(e.condition)||[];g.push(e);groups.set(e.condition,g)}
  const modelRows=events.filter((e)=>e.continuationModel);if(modelRows.length)groups.set('Continuation Model',modelRows);
  return [...groups.entries()].map(([condition,rows])=>{const medianMfe=median(rows.map((r)=>r.mfe)),medianMae=median(rows.map((r)=>r.mae)),vwapRows=rows.filter((r)=>typeof r.vwapHit==='boolean');return{condition,n:rows.length,continuationRate:rate(rows,'continuation'),reversalRate:rate(rows,'reversal'),vwapHitRate:vwapRows.length?rate(vwapRows,'vwapHit'):null,medianMinutesToVwap:median(vwapRows.map((r)=>r.minutesToVwap)),medianMfe,medianMae,rewardRisk:medianMfe!==null&&medianMae!==null&&medianMae!==0?medianMfe/Math.abs(medianMae):null}});
}
function summarizeTiming(events) {
  const labels=['PDH sweep','PDL sweep','Premarket H/L'];
  return labels.map((label)=>{const rows=events.filter((e)=>label==='Premarket H/L'?e.condition.startsWith('Premarket'):e.condition===label.replace(' sweep',''));
    const result={label};for(const [key,cutoff] of [['before1000',600],['before1030',630],['before1100',660],['fullRth',960]]){const q=rows.filter((e)=>e.minute<=cutoff);result[key]=q.length?rate(q,'continuation'):null;result[key+'N']=q.length}return result});
}

function groupEtDays(bars){const map=new Map();for(const bar of bars){const p=etParts(bar.t),row={...bar,_time:p.time};if(!map.has(p.date))map.set(p.date,[]);map.get(p.date).push(row)}return map}
function splitSession(bars){return{pre:bars.filter((b)=>{const m=timeToMinute(b._time);return m>=240&&m<570}),rth:bars.filter((b)=>{const m=timeToMinute(b._time);return m>=570&&m<960})}}
function findSweepIndex(bars,level,direction){for(let i=0;i<bars.length;i++){const open=finite(bars[i]?.o),high=finite(bars[i]?.h),low=finite(bars[i]?.l),previousClose=i>0?finite(bars[i-1]?.c):null;if(direction==='high'){const startedBelow=previousClose!==null?previousClose<level:open!==null&&open<=level;if(startedBelow&&low!==null&&low<=level&&high!==null&&high>=level)return i}else{const startedAbove=previousClose!==null?previousClose>level:open!==null&&open>=level;if(startedAbove&&high!==null&&high>=level&&low!==null&&low<=level)return i}}return-1}
function cumulativeVwap(bars){let pv=0,volume=0;return bars.map((bar)=>{const high=finite(bar.h),low=finite(bar.l),close=finite(bar.c),v=finite(bar.v);if(high!==null&&low!==null&&close!==null&&v!==null&&v>0){pv+=((high+low+close)/3)*v;volume+=v}return volume>0?pv/volume:null})}
function etParts(value){const parts=Object.fromEntries(ET_FORMATTER.formatToParts(new Date(value)).filter((p)=>p.type!=='literal').map((p)=>[p.type,p.value]));return{date:`${parts.year}-${parts.month}-${parts.day}`,time:`${parts.hour}:${parts.minute}`}}
function timeToMinute(value){const [h,m]=String(value).split(':').map(Number);return h*60+m}

function resampleWeekly(bars) {
  const groups=new Map();for(const b of bars){const d=new Date(b.t),day=d.getUTCDay(),monday=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()-(day===0?6:day-1))),key=monday.toISOString().slice(0,10);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(b)}
  return [...groups.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([key,rows])=>({t:key+'T00:00:00Z',o:finite(rows[0].o),h:maxField(rows,'h'),l:minField(rows,'l'),c:finite(rows.at(-1).c),v:rows.reduce((s,r)=>s+(finite(r.v)||0),0)}));
}
function metrics(bars) {
  if(!bars.length)return{return1:null,return5:null,return20:null,atr14Pct:null,upDayShare:null,volumeRatio:null,gap:null};
  const last=bars.at(-1),close=finite(last.c),ret=(n)=>bars.length>n&&close!==null&&finite(bars.at(-1-n).c)!==null?close/finite(bars.at(-1-n).c)-1:null;
  const recent=bars.slice(-20),ups=recent.slice(1).filter((b,i)=>finite(b.c)>finite(recent[i].c)).length,volAvg=average(recent.slice(0,-1).map((b)=>finite(b.v))),volumeRatio=volAvg&&finite(last.v)!==null?finite(last.v)/volAvg:null,prev=bars.length>1?finite(bars.at(-2).c):null,gap=prev&&finite(last.o)!==null?finite(last.o)/prev-1:null;
  return{return1:ret(1),return5:ret(5),return20:ret(20),atr14Pct:atrPct(bars,14),upDayShare:recent.length>1?ups/(recent.length-1):null,volumeRatio,gap};
}
function atrPct(bars,n){if(bars.length<n+1)return null;const rows=bars.slice(-n),trs=[];for(let i=0;i<rows.length;i++){const h=finite(rows[i].h),l=finite(rows[i].l),pc=i?finite(rows[i-1].c):finite(bars[bars.length-n-1]?.c);if(h===null||l===null)continue;trs.push(Math.max(h-l,pc===null?0:Math.abs(h-pc),pc===null?0:Math.abs(l-pc)))}const close=finite(bars.at(-1).c),atr=average(trs);return close&&atr!==null?atr/close:null}
function findGammaFlip(rows,spot){const sorted=rows.filter((r)=>Number.isFinite(r.netGexMm)).sort((a,b)=>a.strike-b.strike),cross=[];for(let i=1;i<sorted.length;i++){const a=sorted[i-1],b=sorted[i];if(a.netGexMm===0)cross.push(a.strike);else if(Math.sign(a.netGexMm)!==Math.sign(b.netGexMm)){const t=Math.abs(a.netGexMm)/(Math.abs(a.netGexMm)+Math.abs(b.netGexMm));cross.push(a.strike+(b.strike-a.strike)*t)}}return cross.sort((a,b)=>Math.abs(a-spot)-Math.abs(b-spot))[0]??null}

async function saveSnapshot(env,module,key,payload){if(!env.RESEARCH_DB)return;try{const jsonText=JSON.stringify(payload),now=new Date().toISOString();await env.RESEARCH_DB.batch([env.RESEARCH_DB.prepare('INSERT INTO research_snapshots (module, cache_key, as_of, payload) VALUES (?, ?, ?, ?)').bind(module,key,now,jsonText),env.RESEARCH_DB.prepare("INSERT INTO research_latest (cache_key, module, as_of, payload) VALUES (?, ?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET module=excluded.module, as_of=excluded.as_of, payload=excluded.payload, updated_at=datetime('now')").bind(key,module,now,jsonText)])}catch{/* Persistence is optional; a write failure must not corrupt the live response. */}}
async function loadLatest(env,key){if(!env.RESEARCH_DB)return null;try{const row=await env.RESEARCH_DB.prepare('SELECT payload FROM research_latest WHERE cache_key = ?').bind(key).first();return row?.payload?JSON.parse(row.payload):null}catch{return null}}
function canonicalKey(module,params){const keep=[...params.entries()].filter(([k])=>!['force','module'].includes(k)).sort((a,b)=>a[0].localeCompare(b[0]));return module+'?'+new URLSearchParams(keep).toString()}

async function verifyToken(token,secret){const parts=token.split('.');if(parts.length!==2)return null;const expected=await hmac(parts[0],secret);if(!timingSafeEqual(parts[1],expected))return null;try{return JSON.parse(base64UrlDecode(parts[0]))}catch{return null}}
async function hmac(message,secret){const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);const sig=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(message));return base64UrlEncode(String.fromCharCode(...new Uint8Array(sig)))}
function base64UrlEncode(str){return btoa(unescape(encodeURIComponent(str))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}
function base64UrlDecode(str){const padded=str.replace(/-/g,'+').replace(/_/g,'/')+'==='.slice((str.length+3)%4);return decodeURIComponent(escape(atob(padded)))}
function timingSafeEqual(a,b){a=String(a);b=String(b);if(a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0}
function json(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}})}
function statusError(message,status){const e=new Error(message);e.status=status;return e}
function describe(error){return error&&error.message?error.message:String(error)}
function cleanSymbol(value){const symbol=String(value||'').trim().toUpperCase().replace(/[^A-Z0-9.\-]/g,'');if(!symbol||symbol.length>12)throw statusError('Invalid symbol.',400);return symbol}
function clampInt(value,min,max,fallback){const n=Math.round(Number(value));return Number.isFinite(n)?Math.min(max,Math.max(min,n)):fallback}
function finite(value){if(value===null||value===undefined||value==='')return null;const n=Number(value);return Number.isFinite(n)?n:null}
function average(values){const a=values.map(finite).filter((x)=>x!==null);return a.length?a.reduce((s,x)=>s+x,0)/a.length:null}
function median(values){const a=values.map(finite).filter((x)=>x!==null).sort((x,y)=>x-y);if(!a.length)return null;const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2}
function rate(rows,key){return rows.length?rows.filter((r)=>Boolean(r[key])).length/rows.length:null}
function maxField(rows,key){const a=rows.map((r)=>finite(r[key])).filter((x)=>x!==null);return a.length?Math.max(...a):null}
function minField(rows,key){const a=rows.map((r)=>finite(r[key])).filter((x)=>x!==null);return a.length?Math.min(...a):null}
function argMin(rows,start,end,key){let idx=null,best=Infinity;for(let i=start;i<=end;i++){const v=finite(rows[i]?.[key]);if(v!==null&&v<best){best=v;idx=i}}return idx}
function dateOnly(value){return String(value||'').slice(0,10)}
function isoDate(date){return date.toISOString().slice(0,10)}

// Explicit exports allow deterministic calculation tests without exposing routes.
export const __test = {analyseFib,statsFromFibEvents,combineFibStats,findGammaFlip,resampleWeekly,metrics,classifySweep,findSweepIndex,detectContinuationModel,summarizeConditions,summarizeTiming,cumulativeVwap,finite,median};
