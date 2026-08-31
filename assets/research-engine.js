(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = { module: 'options', data: {}, loading: false };
  const COLORS = { red:'#d14343', green:'#cfcfd4', amber:'#6f6f76', blue:'#8e8e95', muted:'#9a9aa0', text:'#ededee', line:'#3a3a40' };

  function esc(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  }
  function numeric(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  function num(value, digits = 0) {
    const n = numeric(value);
    return n !== null ? n.toLocaleString(undefined, {minimumFractionDigits:digits, maximumFractionDigits:digits}) : '—';
  }
  function money(value, digits = 2) {
    const n = numeric(value);
    return n !== null ? '$' + n.toLocaleString(undefined, {minimumFractionDigits:digits, maximumFractionDigits:digits}) : '—';
  }
  function pct(value, digits = 1) {
    const n = numeric(value);
    return n !== null ? (n * 100).toFixed(digits) + '%' : '—';
  }
  function signedPct(value, digits = 1) {
    const n = numeric(value);
    if (n === null) return '—';
    return (n > 0 ? '+' : '') + (n * 100).toFixed(digits) + '%';
  }
  function signedMoney(value, digits = 1) {
    const n = numeric(value);
    if (n === null) return '—';
    return (n > 0 ? '+' : n < 0 ? '-' : '') + '$' + Math.abs(n).toFixed(digits);
  }
  function dateText(value) {
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d.toLocaleString(undefined, {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : '—';
  }
  function median(values) {
    const a = values.map(numeric).filter((value) => value !== null).sort((x,y) => x-y);
    if (!a.length) return null;
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid-1] + a[mid]) / 2;
  }
  function setMessage(text, type = '') {
    const node = $('gateMessage');
    node.textContent = text;
    node.className = 'message' + (type ? ' ' + type : '');
  }
  function setKpi(id, text, tone) {
    const node = $(id);
    if (!node) return;
    node.textContent = text;
    const card = node.closest('.kpi');
    if (card) { card.classList.remove('positive','negative','caution'); if (tone) card.classList.add(tone); }
  }
  function classify(value, inverse = false) {
    const n = numeric(value);
    if (n === null) return '';
    const good = inverse ? n < 0 : n > 0;
    return good ? 'good' : n === 0 ? 'warn' : 'bad';
  }
  function thresholdClass(value, threshold = .5, inverse = false) {
    const n = numeric(value);
    return n === null ? '' : classify(n - threshold, inverse);
  }

  async function jsonFetch(url, options = {}) {
    // Session travels via HttpOnly cookie; no Authorization header needed.
    const res = await fetch(url, {...options, credentials:'same-origin', cache:'no-store'});
    const payload = await res.json().catch(() => ({ok:false,error:'The server returned a non-JSON response.'}));
    if (!res.ok || payload.ok === false) {
      const err = new Error(payload.error || payload.message || `Request failed (${res.status})`);
      err.status = res.status; err.payload = payload; throw err;
    }
    return payload;
  }

  async function loadHealth() {
    try {
      const data = await jsonFetch('/api/research-engine?module=health');
      $('healthDot').className = 'dot ' + (data.configured?.alpaca ? 'ok' : 'bad');
      $('healthText').textContent = data.configured?.alpaca ? 'Connected' : 'Needs setup';
      $('equityFeed').textContent = data.feeds?.equities || 'IEX';
      $('optionFeed').textContent = data.feeds?.options || 'Indicative';
      $('storageStatus').textContent = data.configured?.database ? 'D1 connected' : 'Cache only';
    } catch (err) {
      $('healthDot').className = 'dot bad'; $('healthText').textContent = 'Unavailable'; $('storageStatus').textContent = 'Unknown';
    }
  }

  async function unlock() {
    const code = $('premiumCode').value.trim();
    if (!code) { setMessage('Enter your premium access code.', 'error'); return; }
    $('unlockButton').disabled = true; setMessage('Checking access…');
    try {
      // turnstileToken is required by the server since bot protection went live;
      // omitting it made every unlock on this page fail with 'Verification failed'.
      const tsEl = document.getElementById('re-ts');
      const tsInput = tsEl && tsEl.querySelector('[name="cf-turnstile-response"]');
      await jsonFetch('/api/verify-premium', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code, turnstileToken: tsInput ? tsInput.value : ''})});
      setMessage('Access verified.', 'ok'); activateEngine();
    } catch (err) { setMessage(err.message, 'error'); if (window.turnstile) { const t=document.getElementById('re-ts'); if (t) window.turnstile.reset(t); } }
    finally { $('unlockButton').disabled = false; }
  }
  async function restore(quiet = false) {
    if (!quiet) { $('restoreButton').disabled = true; setMessage('Restoring session…'); }
    try {
      const data = await jsonFetch('/api/verify-premium');
      if (!data.active) {
        if (!quiet) throw new Error('No active premium session was found on this device.');
        return;
      }
      setMessage('Session restored.', 'ok'); activateEngine();
    } catch (err) { setMessage(err.message, 'error'); }
    finally { $('restoreButton').disabled = false; }
  }
  function activateEngine() {
    $('researchGate').style.display = 'none';
    $('engine').classList.add('unlocked');
    requestAnimationFrame(() => $('engine').scrollIntoView({behavior:'smooth',block:'start'}));
    loadCurrent();
  }
  function signOut() {
    fetch('/api/logout-premium', {method:'POST',credentials:'same-origin'}).finally(() => location.reload());
  }

  function setModule(module) {
    state.module = module;
    document.querySelectorAll('.module-tab').forEach((button) => {
      const active = button.dataset.module === module;
      button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('[data-module-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.modulePanel === module));
    loadCurrent();
  }
  function loading(button, active, label) {
    if (!active) state.loading = false;
    if (!button) return;
    if (active) {
      // A second call while already loading must not capture the spinner text
      // as the "original" label — that's how buttons got stuck on "Scanning".
      if (!button.dataset.loading) { button.dataset.original = button.textContent; }
      button.dataset.loading = '1';
      button.disabled = true; button.innerHTML = '<i class="loader"></i> ' + esc(label || 'Loading');
    }
    else { delete button.dataset.loading; button.disabled = false; button.textContent = button.dataset.original || 'Refresh'; }
  }
  function updateGlobal(response) {
    if (!response) return;
    $('globalAsOf').textContent = dateText(response.asOf);
    $('globalMode').textContent = String(response.mode || 'Observed').toUpperCase();
  }
  function showModuleError(statusId, err) {
    const node = $(statusId);
    if (node) { node.textContent = err.message; node.style.color = '#e26060'; }
  }

  async function loadOptions() {
    if (state.loading) return; state.loading = true;
    const button = $('loadOptions'); loading(button, true, 'Scanning');
    $('optionsSourceStatus').textContent = 'Loading current chain and intraday bars…';
    try {
      const symbol = $('optionsSymbol').value;
      const days = $('optionsExpiry').value;
      const intradayDays = $('intradayDays').value;
      const [options, intraday] = await Promise.all([
        jsonFetch(`/api/research-engine?module=options&symbol=${encodeURIComponent(symbol)}&expiryDays=${encodeURIComponent(days)}`),
        jsonFetch(`/api/research-engine?module=intraday&symbol=${encodeURIComponent(symbol)}&days=${encodeURIComponent(intradayDays)}`)
      ]);
      state.data.options = {options, intraday}; renderOptions(options, intraday); updateGlobal(options);
    } catch (err) { showModuleError('optionsSourceStatus', err); }
    finally { loading(button, false); }
  }
  function renderOptions(response, intradayResponse) {
    const d = response.data || {}, intra = intradayResponse.data || {};
    const coverage=intra.coverage||{};
    $('optionsSourceStatus').textContent = `${response.source?.equities || 'IEX spot'} • ${num(coverage.sipBars)} SIP + ${num(coverage.boatsBars)} BOATS bars • ${response.source?.options || 'Indicative options'} • ${dateText(response.asOf)}`;
    $('optionsSourceStatus').style.color = '';
    setKpi('optSpot', money(d.spot));
    setKpi('optNetGex', (Number.isFinite(d.netGexMm) ? signedMoney(d.netGexMm) + 'mm' : '—'), d.netGexMm > 0 ? 'positive' : d.netGexMm < 0 ? 'negative' : '');
    setKpi('optGammaFlip', Number.isFinite(d.gammaFlip) ? money(d.gammaFlip) : 'Not detected');
    setKpi('optContracts', num(d.contractsAnalyzed));
    setKpi('optPrecision', String(d.precision || 'Unknown').toUpperCase(), d.precision === 'opra' ? 'positive' : 'caution');
    $('optPrecisionNote').textContent = d.precisionNote || 'Feed entitlement';
    renderGexChart(d.gexByStrike || []);
    renderConditions(intra.conditions || []);
    renderTiming(intra.timing || []);
    renderSessionLevels(intra.latestLevels || {}, coverage);
    renderFvgStats(intra.fvgStats || []);
    if (Number.isFinite(d.spot)) { $('labSpot').value = d.spot.toFixed(2); renderSlopeLab(); }
  }
  function renderConditions(rows) {
    const body = $('optionsConditionBody');
    if (!rows.length) { body.innerHTML = '<tr><td colspan="9">No qualified events were found in the selected sample.</td></tr>'; return; }
    body.innerHTML = rows.map((r) => `<tr><td>${esc(r.condition)}</td><td class="num">${num(r.n)}</td><td class="num ${thresholdClass(r.continuationRate)}">${pct(r.continuationRate)}</td><td class="num ${thresholdClass(r.reversalRate)}">${pct(r.reversalRate)}</td><td class="num ${thresholdClass(r.vwapHitRate)}">${pct(r.vwapHitRate)}</td><td class="num">${numeric(r.medianMinutesToVwap) === null ? '—' : num(r.medianMinutesToVwap)+' min'}</td><td class="num ${classify(r.medianMfe)}">${pct(r.medianMfe)}</td><td class="num ${classify(r.medianMae,true)}">${pct(r.medianMae)}</td><td class="num">${numeric(r.rewardRisk) === null ? '—' : num(r.rewardRisk,2)+'R'}</td></tr>`).join('');
  }
  function renderTiming(rows) {
    const root = $('timingHeatmap');
    const headers = ['', 'Before 10:00', 'Before 10:30', 'Before 11:00', 'Full RTH'];
    const cells = headers.map((x) => `<div class="h">${esc(x)}</div>`);
    for (const row of rows) {
      cells.push(`<div class="label">${esc(row.label)}</div>`);
      for (const key of ['before1000','before1030','before1100','fullRth']) {
        const rate = numeric(row[key]);
        const level = rate === null ? '' : rate >= .65 ? 'heat-3' : rate >= .5 ? 'heat-2' : rate >= .35 ? 'heat-1' : 'heat-0';
        cells.push(`<div class="${level}" title="Conditional follow-through rate">${rate !== null ? pct(rate) : '—'}<br><small>N=${num(row[key+'N'])}</small></div>`);
      }
    }
    root.innerHTML = cells.join('');
  }
  function renderSessionLevels(latest, coverage) {
    const rows=latest.rows||[],body=$('sessionLevelBody');
    body.innerHTML=rows.length?rows.map((row)=>`<tr><td><b>${esc(row.level)}</b></td><td class="num">${money(row.price)}</td><td>${esc(row.window)}</td><td><span class="mono">${esc(row.source)}</span></td></tr>`).join(''):'<tr><td colspan="4">No complete proxy session was returned.</td></tr>';
    const chip=$('proxyCoverageChip'),sessions=coverage.sessions||{},complete=Math.min(sessions.overnight||0,sessions.rth||0);chip.textContent=`${num(complete)} observed trade days`;chip.className='chip '+(complete>=5?'green':'amber');
  }
  function renderFvgStats(rows) {
    const body=$('fvgBody');
    body.innerHTML=rows.length?rows.map((row)=>`<tr><td><b>${esc(row.condition)}</b></td><td class="num">${num(row.n)}</td><td class="num ${thresholdClass(row.retestRate)}">${pct(row.retestRate)}</td><td class="num ${thresholdClass(row.fillRate)}">${pct(row.fillRate)}</td><td class="num ${thresholdClass(row.continuationRate)}">${pct(row.continuationRate)}</td><td class="num ${thresholdClass(row.ifvgRate,.5,true)}">${pct(row.ifvgRate)}</td><td class="num">${numeric(row.medianMinutesToRetest)===null?'—':num(row.medianMinutesToRetest,0)+' min'}</td></tr>`).join(''):'<tr><td colspan="7">No FVG observations were returned.</td></tr>';
  }
  function renderGexChart(rows) {
    const data = rows.filter((r) => numeric(r.netGexMm) !== null).map((r) => ({label:String(r.strike),value:numeric(r.netGexMm)}));
    renderBarChart($('gexChart'), data, {zero:true, valueFormat:(v)=>signedMoney(v,1)+'mm', positive:COLORS.green, negative:COLORS.red, xTitle:'Strike', yTitle:'Net GEX ($mm)'});
  }

  async function loadStock() {
    if (state.loading) return; state.loading = true;
    const button = $('loadStock'); loading(button, true, 'Testing'); $('stockSourceStatus').textContent = 'Downloading adjusted daily bars…';
    try {
      const symbol = $('stockSymbol').value.trim().toUpperCase();
      const lookback = $('stockLookback').value, horizon = $('stockHorizon').value, timeframe = $('stockTimeframe').value;
      const response = await jsonFetch(`/api/research-engine?module=stock&symbol=${encodeURIComponent(symbol)}&lookback=${encodeURIComponent(lookback)}&horizon=${encodeURIComponent(horizon)}&timeframe=${encodeURIComponent(timeframe)}&pivot=5`);
      state.data.stocks = response; renderStock(response); updateGlobal(response);
    } catch (err) { showModuleError('stockSourceStatus', err); }
    finally { loading(button, false); }
  }
  function renderStock(response) {
    const d = response.data || {}, s = d.summary || {};
    $('stockSourceStatus').textContent = `${response.source?.equities || 'IEX'} • ${dateText(response.asOf)}`; $('stockSourceStatus').style.color = '';
    setKpi('stockPrice', money(s.lastPrice)); $('stockAsOf').textContent = 'As of ' + (s.lastDate || '—');
    setKpi('stockReturn20', signedPct(s.return20), s.return20 > 0 ? 'positive' : s.return20 < 0 ? 'negative' : '');
    setKpi('stockAtr', pct(s.atr14Pct), s.atr14Pct > .05 ? 'caution' : '');
    setKpi('stockSetups', num(s.setups)); setKpi('stockBestFib', s.bestFib || 'Insufficient N');
    const breakdown = d.timeframeBreakdown || [];
    const rows = breakdown.length ? breakdown.flatMap((group) => (group.stats || []).map((row) => ({...row,timeframe:group.timeframe}))) : (d.fibStats || []).map((row) => ({...row,timeframe:''}));
    $('fibBody').innerHTML = rows.length ? rows.map((r) => `<tr><td>${r.timeframe ? `<span class="mono">${esc(r.timeframe)}</span> · ` : ''}${pct(r.level,1)}</td><td class="num">${num(r.touches)}</td><td class="num ${r.touches >= 5 ? classify((r.fillRate ?? 0)-.5) : 'warn'}">${pct(r.fillRate)}</td><td class="num ${r.touches >= 5 ? classify((r.newHighRate ?? 0)-.5) : 'warn'}">${pct(r.newHighRate)}</td><td class="num">${num(r.medianDays,1)}</td><td class="num good">${pct(r.medianMfe)}</td><td class="num bad">${pct(r.medianMae)}</td></tr>`).join('') : '<tr><td colspan="7">No qualified swing events were found.</td></tr>';
    renderGroupedBar($('fibChart'), rows.map((r) => ({label:(r.level*100).toFixed(1)+'%',fill:r.fillRate,newHigh:r.newHighRate})), {series:[['fill','Fill rate',COLORS.green],['newHigh','New-high rate',COLORS.red]]});
    const w = d.latestSwing;
    $('swingBody').innerHTML = w ? `<tr><td>${esc(w.lowDate)}</td><td class="num">${money(w.low)}</td><td>${esc(w.highDate)}</td><td class="num">${money(w.high)}</td><td class="num">${money(w.levels?.['0.382'])}</td><td class="num">${money(w.levels?.['0.5'])}</td><td class="num">${money(w.levels?.['0.618'])}</td><td>${esc(w.status || 'Observed')}</td></tr>` : '<tr><td colspan="8">No current swing could be resolved from the selected sample.</td></tr>';
  }

  async function loadSectors() {
    if (state.loading) return; state.loading = true;
    const button = $('loadSectors'); loading(button, true, 'Refreshing'); $('sectorSourceStatus').textContent = 'Loading sector ETFs…';
    try { const response = await jsonFetch('/api/research-engine?module=sectors'); state.data.sectors = response; renderSectors(response); updateGlobal(response); }
    catch (err) { showModuleError('sectorSourceStatus', err); }
    finally { loading(button, false); }
  }
  function renderSectors(response) {
    const d = response.data || {}, rows = d.rows || [];
    $('sectorSourceStatus').textContent = `${response.source?.equities || 'IEX'} • ${dateText(response.asOf)}`; $('sectorSourceStatus').style.color = '';
    const leader = rows[0], laggard = rows[rows.length-1];
    setKpi('sectorLeader', leader ? leader.etf : '—'); setKpi('sectorLaggard', laggard ? laggard.etf : '—');
    setKpi('sectorRiskOn', num(rows.filter((r)=>r.relativeStrength > 0).length));
    setKpi('sectorAtr', pct(median(rows.map((r)=>r.atr14Pct)))); setKpi('sectorQqq', signedPct(d.benchmarkReturn20), d.benchmarkReturn20 > 0 ? 'positive' : 'negative');
    $('sectorBody').innerHTML = rows.map((r) => `<tr><td><b>${esc(r.etf)}</b></td><td>${esc(r.sector)}</td><td class="num ${classify(r.return1)}">${signedPct(r.return1)}</td><td class="num ${classify(r.return5)}">${signedPct(r.return5)}</td><td class="num ${classify(r.return20)}">${signedPct(r.return20)}</td><td class="num ${classify(r.relativeStrength)}">${signedPct(r.relativeStrength)}</td><td class="num">${pct(r.upDayShare)}</td><td class="num ${r.atr14Pct > .035 ? 'warn' : ''}">${pct(r.atr14Pct)}</td></tr>`).join('');
    renderBarChart($('sectorChart'), rows.map((r)=>({label:r.etf,value:r.relativeStrength})), {zero:true,valueFormat:(v)=>signedPct(v),positive:COLORS.green,negative:COLORS.red,xTitle:'Sector ETF',yTitle:'20D relative strength'});
  }

  async function loadBiotech() {
    if (state.loading) return; state.loading = true;
    const button = $('loadBiotech'); loading(button, true, 'Refreshing'); $('biotechSourceStatus').textContent = 'Loading biotech price and volume…';
    try { const response = await jsonFetch('/api/research-engine?module=biotech'); state.data.biotech = response; renderBiotech(response); updateGlobal(response); }
    catch (err) { showModuleError('biotechSourceStatus', err); }
    finally { loading(button, false); }
  }
  function renderBiotech(response) {
    const d=response.data||{}, rows=d.rows||[];
    $('biotechSourceStatus').textContent = `${response.source?.equities || 'IEX'} • ${dateText(response.asOf)}`; $('biotechSourceStatus').style.color = '';
    setKpi('bioCount', num(rows.length)); setKpi('bioHighRisk', num(rows.filter((r)=>r.riskFlag==='HIGH').length)); setKpi('bioAtr', pct(median(rows.map((r)=>r.atr14Pct)))); setKpi('bioVolume', num(rows.filter((r)=>r.volumeRatio>=2).length));
    $('biotechBody').innerHTML = rows.map((r)=>`<tr><td><b>${esc(r.ticker)}</b></td><td>${esc(r.type)}</td><td class="num ${classify(r.return5)}">${signedPct(r.return5)}</td><td class="num ${classify(r.return20)}">${signedPct(r.return20)}</td><td class="num ${r.atr14Pct>.06?'warn':''}">${pct(r.atr14Pct)}</td><td class="num ${r.volumeRatio>=2?'warn':''}">${num(r.volumeRatio,2)}x</td><td class="num ${classify(r.gap)}">${signedPct(r.gap)}</td><td class="${r.riskFlag==='HIGH'?'bad':r.riskFlag==='REVIEW'?'warn':'good'}">${esc(r.riskFlag)}</td><td class="warn">Not connected</td></tr>`).join('');
  }

  function loadCurrent() {
    if (!$('engine').classList.contains('unlocked') || state.loading) return;
    if (state.data[state.module]) return;
    if (state.module === 'options') loadOptions();
    if (state.module === 'stocks') loadStock();
    if (state.module === 'sectors') loadSectors();
    if (state.module === 'biotech') loadBiotech();
  }
  function refreshCurrent() {
    delete state.data[state.module];
    if (state.module === 'options') loadOptions();
    if (state.module === 'stocks') loadStock();
    if (state.module === 'sectors') loadSectors();
    if (state.module === 'biotech') loadBiotech();
  }

  function renderBarChart(container, data, options = {}) {
    if (!container) return;
    data = data.map((item) => ({...item,value:numeric(item.value)})).filter((item) => item.value !== null);
    if (!data.length) { container.innerHTML = '<div class="chart-empty">No chartable observations were returned.</div>'; return; }
    const W=760,H=340,p={l:60,r:20,t:24,b:58}, iw=W-p.l-p.r, ih=H-p.t-p.b;
    const values=data.map(d=>d.value); let min=Math.min(...values,0),max=Math.max(...values,0);
    if(min===max){min-=1;max+=1} const span=max-min; min-=span*.08; max+=span*.08;
    const y=(v)=>p.t+(max-v)/(max-min)*ih, zero=y(0), step=iw/data.length, bw=Math.max(5,step*.62);
    let svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(options.yTitle||'Bar chart')}">`;
    for(let i=0;i<=4;i++){const v=min+(max-min)*i/4, yy=y(v);svg+=`<line x1="${p.l}" y1="${yy}" x2="${W-p.r}" y2="${yy}" stroke="${COLORS.line}" stroke-opacity=".45"/><text x="${p.l-8}" y="${yy+4}" fill="${COLORS.muted}" font-size="10" text-anchor="end">${esc(options.valueFormat?options.valueFormat(v):num(v,1))}</text>`}
    svg+=`<line x1="${p.l}" y1="${zero}" x2="${W-p.r}" y2="${zero}" stroke="${COLORS.muted}" stroke-opacity=".8"/>`;
    data.forEach((d,i)=>{const v=d.value,x=p.l+i*step+(step-bw)/2, yy=y(v),h=Math.max(1,Math.abs(zero-yy)),top=v>=0?yy:zero,color=v>=0?(options.positive||COLORS.green):(options.negative||COLORS.red);const showLabel=data.length<=22||i%Math.ceil(data.length/16)===0;svg+=`<rect class="chart-mark" data-label="${esc(d.label)}" data-value="${esc(options.valueFormat?options.valueFormat(v):String(v))}" x="${x}" y="${top}" width="${bw}" height="${h}" rx="3" fill="${color}" fill-opacity=".82"/>${showLabel?`<text x="${x+bw/2}" y="${H-p.b+16}" fill="${COLORS.muted}" font-size="9" text-anchor="middle" transform="rotate(-35 ${x+bw/2} ${H-p.b+16})">${esc(d.label)}</text>`:''}`});
    svg+=`<text x="${W/2}" y="${H-7}" fill="${COLORS.muted}" font-size="10" text-anchor="middle">${esc(options.xTitle||'')}</text></svg><div class="chart-tooltip"></div>`;
    container.innerHTML=svg; bindTooltip(container);
  }
  function renderGroupedBar(container, data, options={}) {
    if(!data.length){container.innerHTML='<div class="chart-empty">No chartable observations were returned.</div>';return}
    const W=720,H=330,p={l:48,r:18,t:24,b:48},iw=W-p.l-p.r,ih=H-p.t-p.b,max=1,groups=data.length,series=options.series||[],groupW=iw/groups,barW=Math.min(46,groupW/(series.length+1));let svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Grouped probability chart">`;
    for(let i=0;i<=4;i++){const v=i/4,y=p.t+(1-v)*ih;svg+=`<line x1="${p.l}" y1="${y}" x2="${W-p.r}" y2="${y}" stroke="${COLORS.line}" stroke-opacity=".45"/><text x="${p.l-7}" y="${y+4}" fill="${COLORS.muted}" font-size="10" text-anchor="end">${Math.round(v*100)}%</text>`}
    data.forEach((d,i)=>{series.forEach(([key,label,color],j)=>{const v=Math.max(0,Math.min(max,Number(d[key])||0)),x=p.l+i*groupW+(groupW-series.length*barW)/2+j*barW,y=p.t+(1-v)*ih,h=v*ih;svg+=`<rect class="chart-mark" data-label="${esc(d.label+' · '+label)}" data-value="${pct(v)}" x="${x}" y="${y}" width="${barW-4}" height="${h}" rx="4" fill="${color}" fill-opacity=".85"/>`});svg+=`<text x="${p.l+i*groupW+groupW/2}" y="${H-24}" fill="${COLORS.muted}" font-size="11" text-anchor="middle">${esc(d.label)}</text>`});
    series.forEach(([key,label,color],i)=>{const x=p.l+i*140;svg+=`<rect x="${x}" y="5" width="9" height="9" rx="2" fill="${color}"/><text x="${x+14}" y="13" fill="${COLORS.muted}" font-size="10">${esc(label)}</text>`});
    svg+='</svg><div class="chart-tooltip"></div>';container.innerHTML=svg;bindTooltip(container);
  }
  function renderLineChart(container, labels, series) {
    if(!labels.length){container.innerHTML='<div class="chart-empty">No data.</div>';return}
    const W=900,H=350,p={l:54,r:22,t:30,b:46},iw=W-p.l-p.r,ih=H-p.t-p.b,values=series.flatMap(s=>s.values).filter(Number.isFinite);let min=Math.min(...values),max=Math.max(...values);if(min===max){min-=1;max+=1}const pad=(max-min)*.1;min-=pad;max+=pad;const x=i=>p.l+i/(labels.length-1)*iw,y=v=>p.t+(max-v)/(max-min)*ih;let svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Option premium path chart">`;
    for(let i=0;i<=4;i++){const v=min+(max-min)*i/4,yy=y(v);svg+=`<line x1="${p.l}" y1="${yy}" x2="${W-p.r}" y2="${yy}" stroke="${COLORS.line}" stroke-opacity=".45"/><text x="${p.l-7}" y="${yy+4}" fill="${COLORS.muted}" font-size="10" text-anchor="end">$${v.toFixed(2)}</text>`}
    series.forEach((s,si)=>{const points=s.values.map((v,i)=>`${x(i)},${y(v)}`).join(' ');svg+=`<polyline points="${points}" fill="none" stroke="${s.color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;s.values.forEach((v,i)=>svg+=`<circle class="chart-mark" data-label="${esc(s.name+' · '+labels[i]+'m')}" data-value="$${v.toFixed(2)}" cx="${x(i)}" cy="${y(v)}" r="${labels.length>30?2.5:3.5}" fill="${s.color}"/>`);svg+=`<rect x="${p.l+si*160}" y="7" width="10" height="10" rx="3" fill="${s.color}"/><text x="${p.l+14+si*160}" y="16" fill="${COLORS.muted}" font-size="10">${esc(s.name)}</text>`});
    for(let i=0;i<labels.length;i+=Math.max(1,Math.ceil(labels.length/10)))svg+=`<text x="${x(i)}" y="${H-18}" fill="${COLORS.muted}" font-size="10" text-anchor="middle">${labels[i]}m</text>`;
    svg+='</svg><div class="chart-tooltip"></div>';container.innerHTML=svg;bindTooltip(container);
  }
  function bindTooltip(container) {
    const tip=container.querySelector('.chart-tooltip');
    container.querySelectorAll('.chart-mark').forEach((mark)=>{
      mark.addEventListener('mouseenter',()=>{tip.innerHTML=`<b>${esc(mark.dataset.label)}</b><br>${esc(mark.dataset.value)}`;tip.style.display='block'});
      mark.addEventListener('mousemove',(e)=>{const r=container.getBoundingClientRect();tip.style.left=Math.min(r.width-145,e.clientX-r.left+12)+'px';tip.style.top=Math.max(8,e.clientY-r.top-12)+'px'});
      mark.addEventListener('mouseleave',()=>tip.style.display='none');
    });
  }

  function renderSlopeLab() {
    const spot=Math.max(.01,Number($('labSpot').value)||600),targetMove=Number($('labMove').value)||0,horizon=Math.max(5,Number($('labMinutes').value)||90),ivPoints=Number($('labIv').value)||0,qty=Math.max(1,Number($('labQty').value)||1),hedgeQty=Math.max(0,Number($('labHedge').value)||0);
    const profiles=[
      {name:'ITM call',premium:6.5,delta:.72,gamma:.018,theta:-.10,vega:.11,color:COLORS.blue,qty},
      {name:'ATM call',premium:3.8,delta:.52,gamma:.026,theta:-.16,vega:.14,color:COLORS.green,qty},
      {name:'OTM call',premium:1.7,delta:.30,gamma:.022,theta:-.13,vega:.12,color:COLORS.amber,qty},
      {name:'ATM put hedge',premium:3.6,delta:-.48,gamma:.026,theta:-.15,vega:.14,color:COLORS.red,qty:hedgeQty}
    ];
    const labels=[];for(let t=0;t<=horizon;t+=5)labels.push(t);if(labels[labels.length-1]!==horizon)labels.push(horizon);
    const calc=(p,t)=>{const move=targetMove*Math.min(1,t/horizon);return Math.max(.01,p.premium+p.delta*move+.5*p.gamma*move*move+p.theta*(t/390)+p.vega*ivPoints)};
    const series=profiles.map(p=>({...p,values:labels.map(t=>calc(p,t))}));
    $('slopeProfiles').innerHTML=profiles.map((p,i)=>{const end=series[i].values.at(-1),pl=(end-p.premium)*100*p.qty;return `<div class="profile ${pl>=0?'good':'bad'}"><b>${esc(p.name)}</b><span>${num(p.qty)} contract${p.qty===1?'':'s'} · start ${money(p.premium)}</span><strong>${pl>=0?'+':''}${money(pl,0)}</strong></div>`}).join('');
    const neutralHedge=Math.ceil(qty*Math.abs(profiles[1].delta)/Math.abs(profiles[3].delta)),netDelta=(qty*profiles[1].delta+hedgeQty*profiles[3].delta)*100,combinedPl=(series[1].values.at(-1)-profiles[1].premium)*100*qty+(series[3].values.at(-1)-profiles[3].premium)*100*hedgeQty;
    const movePct=targetMove/spot;
    $('hedgeSummary').textContent=`Scenario: ${targetMove>=0?'+':''}${money(targetMove)} (${signedPct(movePct)}) over ${num(horizon)} minutes with ${ivPoints>=0?'+':''}${num(ivPoints,2)} IV points. Delta-neutral estimate for the synthetic ATM pair: ${neutralHedge} put${neutralHedge===1?'':'s'} per ${qty} call${qty===1?'':'s'}. Your selected hedge leaves ${netDelta>=0?'+':''}${num(netDelta,0)} delta-equivalent shares and a modeled combined P/L of ${combinedPl>=0?'+':''}${money(combinedPl,0)}.`;
    renderLineChart($('slopeChart'),labels,series);
  }

  function flattenForCsv(value, path='', rows=[]) {
    if (Array.isArray(value)) value.forEach((item,i)=>flattenForCsv(item,`${path}[${i}]`,rows));
    else if (value && typeof value==='object') Object.entries(value).forEach(([k,v])=>flattenForCsv(v,path?`${path}.${k}`:k,rows));
    else rows.push([path,value]);
    return rows;
  }
  function exportCurrent() {
    const payload=state.data[state.module];
    if(!payload){alert('Load this module before exporting.');return}
    const rows=[['field','value'],...flattenForCsv(payload)];
    const csv=rows.map(r=>r.map(v=>'"'+String(v??'').replace(/"/g,'""')+'"').join(',')).join('\r\n');
    const blob=new Blob([csv],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`vjm-${state.module}-${new Date().toISOString().slice(0,10)}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }

  function wire() {
    $('unlockButton').addEventListener('click',unlock); $('restoreButton').addEventListener('click',restore); $('premiumCode').addEventListener('keydown',(e)=>{if(e.key==='Enter')unlock()});
    $('signOutButton').addEventListener('click',signOut); $('refreshButton').addEventListener('click',refreshCurrent); $('exportButton').addEventListener('click',exportCurrent);
    document.querySelectorAll('.module-tab').forEach((b)=>b.addEventListener('click',()=>setModule(b.dataset.module)));
    $('loadOptions').addEventListener('click',()=>{delete state.data.options;loadOptions()}); $('loadStock').addEventListener('click',()=>{delete state.data.stocks;loadStock()}); $('loadSectors').addEventListener('click',()=>{delete state.data.sectors;loadSectors()}); $('loadBiotech').addEventListener('click',()=>{delete state.data.biotech;loadBiotech()});
    document.querySelectorAll('.lab-control').forEach((input)=>input.addEventListener('input',renderSlopeLab));
    renderSlopeLab(); loadHealth();
    // Quietly auto-restore when a valid session cookie exists.
    restore(true);
  }
  document.addEventListener('DOMContentLoaded',wire);
})();
