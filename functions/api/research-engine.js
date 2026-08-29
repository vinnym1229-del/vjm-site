import { checkRateLimit } from './_lib/http.js';

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
const HISTORICAL_EQUITY_FEED = 'sip';
const OVERNIGHT_FEED = 'boats';
const OPTION_FEED = 'indicative';
const ET_FORMATTER = new Intl.DateTimeFormat('en-US', {timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});

export async function onRequestGet(context) {
  // Expensive: the data modules paginate Alpaca option chains, up to 20
  // upstream calls per request. Also stops the premium-token check from
  // being brute-forced.
  const _rl = await checkRateLimit(context.env, context.request, 'research-engine', 30);
  if (!_rl.allowed) return json({ ok: false, error: 'Too many requests. Wait a minute.' }, 429);
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
      feeds: { equities: 'Alpaca IEX live + delayed SIP/BOATS history', options: 'Alpaca Indicative' },
      limitations: [
        'Current spot snapshots use IEX; intraday research uses consolidated SIP and BOATS history ending at least 16 minutes ago.',
        'Basic options use an indicative feed; trades are delayed and quotes are modified.',
        'Alpaca historical options begin in February 2024.',
        'Asia and London are QQQ/SPY ETF price-action proxies, not actual CME NQ/ES volume or order flow.',
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
  const delayedEnd = new Date(Date.now() - 16 * 60000).toISOString();
  const [sipBars, overnightBars] = await Promise.all([
    fetchStockBars([symbol, paired], '1Min', start, delayedEnd, env, 25, HISTORICAL_EQUITY_FEED),
    fetchStockBars([symbol, paired], '1Min', start, delayedEnd, env, 25, OVERNIGHT_FEED),
  ]);
  const primary = groupProxyTradeDays(sipBars[symbol] || [], overnightBars[symbol] || []);
  const comparison = groupProxyTradeDays(sipBars[paired] || [], overnightBars[paired] || []);
  const events = buildIntradayEvents(primary, days);
  const smt = buildSmtEvents(primary, comparison, symbol, paired, days);
  const model = buildPriceActionModel(primary, days);
  const allEvents = events.concat(smt, model.events);
  return {
    mode:'observed ETF proxy', source:{regularAndExtended:'Alpaca SIP historical bars (15-minute delayed on Free)',overnight:'Alpaca BOATS historical bars (15-minute delayed on Free)',proxy:'QQQ/SPY—not NQ/ES'}, parameters:{symbol,paired,days},
    data:{
      conditions:summarizeConditions(allEvents), timing:summarizeTiming(allEvents),
      eventCount:allEvents.length,
      fvgStats:summarizeFvg(model.fvgRecords),
      latestLevels:buildLatestLevels(primary),
      coverage:coverageSummary(primary, days),
      unavailable:[
        {condition:'True NQ/ES futures order flow',reason:'QQQ/SPY SIP/BOATS price action is a proxy and does not contain CME volume or futures-only prints.'},
        {condition:'Exact option decay',reason:'Requires historical OPRA bid/ask-aware contract data.'},
      ],
      definitions:{overnightProxy:'6:00 PM–9:30 AM ET using SIP 6:00–8:00 PM, BOATS 8:00 PM–4:00 AM, and SIP 4:00–9:30 AM.',asiaProxy:'8:00 PM–12:00 AM ET BOATS.',londonProxy:'2:00–5:00 AM ET using BOATS through 4:00 AM and SIP after 4:00 AM.',sweep:'Crosses the stored level from the expected side; an opening gap beyond the level is not counted.',continuation:'Extends 0.15% beyond the level before reversing 0.15%.',reversal:'Returns 0.15% through the swept level before continuation.',fvg:'Three-candle imbalance; bullish when candle three low is above candle one high, bearish when candle three high is below candle one low.',ifvg:'An FVG whose far boundary is closed through before same-direction continuation.',displacement:'Five-minute body and range are each at least 1.5× their prior-20-bar medians and the close is in the outer 25% of the candle.',continuationModel:'Sweep → same-direction FVG → retest → post-sweep extreme break.',smt:'One ETF takes its comparable prior-session extreme and the paired ETF remains unmatched for at least five minutes; outcome is measured from confirmation.'},
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

async function fetchStockBars(symbols,timeframe,start,end,env,maxPages=20,feed=EQUITY_FEED) {
  let pageToken=null, output=Object.fromEntries(symbols.map((s)=>[s,[]]));
  for(let page=0;page<maxPages;page++){
    const data=await alpaca(`${DATA_BASE}/v2/stocks/bars`,{symbols:symbols.join(','),timeframe,start,end,adjustment:'all',feed,sort:'asc',limit:10000,page_token:pageToken},env);
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
    const priorWeek=priorWeekRange(daysMap,dates[i]);if(priorWeek)levels.push(['PWH','high',priorWeek.high],['PWL','low',priorWeek.low]);
    const profile=marketProfileLevels(prev.rth);if(profile)levels.push(['Prior VAH','high',profile.vah],['Prior VAL','low',profile.val]);
    for(const [name,rows] of [['Overnight',cur.overnight],['Asia Proxy',cur.asia],['London Proxy',cur.london],['Premarket',cur.pre]])if(rows.length)levels.push([`${name} High`,'high',maxField(rows,'h')],[`${name} Low`,'low',minField(rows,'l')]);
    for(const [condition,direction,level] of levels){if(level===null)continue;const event=classifySweep(cur.rth,level,direction,condition,dates[i],vwap);if(event)events.push(event)}
    const liquidity=swingLiquidityLevels(resampleMinutes(cur.overnight,5),2);for(const row of liquidity.highs.slice(-3)){const event=classifySweep(cur.rth,row.price,'high','Overnight BSL',dates[i],vwap);if(event)events.push(event)}for(const row of liquidity.lows.slice(-3)){const event=classifySweep(cur.rth,row.price,'low','Overnight SSL',dates[i],vwap);if(event)events.push(event)}
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
    const date=dates[i],pPrev=splitSession(primary.get(dates[i-1])||[]),pCur=splitSession(primary.get(date)||[]),cPrev=splitSession(comparison.get(dates[i-1])||[]),cCur=splitSession(comparison.get(date)||[]);
    for(const [key,label] of [['rth','PDH/PDL'],['overnight','Overnight'],['asia','Asia Proxy'],['london','London Proxy'],['pre','Premarket']]){
      const pp=pPrev[key],pc=pCur[key],cp=cPrev[key],cc=cCur[key];if(!pp.length||!pc.length||!cp.length||!cc.length)continue;
      const pHigh=maxField(pp,'h'),cHigh=maxField(cp,'h'),pLow=minField(pp,'l'),cLow=minField(cp,'l');if([pHigh,cHigh,pLow,cLow].some((value)=>value===null))continue;
      const pHighIndex=findSweepIndex(pc,pHigh,'high'),cHighIndex=findSweepIndex(cc,cHigh,'high'),pLowIndex=findSweepIndex(pc,pLow,'low'),cLowIndex=findSweepIndex(cc,cLow,'low');
      const highEvent=confirmedSmtEvent(pc,cc,pHighIndex,cHighIndex,'down',`${symbol}/${paired} ${label} SMT high`,date);if(highEvent)events.push(highEvent);
      const lowEvent=confirmedSmtEvent(pc,cc,pLowIndex,cLowIndex,'up',`${symbol}/${paired} ${label} SMT low`,date);if(lowEvent)events.push(lowEvent);
    }
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

function buildPriceActionModel(daysMap,limitDays){
  const dates=[...daysMap.keys()].sort().slice(-limitDays),events=[],fvgRecords=[];
  for(const date of dates){const rth=splitSession(daysMap.get(date)||[]).rth;if(rth.length<30)continue;for(const timeframe of [1,5,15,60]){const scan=scanFvgs(rth,date,timeframe);events.push(...scan.events);fvgRecords.push(...scan.records)}events.push(...scanDisplacement(rth,date))}
  return{events,fvgRecords};
}

function scanFvgs(rth,date,timeframe){
  const bars=timeframe===1?rth:resampleMinutes(rth,timeframe),records=[],events=[];
  for(let i=2;i<bars.length;i++){
    const a=bars[i-2],c=bars[i],aHigh=finite(a.h),aLow=finite(a.l),cHigh=finite(c.h),cLow=finite(c.l),bull=aHigh!==null&&cLow!==null&&cLow>aHigh,bear=aLow!==null&&cHigh!==null&&cHigh<aLow;if(!bull&&!bear)continue;
    const side=bull?'Bullish':'Bearish',zoneLow=bull?aHigh:cHigh,zoneHigh=bull?cLow:aLow,formationTime=Date.parse(c.t),start=rth.findIndex((bar)=>Date.parse(bar.t)>=formationTime);if(start<0)continue;
    const formation=bars.slice(i-2,i+1),reference=bull?maxField(formation,'h'):minField(formation,'l'),end=Math.min(rth.length-1,start+180);let retest=null,fillAt=null,inversionAt=null,continuationAt=null;
    for(let j=start+1;j<=end;j++){
      const high=finite(rth[j].h),low=finite(rth[j].l),close=finite(rth[j].c);if(high===null||low===null)continue;
      if(retest===null&&low<=zoneHigh&&high>=zoneLow)retest=j;
      if(fillAt===null&&(bull?low<=zoneLow:high>=zoneHigh))fillAt=j;
      if(retest!==null){if(inversionAt===null&&close!==null&&(bull?close<zoneLow:close>zoneHigh))inversionAt=j;if(continuationAt===null&&reference!==null&&(bull?high>reference:low<reference))continuationAt=j}
    }
    const continuation=continuationAt!==null&&(inversionAt===null||continuationAt<inversionAt),inverted=inversionAt!==null&&(continuationAt===null||inversionAt<continuationAt),retested=retest!==null,minutesToRetest=retested?Math.round((Date.parse(rth[retest].t)-formationTime)/60000):null;
    const record={date,timeframe:`${timeframe}m`,side,formedAt:etParts(c.t).time,zoneLow,zoneHigh,retested,filled:fillAt!==null,continuation,inverted,minutesToRetest};records.push(record);
    if(retested){const expected=bull?'up':'down',event=classifyDirectionalOutcome(rth,retest,expected,`${timeframe}m ${side} FVG`,date);if(event){event.continuation=continuation;event.reversal=inverted;event.continuationModel=continuation;events.push(event)}}
    if(inverted){const expected=bull?'down':'up',event=classifyDirectionalOutcome(rth,inversionAt,expected,`${timeframe}m ${side} IFVG`,date);if(event)events.push(event)}
  }
  return{records,events};
}

function scanDisplacement(rth,date){
  const bars=resampleMinutes(rth,5),events=[];let last=-10;
  for(let i=20;i<bars.length;i++){
    const open=finite(bars[i].o),close=finite(bars[i].c),high=finite(bars[i].h),low=finite(bars[i].l);if([open,close,high,low].some((x)=>x===null)||high<=low)continue;
    const prior=bars.slice(i-20,i),bodyMedian=median(prior.map((bar)=>Math.abs((finite(bar.c)??0)-(finite(bar.o)??0)))),rangeMedian=median(prior.map((bar)=>{const h=finite(bar.h),l=finite(bar.l);return h===null||l===null?null:h-l})),body=Math.abs(close-open),range=high-low;if(!bodyMedian||!rangeMedian||body<bodyMedian*1.5||range<rangeMedian*1.5||i-last<3)continue;
    const bullish=close>open&&close>=low+range*.75,bearish=close<open&&close<=low+range*.25;if(!bullish&&!bearish)continue;const index=rth.findIndex((bar)=>Date.parse(bar.t)>=Date.parse(bars[i].t));if(index<0)continue;const event=classifyDirectionalOutcome(rth,index,bullish?'up':'down',bullish?'Bullish Displacement':'Bearish Displacement',date);if(event){events.push(event);last=i}
  }
  return events;
}

function summarizeFvg(records){
  const groups=new Map();for(const row of records){const key=`${row.timeframe} ${row.side}`,group=groups.get(key)||[];group.push(row);groups.set(key,group)}
  return[...groups.entries()].map(([condition,rows])=>({condition,n:rows.length,retestRate:rate(rows,'retested'),fillRate:rate(rows,'filled'),continuationRate:rate(rows,'continuation'),ifvgRate:rate(rows,'inverted'),medianMinutesToRetest:median(rows.map((row)=>row.minutesToRetest))}));
}

function buildLatestLevels(daysMap){
  const dates=[...daysMap.keys()].sort(),tradeDate=dates.at(-1);if(!tradeDate)return{tradeDate:null,rows:[]};const index=dates.length-1,current=splitSession(daysMap.get(tradeDate)||[]),previous=index>0?splitSession(daysMap.get(dates[index-1])||[]):null,rows=[];
  const pushRange=(prefix,session,window)=>{if(!session?.length)return;const source=[...new Set(session.map((bar)=>bar._source).filter(Boolean))].join(' + ')||'Observed';rows.push({level:`${prefix} High`,price:maxField(session,'h'),window,source},{level:`${prefix} Low`,price:minField(session,'l'),window,source})};
  if(previous?.rth.length){rows.push({level:'PDH',price:maxField(previous.rth,'h'),window:'Prior RTH',source:'SIP'},{level:'PDL',price:minField(previous.rth,'l'),window:'Prior RTH',source:'SIP'})}
  const priorWeek=priorWeekRange(daysMap,tradeDate);if(priorWeek)rows.push({level:'PWH',price:priorWeek.high,window:`Week of ${priorWeek.weekStart}`,source:'SIP'},{level:'PWL',price:priorWeek.low,window:`Week of ${priorWeek.weekStart}`,source:'SIP'});
  const profile=marketProfileLevels(previous?.rth||[]);if(profile)rows.push({level:'Prior VAH',price:profile.vah,window:'Prior RTH 70% value area',source:'SIP volume profile'},{level:'Prior VAL',price:profile.val,window:'Prior RTH 70% value area',source:'SIP volume profile'},{level:'Prior POC',price:profile.poc,window:'Prior RTH max-volume bin',source:'SIP volume profile'});
  pushRange('Overnight',current.overnight,'6:00 PM–9:30 AM ET');pushRange('Asia Proxy',current.asia,'8:00 PM–12:00 AM ET');pushRange('London Proxy',current.london,'2:00–5:00 AM ET');pushRange('Premarket',current.pre,'4:00–9:30 AM ET');
  const liquidity=swingLiquidityLevels(resampleMinutes(current.overnight,5),2),bsl=liquidity.highs.at(-1),ssl=liquidity.lows.at(-1);if(bsl)rows.push({level:'Latest Overnight BSL',price:bsl.price,window:'5m pivot',source:bsl.source});if(ssl)rows.push({level:'Latest Overnight SSL',price:ssl.price,window:'5m pivot',source:ssl.source});
  return{tradeDate,rows:rows.filter((row)=>row.price!==null)};
}

function coverageSummary(daysMap,limitDays){
  const dates=[...daysMap.keys()].sort().slice(-limitDays),summary={tradeDays:dates.length,boatsBars:0,sipBars:0,sessions:{overnight:0,asiaProxy:0,londonProxy:0,premarket:0,rth:0},note:'QQQ/SPY ETF proxy. SIP and BOATS results end at least 16 minutes before the request time on Alpaca Free.'};
  for(const date of dates){const bars=daysMap.get(date)||[],session=splitSession(bars);summary.boatsBars+=bars.filter((bar)=>bar._source==='BOATS').length;summary.sipBars+=bars.filter((bar)=>bar._source==='SIP').length;if(session.overnight.length)summary.sessions.overnight++;if(session.asia.length)summary.sessions.asiaProxy++;if(session.london.length)summary.sessions.londonProxy++;if(session.pre.length)summary.sessions.premarket++;if(session.rth.length)summary.sessions.rth++}return summary;
}

function summarizeConditions(events) {
  const groups=new Map();for(const e of events){const g=groups.get(e.condition)||[];g.push(e);groups.set(e.condition,g)}
  const modelRows=events.filter((e)=>e.continuationModel);if(modelRows.length)groups.set('Continuation Model',modelRows);
  return [...groups.entries()].map(([condition,rows])=>{const medianMfe=median(rows.map((r)=>r.mfe)),medianMae=median(rows.map((r)=>r.mae)),vwapRows=rows.filter((r)=>typeof r.vwapHit==='boolean');return{condition,n:rows.length,continuationRate:rate(rows,'continuation'),reversalRate:rate(rows,'reversal'),vwapHitRate:vwapRows.length?rate(vwapRows,'vwapHit'):null,medianMinutesToVwap:median(vwapRows.map((r)=>r.minutesToVwap)),medianMfe,medianMae,rewardRisk:medianMfe!==null&&medianMae!==null&&medianMae!==0?medianMfe/Math.abs(medianMae):null}});
}
function summarizeTiming(events) {
  const specs=[['PDH/PDL sweep',(e)=>/^(?:PDH|PDL)$/.test(e.condition)],['PWH/PWL sweep',(e)=>/^(?:PWH|PWL)$/.test(e.condition)],['Prior VAH/VAL',(e)=>/^Prior VA[HL]$/.test(e.condition)],['Overnight H/L',(e)=>e.condition.startsWith('Overnight ')&&!/BSL|SSL/.test(e.condition)],['Asia proxy H/L',(e)=>e.condition.startsWith('Asia Proxy')],['London proxy H/L',(e)=>e.condition.startsWith('London Proxy')],['Premarket H/L',(e)=>e.condition.startsWith('Premarket')],['Overnight BSL/SSL',(e)=>/Overnight (?:BSL|SSL)/.test(e.condition)]];
  return specs.map(([label,predicate])=>{const rows=events.filter(predicate);
    const result={label};for(const [key,cutoff] of [['before1000',600],['before1030',630],['before1100',660],['fullRth',960]]){const q=rows.filter((e)=>e.minute<=cutoff);result[key]=q.length?rate(q,'continuation'):null;result[key+'N']=q.length}return result});
}

function groupEtDays(bars){const map=new Map();for(const bar of bars){const p=etParts(bar.t),row={...bar,_time:p.time};if(!map.has(p.date))map.set(p.date,[]);map.get(p.date).push(row)}return map}
function groupProxyTradeDays(sipBars,overnightBars){const grouped=new Map();const add=(bars,source)=>{for(const bar of bars){const p=etParts(bar.t),minute=timeToMinute(p.time);if(source==='BOATS'&&minute>=240&&minute<1200)continue;if(source==='SIP'&&(minute>=1200||minute<240))continue;const tradeDate=minute>=1080?addIsoDays(p.date,1):p.date,row={...bar,_time:p.time,_source:source,_tradeDate:tradeDate};if(!grouped.has(tradeDate))grouped.set(tradeDate,new Map());const day=grouped.get(tradeDate),existing=day.get(String(bar.t));if(!existing||source==='BOATS')day.set(String(bar.t),row)}};add(sipBars,'SIP');add(overnightBars,'BOATS');return new Map([...grouped.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([date,rows])=>[date,[...rows.values()].sort((a,b)=>String(a.t).localeCompare(String(b.t)))]))}
function splitSession(bars){const minute=(b)=>timeToMinute(b._time);return{evening:bars.filter((b)=>minute(b)>=1080&&minute(b)<1200),overnight:bars.filter((b)=>minute(b)>=1080||minute(b)<570),asia:bars.filter((b)=>minute(b)>=1200),london:bars.filter((b)=>minute(b)>=120&&minute(b)<300),pre:bars.filter((b)=>minute(b)>=240&&minute(b)<570),rth:bars.filter((b)=>minute(b)>=570&&minute(b)<960)}}
function resampleMinutes(bars,minutes){if(minutes===1)return bars.slice();const groups=new Map(),size=minutes*60000,anchor=Date.parse(bars[0]?.t);if(!Number.isFinite(anchor))return[];for(const bar of bars){const time=Date.parse(bar.t);if(!Number.isFinite(time))continue;const key=anchor+Math.floor((time-anchor)/size)*size;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(bar)}return[...groups.entries()].sort((a,b)=>a[0]-b[0]).map(([time,rows])=>({t:new Date(time).toISOString(),o:finite(rows[0].o),h:maxField(rows,'h'),l:minField(rows,'l'),c:finite(rows.at(-1).c),v:rows.reduce((sum,row)=>sum+(finite(row.v)||0),0),_time:etParts(new Date(time).toISOString()).time,_source:[...new Set(rows.map((row)=>row._source).filter(Boolean))].join(' + ')}))}
function swingLiquidityLevels(bars,pivot=2){const highs=[],lows=[];for(let i=pivot;i<bars.length-pivot;i++){const high=finite(bars[i].h),low=finite(bars[i].l);if(high!==null&&bars.slice(i-pivot,i+pivot+1).every((bar,j)=>j===pivot||finite(bar.h)===null||finite(bar.h)<high))highs.push({price:high,time:bars[i].t,source:bars[i]._source||'Observed'});if(low!==null&&bars.slice(i-pivot,i+pivot+1).every((bar,j)=>j===pivot||finite(bar.l)===null||finite(bar.l)>low))lows.push({price:low,time:bars[i].t,source:bars[i]._source||'Observed'})}return{highs,lows}}
function priorWeekRange(daysMap,currentDate){const currentStart=weekStart(currentDate),prior=[...daysMap.keys()].filter((date)=>weekStart(date)<currentStart).sort();if(!prior.length)return null;const target=weekStart(prior.at(-1)),bars=prior.filter((date)=>weekStart(date)===target).flatMap((date)=>splitSession(daysMap.get(date)||[]).rth);if(!bars.length)return null;return{weekStart:target,high:maxField(bars,'h'),low:minField(bars,'l')}}
function marketProfileLevels(bars,bins=50,valueArea=.70){if(!bars.length)return null;const low=minField(bars,'l'),high=maxField(bars,'h');if(low===null||high===null||high<=low)return null;const size=(high-low)/bins,volume=Array(bins).fill(0);for(const bar of bars){const h=finite(bar.h),l=finite(bar.l),c=finite(bar.c),v=finite(bar.v);if(h===null||l===null||c===null||v===null||v<=0)continue;const typical=(h+l+c)/3,index=Math.max(0,Math.min(bins-1,Math.floor((typical-low)/size)));volume[index]+=v}const total=volume.reduce((sum,v)=>sum+v,0);if(total<=0)return null;let pocIndex=volume.indexOf(Math.max(...volume)),left=pocIndex,right=pocIndex,included=volume[pocIndex];while(included<total*valueArea&&(left>0||right<bins-1)){const leftVolume=left>0?volume[left-1]:-1,rightVolume=right<bins-1?volume[right+1]:-1;if(rightVolume>leftVolume){right++;included+=volume[right]}else{left--;included+=volume[left]}}return{poc:low+(pocIndex+.5)*size,val:low+left*size,vah:low+(right+1)*size,coverage:included/total,bins}}
function findSweepIndex(bars,level,direction){for(let i=0;i<bars.length;i++){const open=finite(bars[i]?.o),high=finite(bars[i]?.h),low=finite(bars[i]?.l),previousClose=i>0?finite(bars[i-1]?.c):null;if(direction==='high'){const startedBelow=previousClose!==null?previousClose<level:open!==null&&open<=level;if(startedBelow&&low!==null&&low<=level&&high!==null&&high>=level)return i}else{const startedAbove=previousClose!==null?previousClose>level:open!==null&&open>=level;if(startedAbove&&high!==null&&high>=level&&low!==null&&low<=level)return i}}return-1}
function cumulativeVwap(bars){let pv=0,volume=0;return bars.map((bar)=>{const high=finite(bar.h),low=finite(bar.l),close=finite(bar.c),v=finite(bar.v);if(high!==null&&low!==null&&close!==null&&v!==null&&v>0){pv+=((high+low+close)/3)*v;volume+=v}return volume>0?pv/volume:null})}
function etParts(value){const parts=Object.fromEntries(ET_FORMATTER.formatToParts(new Date(value)).filter((p)=>p.type!=='literal').map((p)=>[p.type,p.value]));return{date:`${parts.year}-${parts.month}-${parts.day}`,time:`${parts.hour}:${parts.minute}`}}
function timeToMinute(value){const [h,m]=String(value).split(':').map(Number);return h*60+m}
function addIsoDays(value,days){const date=new Date(`${value}T12:00:00Z`);date.setUTCDate(date.getUTCDate()+days);return date.toISOString().slice(0,10)}
function weekStart(value){const date=new Date(`${value}T12:00:00Z`),day=date.getUTCDay()||7;date.setUTCDate(date.getUTCDate()-day+1);return date.toISOString().slice(0,10)}

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
export const __test = {analyseFib,statsFromFibEvents,combineFibStats,findGammaFlip,resampleWeekly,resampleMinutes,metrics,classifySweep,findSweepIndex,detectContinuationModel,groupProxyTradeDays,splitSession,scanFvgs,summarizeFvg,summarizeConditions,summarizeTiming,priorWeekRange,marketProfileLevels,cumulativeVwap,finite,median};
