// POST /api/analyze
// Orchestrates a full investment analysis:
// 1. Fetches live market data (VIX, SPY, F&G)
// 2. Reads open trades + recent history from Notion
// 3. Calls Claude API with full analyst skill + all context
// 4. Returns structured analysis JSON
// 5. Auto-creates Order Drafts for BUY recommendations

const https = require('https');
const Anthropic = require('@anthropic-ai/sdk');
const { computeAll } = require('./_lib/indicators');
let computeSourceWeights;
try { computeSourceWeights = require('./_lib/signal-weights').computeSourceWeights; } catch { computeSourceWeights = null; }
let runDiagnostics;
try { runDiagnostics = require('./_lib/diagnostics').runDiagnostics; } catch { runDiagnostics = null; }

const TRADE_DB = '661bed1034ae4030be88d3ee7d125d42';
const WALLET_DB = 'f0e0d34f98334542a24081bfe6c80110';
const TUNING_DB = 'c326714ad2b748878e94c473760c97e3';

// ── helpers ──────────────────────────────────────────────────────────────
function httpsGet(url, headers={}, maxRedirects=3) {
  return new Promise((resolve,reject) => {
    const doReq = (reqUrl, left) => {
      https.get(reqUrl,{headers:{'User-Agent':'Mozilla/5.0',...headers},timeout:5000},res=>{
        if ([301,302,307,308].includes(res.statusCode) && res.headers.location && left > 0) {
          const loc = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, reqUrl).href;
          res.resume();
          return doReq(loc, left - 1);
        }
        let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve({status:res.statusCode,body:d}));
      }).on('error',reject).on('timeout',function(){this.destroy();reject(new Error('timeout'));});
    };
    doReq(url, maxRedirects);
  });
}

// ── Finviz Screener: find underrated/unusual volume stocks ─────────────
async function fetchFinvizSignals() {
  const screens = {
    oversoldValue: 'v=111&f=cap_midover,fa_pe_u15,sh_relvol_o1.5,ta_rsi_os40&ft=4&o=-relativevolume',
    insiderBuying: 'v=111&f=cap_midover,it_latestbuys&ft=4&o=-change',
    unusualVolume: 'v=111&f=cap_midover,sh_relvol_o3,ta_change_u&ft=4&o=-relativevolume',
    oversoldBounce: 'v=111&f=cap_midover,ta_rsi_os30,ta_change_u1&ft=4&o=rsi',
  };
  const results = {};
  const errors = [];
  await Promise.all(Object.entries(screens).map(async ([name, params]) => {
    try {
      const r = await httpsGet(`https://finviz.com/screener.ashx?${params}`, {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html',
      });
      if (r.status !== 200) {
        errors.push(`${name}: HTTP ${r.status}`);
        results[name] = [];
        return;
      }
      const tickerMatches = r.body.match(/screener-link-primary"[^>]*>([A-Z]{1,5})<\/a>/g) || [];
      results[name] = tickerMatches.slice(0, 8).map(m => {
        const t = m.match(/>([A-Z]{1,5})</);
        return t ? t[1] : null;
      }).filter(Boolean);
    } catch (e) { errors.push(`${name}: ${e.message||'unknown'}`); results[name] = []; }
  }));
  results._errors = errors.length > 0 ? errors : null;
  return results;
}

// ── Quiver Quantitative: congressional trades, gov contracts, lobbying, insider ──
async function fetchQuiverData() {
  const results = { congressTrades: [], govContracts: [], lobbying: [], insiderTrades: [], _errors: [] };

  const parseTableRows = (html, maxRows) => {
    const rows = [];
    const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let m, count = 0;
    while ((m = rowPattern.exec(html)) !== null && count < maxRows) {
      const cells = [];
      const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let c;
      while ((c = cellPattern.exec(m[1])) !== null) {
        cells.push(c[1].replace(/<[^>]+>/g, '').trim());
      }
      if (cells.length >= 3) { rows.push(cells); count++; }
    }
    return rows;
  };

  const parseInlineJS = (html) => {
    // Quiver often stores data in inline script vars
    const scriptMatch = html.match(/var\s+data\s*=\s*(\[[\s\S]*?\]);/);
    if (!scriptMatch) return null;
    try { return JSON.parse(scriptMatch[1]); } catch { return null; }
  };

  const findTicker = (cells) => cells.find(c => /^[A-Z]{1,5}$/.test(c));
  const findDate = (cells) => cells.find(c => /\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}/.test(c)) || '?';
  const findAmount = (cells) => cells.find(c => /\$/.test(c)) || '?';
  const findLongText = (cells, exclude) => cells.find(c => c.length > 5 && !/^[A-Z]{1,5}$/.test(c) && !/\$/.test(c) && (!exclude || !exclude.test(c))) || '?';

  const pages = [
    {
      key: 'congressTrades', url: 'https://www.quiverquant.com/congresstrading/',
      parseRows: (rows) => rows.map(cells => {
        const ticker = findTicker(cells);
        if (!ticker) return null;
        return { ticker, politician: cells[0] !== ticker ? cells[0] : cells[1] || '?',
          type: cells.find(c => /buy|sell|purchase|sale/i.test(c)) || '?',
          amount: findAmount(cells), date: findDate(cells) };
      }).filter(Boolean).slice(0, 25),
      parseJS: (data) => data.slice(0, 20).map(d => {
        const tk = (d.Ticker || d.ticker || '').toUpperCase();
        return tk ? { ticker: tk, politician: d.Representative || d.politician || '?',
          type: d.Transaction || d.type || '?', amount: d.Amount || d.amount || '?',
          date: d.Date || d.date || '?' } : null;
      }).filter(Boolean),
    },
    {
      key: 'govContracts', url: 'https://www.quiverquant.com/government-spending/',
      parseRows: (rows) => rows.map(cells => {
        const ticker = findTicker(cells);
        if (!ticker) return null;
        return { ticker, agency: findLongText(cells), amount: findAmount(cells),
          date: findDate(cells), description: cells.find(c => c.length > 20) || '' };
      }).filter(Boolean).slice(0, 15),
      parseJS: (data) => data.slice(0, 15).map(d => {
        const tk = (d.Ticker || d.ticker || '').toUpperCase();
        return tk ? { ticker: tk, agency: d.Agency || d.agency || '?',
          amount: d.Amount || d.amount || '?', date: d.Date || d.date || '?',
          description: d.Description || '' } : null;
      }).filter(Boolean),
    },
    {
      key: 'lobbying', url: 'https://www.quiverquant.com/lobbying/',
      parseRows: (rows) => rows.map(cells => {
        const ticker = findTicker(cells);
        if (!ticker) return null;
        return { ticker, issue: findLongText(cells), amount: findAmount(cells), date: findDate(cells) };
      }).filter(Boolean).slice(0, 15),
      parseJS: (data) => data.slice(0, 15).map(d => {
        const tk = (d.Ticker || d.ticker || '').toUpperCase();
        return tk ? { ticker: tk, issue: d.Issue || d.issue || '?',
          amount: d.Amount || d.amount || '?', date: d.Date || d.date || '?' } : null;
      }).filter(Boolean),
    },
    {
      key: 'insiderTrades', url: 'https://www.quiverquant.com/insidertrading/',
      parseRows: (rows) => rows.map(cells => {
        const ticker = findTicker(cells);
        if (!ticker) return null;
        return { ticker, insider: findLongText(cells, /buy|sell/i),
          type: cells.find(c => /buy|sell|purchase|sale|acquisition|disposition/i.test(c)) || '?',
          shares: cells.find(c => /^\d[\d,]*$/.test(c)) || '?',
          value: findAmount(cells), date: findDate(cells) };
      }).filter(Boolean).slice(0, 20),
      parseJS: (data) => data.slice(0, 20).map(d => {
        const tk = (d.Ticker || d.ticker || '').toUpperCase();
        return tk ? { ticker: tk, insider: d.Insider || d.insider || d.Name || '?',
          type: d.Transaction || d.type || '?', shares: String(d.Shares || d.shares || '?'),
          value: d.Value || d.value || '?', date: d.Date || d.date || '?' } : null;
      }).filter(Boolean),
    },
  ];

  await Promise.all(pages.map(async ({ key, url, parseRows, parseJS }) => {
    try {
      const r = await httpsGet(url, {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html',
      });
      if (r.status !== 200) { results._errors.push(`${key}: HTTP ${r.status}`); return; }
      // Try table parsing first, then inline JS fallback
      const tableData = parseRows(parseTableRows(r.body, 30));
      if (tableData.length > 0) { results[key] = tableData; return; }
      const jsData = parseInlineJS(r.body);
      if (jsData) { results[key] = parseJS(jsData); return; }
      // Got HTML but nothing parsed
      if (r.body.length > 500) {
        results._errors.push(`${key}: HTML received but 0 records parsed — page structure may have changed`);
      }
    } catch (e) { results._errors.push(`${key}: ${e.message || 'fetch failed'}`); }
  }));

  results._errors = results._errors.length > 0 ? results._errors : null;
  return results;
}

// ── Capitol Trades: live congressional stock trading data ──────────────
async function fetchCapitolTrades() {
  try {
    const r = await httpsGet('https://www.capitoltrades.com/trades', {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'text/html',
    });
    if (r.status !== 200) return { trades: [], _error: `HTTP ${r.status}` };

    const trades = [];
    const rowPattern = /<tr[^>]*class="[^"]*q-tr[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
    let match;
    while ((match = rowPattern.exec(r.body)) !== null && trades.length < 20) {
      const row = match[1];
      const ticker = row.match(/issuer-ticker[^>]*>\s*([A-Z]{1,5})\s*</) ||
                     row.match(/\/issuers\/[^"]*"[^>]*>([A-Z]{1,5})</);
      const politician = row.match(/politician-name[^>]*>\s*([^<]+)</) ||
                         row.match(/q-fieldset[^>]*politician[^>]*>[\s\S]*?<a[^>]*>([^<]+)</);
      const tradeType = row.match(/(buy|sell|exchange)/i);
      const amount = row.match(/\$[\d,]+\s*[-–]\s*\$[\d,]+/) || row.match(/\$[\d,]+/);
      const dateMatch = row.match(/(\d{4}-\d{2}-\d{2})/) || row.match(/(\w+ \d+,?\s*\d{4})/);

      if (ticker) {
        trades.push({
          ticker: ticker[1].trim(),
          politician: politician ? politician[1].trim() : 'Unknown',
          type: tradeType ? tradeType[1].toUpperCase() : '?',
          amount: amount ? amount[0] : '?',
          date: dateMatch ? dateMatch[1] : '?',
        });
      }
    }

    // Fallback: if structured parsing fails, try extracting any ticker-like links
    if (trades.length === 0) {
      const simpleTickerPattern = /\/issuers\/[^"]*"[^>]*>.*?<[^>]*>([A-Z]{1,5})<\/(?:span|a)>/g;
      let m;
      while ((m = simpleTickerPattern.exec(r.body)) !== null && trades.length < 15) {
        trades.push({ ticker: m[1], politician: '?', type: '?', amount: '?', date: '?' });
      }
    }

    // Deduplicate by ticker
    const seen = new Set();
    const deduped = trades.filter(t => {
      if (seen.has(t.ticker)) return false;
      seen.add(t.ticker);
      return true;
    }).slice(0, 15);

    // Parsing worked but 0 results = possible HTML structure change
    const _error = (r.body.length > 1000 && deduped.length === 0)
      ? 'HTML received but 0 trades parsed — page structure may have changed'
      : null;

    return { trades: deduped, _error };
  } catch (e) { return { trades: [], _error: e.message || 'Network error' }; }
}

// ── World Monitor: live geopolitical + macro intelligence ───────────────
async function fetchWorldMonitor() {
  const WM = 'https://api.worldmonitor.app';
  const results = { macroSignals: null, fearGreed: null, geopolitical: null, newsHeadlines: null, earningsCalendar: null, economicCalendar: null, _errors: [] };
  try {
    // Build date range for calendars: today → +14 days
    const now = new Date();
    const fromDate = now.toISOString().split('T')[0];
    const toDate = new Date(now.getTime() + 14 * 86400000).toISOString().split('T')[0];

    // Fetch all 6 endpoints in parallel — free, no auth needed
    const [macroR, fgR, simR, newsR, earningsR, econR] = await Promise.all([
      httpsGet(`${WM}/api/economic/v1/get-macro-signals`),
      httpsGet(`${WM}/api/market/v1/get-fear-greed-index`),
      httpsGet(`${WM}/api/forecast/v1/get-simulation-outcome`),
      httpsGet(`${WM}/api/news/v1/list-feed-digest?variant=full&lang=en`),
      httpsGet(`${WM}/api/market/v1/list-earnings-calendar?fromDate=${fromDate}&toDate=${toDate}`),
      httpsGet(`${WM}/api/economic/v1/get-economic-calendar?fromDate=${fromDate}&toDate=${toDate}`),
    ]);

    // 1. Macro Signals — verdict, bullish count, signal statuses
    try {
      if (macroR.status !== 200) throw new Error(`HTTP ${macroR.status}`);
      const macro = JSON.parse(macroR.body);
      const signals = {};
      for (const [k, v] of Object.entries(macro.signals || {})) {
        const { sparkline, history, ...rest } = v;
        signals[k] = rest;
      }
      results.macroSignals = {
        timestamp: macro.timestamp,
        verdict: macro.verdict,
        bullishCount: macro.bullishCount,
        totalCount: macro.totalCount,
        signals,
      };
    } catch (e) { results._errors.push(`Macro Signals: ${e.message}`); }

    // 2. Fear & Greed Composite — score + component breakdown
    try {
      if (fgR.status !== 200) throw new Error(`HTTP ${fgR.status}`);
      const fg = JSON.parse(fgR.body);
      const components = {};
      for (const key of ['sentiment','volatility','positioning','breadth','momentum','safe_haven','options']) {
        if (fg[key]) {
          components[key] = { score: fg[key].score, weight: fg[key].weight, contribution: fg[key].contribution };
          try { components[key].inputs = JSON.parse(fg[key].inputsJson); } catch {}
        }
      }
      results.fearGreed = {
        compositeScore: fg.compositeScore,
        compositeLabel: fg.compositeLabel,
        seededAt: fg.seededAt,
        components,
      };
    } catch (e) { results._errors.push(`Fear & Greed: ${e.message}`); }

    // 3. Geopolitical Forecast — active threat theaters
    try {
      if (simR.status !== 200) throw new Error(`HTTP ${simR.status}`);
      const sim = JSON.parse(simR.body);
      const theaters = JSON.parse(sim.theaterSummariesJson || '[]');
      results.geopolitical = {
        generatedAt: sim.generatedAt ? new Date(sim.generatedAt).toISOString() : null,
        theaterCount: sim.theaterCount,
        theaters: theaters.map(t => ({ id: t.theaterId, label: t.theaterLabel })),
      };
    } catch (e) { results._errors.push(`Geopolitical: ${e.message}`); }

    // 4. News Headlines — top 3 from finance + geopolitical categories
    try {
      if (newsR.status !== 200) throw new Error(`HTTP ${newsR.status}`);
      const news = JSON.parse(newsR.body);
      const cats = news.categories || {};
      const headlines = [];
      for (const cat of ['finance', 'us', 'middleeast', 'europe', 'politics']) {
        const items = cats[cat]?.items || [];
        for (const item of items.slice(0, 3)) {
          headlines.push({ category: cat, title: item.title, source: item.source });
        }
      }
      results.newsHeadlines = headlines.slice(0, 8);
    } catch (e) { results._errors.push(`News: ${e.message}`); }

    // 5. Earnings Calendar — next 2 weeks, filtered to relevant tickers
    try {
      if (earningsR.status !== 200) throw new Error(`HTTP ${earningsR.status}`);
      const earn = JSON.parse(earningsR.body);
      const allEarnings = earn.earnings || [];
      results.earningsCalendar = allEarnings
        .filter(e => e.symbol && e.date)
        .map(e => ({ symbol: e.symbol, date: e.date, time: e.time || '', estimate: e.epsEstimate, name: e.name }))
        .slice(0, 20);
    } catch (e) { results._errors.push(`Earnings Calendar: ${e.message}`); }

    // 6. Economic Calendar — upcoming macro events (FOMC, CPI, NFP, etc.)
    try {
      if (econR.status !== 200) throw new Error(`HTTP ${econR.status}`);
      const econ = JSON.parse(econR.body);
      const events = econ.events || [];
      results.economicCalendar = events
        .filter(e => e.event || e.name)
        .map(e => ({ date: e.date, event: e.event || e.name, country: e.country, impact: e.impact, actual: e.actual, forecast: e.forecast, previous: e.previous }))
        .slice(0, 15);
    } catch (e) { results._errors.push(`Economic Calendar: ${e.message}`); }
  } catch (e) { results._errors.push(`World Monitor DOWN: ${e.message}`); } // entire WM is down

  return results;
}

async function fetchMarketData() {
  const _errors = [];
  let vix = null, spyPrice = null, spyAbove = null;
  try {
    const r = await httpsGet(`https://stooq.com/q/d/l/?s=%5EVIX&i=d`);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const lines = r.body.trim().split('\n').slice(1).filter(l=>l.includes(','));
    const last = lines[lines.length-1]?.split(',');
    vix = last ? parseFloat(last[4]||last[1]) : null;
    if (!vix) _errors.push('VIX: parsed but got null value');
  } catch (e) { _errors.push(`VIX: ${e.message}`); }

  try {
    const FINNHUB = process.env.FINNHUB_KEY;
    if (!FINNHUB) { _errors.push('SPY: FINNHUB_KEY not set'); }
    else {
      const sr = await httpsGet(`https://finnhub.io/api/v1/quote?symbol=SPY&token=${FINNHUB}`);
      const q = JSON.parse(sr.body);
      spyPrice = q && q.c && q.c > 0 ? q.c : null;
      if (!spyPrice) _errors.push('SPY: Finnhub returned no price');
      spyAbove = vix ? vix < 22 : null;
    }
  } catch (e) { _errors.push(`SPY: ${e.message}`); }

  return { vix, spyPrice, spyAbove, fg: null, _errors: _errors.length > 0 ? _errors : null };
}

async function fetchOpenTrades(token) {
  return new Promise((resolve,reject)=>{
    const data = JSON.stringify({
      filter:{and:[
        {property:'Status',select:{equals:'Paper'}},
        {property:'Simulation Mode',checkbox:{equals:true}}
      ]},
      page_size:20
    });
    const req = https.request({
      hostname:'api.notion.com',path:`/v1/databases/${TRADE_DB}/query`,method:'POST',
      headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json','Notion-Version':'2022-06-28','Content-Length':Buffer.byteLength(data)}
    },res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{
      try{resolve(JSON.parse(d).results||[]);}catch{resolve([]);}
    });});
    req.on('error',()=>resolve([])); req.write(data); req.end();
  });
}

async function fetchRecentClosed(token) {
  return new Promise((resolve,reject)=>{
    const data = JSON.stringify({
      filter:{property:'Status',select:{equals:'Closed'}},
      sorts:[{timestamp:'created_time',direction:'descending'}],
      page_size:8
    });
    const req = https.request({
      hostname:'api.notion.com',path:`/v1/databases/${TRADE_DB}/query`,method:'POST',
      headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json','Notion-Version':'2022-06-28','Content-Length':Buffer.byteLength(data)}
    },res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{
      try{resolve(JSON.parse(d).results||[]);}catch{resolve([]);}
    });});
    req.on('error',()=>resolve([])); req.write(data); req.end();
  });
}

async function fetchApprovedTunings(token) {
  return new Promise((resolve) => {
    const data = JSON.stringify({
      filter: { property: 'Status', select: { equals: 'Approved' } },
      sorts: [{ property: 'Date Proposed', direction: 'descending' }],
      page_size: 20,
    });
    const req = https.request({
      hostname: 'api.notion.com', path: `/v1/databases/${TUNING_DB}/query`, method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const pages = JSON.parse(d).results || [];
          const tunings = pages.map(p => {
            const props = p.properties;
            return {
              category: props['Category']?.select?.name || '',
              recommendation: props['Recommendation']?.title?.[0]?.plain_text || '',
              paramBefore: props['Parameter Before']?.rich_text?.[0]?.plain_text || '',
              paramAfter: props['Parameter After']?.rich_text?.[0]?.plain_text || '',
              priority: props['Priority']?.select?.name || '',
              dateApplied: props['Date Applied']?.date?.start || '',
            };
          });
          resolve(tunings);
        } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.write(data); req.end();
  });
}

async function fetchWalletState(token) {
  return new Promise((resolve) => {
    const data = JSON.stringify({
      sorts: [{ property: 'Date', direction: 'ascending' }],
      page_size: 200,
    });
    const req = https.request({
      hostname: 'api.notion.com', path: `/v1/databases/${WALLET_DB}/query`, method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const txs = JSON.parse(d).results || [];
          let cash = 0;
          const holdings = {};
          for (const page of txs) {
            const p = page.properties;
            const type = p['Type']?.select?.name || '';
            const amount = p['Amount']?.number || 0;
            const ticker = p['Ticker']?.rich_text?.[0]?.plain_text || '';
            const shares = p['Shares']?.number || 0;
            if (type === 'DEPOSIT' || type === 'DIVIDEND') cash += amount;
            else if (type === 'BUY') {
              cash += amount; // negative
              if (ticker) {
                if (!holdings[ticker]) holdings[ticker] = { shares: 0, totalCost: 0 };
                holdings[ticker].shares += shares;
                holdings[ticker].totalCost += Math.abs(amount);
              }
            } else if (type === 'SELL') {
              cash += amount; // positive
              if (ticker && holdings[ticker]) {
                const ratio = Math.max(0, (holdings[ticker].shares - shares)) / holdings[ticker].shares;
                holdings[ticker].shares -= shares;
                holdings[ticker].totalCost *= ratio;
                if (holdings[ticker].shares <= 0) delete holdings[ticker];
              }
            } else if (type === 'WITHDRAWAL') cash += amount;
          }
          const totalInvested = Object.values(holdings).reduce((s, h) => s + h.totalCost, 0);
          resolve({
            cashBalance: +cash.toFixed(2),
            totalInvested: +totalInvested.toFixed(2),
            totalValue: +(cash + totalInvested).toFixed(2),
            holdings,
            txCount: txs.length,
          });
        } catch { resolve({ cashBalance: 0, totalInvested: 0, totalValue: 0, holdings: {}, txCount: 0 }); }
      });
    });
    req.on('error', () => resolve({ cashBalance: 0, totalInvested: 0, totalValue: 0, holdings: {}, txCount: 0 }));
    req.write(data); req.end();
  });
}

function formatTrade(p) {
  const props = p.properties;
  return {
    notionId: p.id,
    title: props['Trade']?.title?.[0]?.plain_text || '',
    ticker: props['Ticker']?.rich_text?.[0]?.plain_text || '',
    strategy: props['Strategy']?.select?.name || '',
    entry: props['Entry Price']?.number,
    stop: props['Stop-Loss Price']?.number,
    tp1: props['TP1']?.number,
    tp2: props['TP2']?.number,
    score: props['Composite Score']?.number,
    pnl: props['P&L %']?.number,
    dateOpened: props['date:Date Opened:start']?.date?.start || props['Date Opened']?.date?.start || '',
    status: props['Status']?.select?.name || '',
    lesson: props['Lesson Learned']?.rich_text?.[0]?.plain_text || '',
    sim: props['Simulation Mode']?.checkbox,
  };
}

// Update a Notion page with latest attribution + reasoning from analysis
function updatePositionInNotion(pageId, signalAttribution, reasoning, token) {
  const props = {};
  if (signalAttribution && signalAttribution.length) {
    props['Signal Sources'] = { multi_select: signalAttribution.map(s => ({ name: s.source })) };
    props['Signal Attribution'] = { rich_text: [{ text: { content: JSON.stringify(signalAttribution).slice(0, 2000) } }] };
  }
  if (reasoning) {
    props['What Went Right'] = { rich_text: [{ text: { content: reasoning.slice(0, 2000) } }] };
  }
  if (!Object.keys(props).length) return Promise.resolve();
  const body = JSON.stringify({ properties: props });
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.notion.com', path: `/v1/pages/${pageId}`, method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28', 'Content-Length': Buffer.byteLength(body) }
    }, res => { res.resume(); resolve(); });
    req.on('error', () => resolve());
    req.write(body); req.end();
  });
}

// ── Technical Analysis: fetch OHLCV via Finnhub candles ─────────────────
function fetchOHLCV(ticker, apiKey) {
  return new Promise(resolve => {
    const to = Math.floor(Date.now() / 1000);
    const from = to - 120 * 86400; // ~120 days of daily candles
    const url = `https://finnhub.io/api/v1/stock/candle?symbol=${ticker}&resolution=D&from=${from}&to=${to}&token=${apiKey}`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 6000 }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(d);
          if (json.s !== 'ok' || !json.c || !json.c.length) { resolve(null); return; }
          const bars = json.t.map((ts, i) => ({
            date: new Date(ts * 1000).toISOString().split('T')[0],
            open: json.o[i], high: json.h[i], low: json.l[i],
            close: json.c[i], volume: json.v[i],
          }));
          resolve(bars);
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null)).on('timeout', function () { this.destroy(); resolve(null); });
  });
}

async function fetchTechnicalData(tickers, apiKey) {
  const results = {};
  // Batch parallel: 4 at a time (Finnhub allows 60/min)
  const batchSize = 4;
  for (let i = 0; i < tickers.length; i += batchSize) {
    const batch = tickers.slice(i, i + batchSize);
    await Promise.all(batch.map(async (ticker) => {
      const bars = await fetchOHLCV(ticker, apiKey);
      if (bars && bars.length >= 30) {
        results[ticker] = computeAll(bars);
      }
    }));
    if (i + batchSize < tickers.length) await new Promise(r => setTimeout(r, 200));
  }
  return results;
}

function formatTA(ta) {
  if (!ta || ta.error) return 'Insufficient data';
  const lines = [];
  lines.push(`  Price: $${ta.price}`);
  if (ta.rsi2 != null) lines.push(`  RSI(2): ${ta.rsi2}`);
  if (ta.rsi14 != null) lines.push(`  RSI(14): ${ta.rsi14}`);
  if (ta.macd) lines.push(`  MACD: ${ta.macd.macd} | Signal: ${ta.macd.signal} | Histogram: ${ta.macd.histogram} | Crossover: ${ta.macd.crossover}`);
  if (ta.stochastic) lines.push(`  Stochastic: %K=${ta.stochastic.k} %D=${ta.stochastic.d} (${ta.stochastic.signal})`);
  if (ta.williamsR) lines.push(`  Williams %R: ${ta.williamsR.value} (${ta.williamsR.signal})`);
  if (ta.cci) lines.push(`  CCI(20): ${ta.cci.value} (${ta.cci.signal})`);
  if (ta.bollingerBands) lines.push(`  Bollinger: Upper=$${ta.bollingerBands.upper} Mid=$${ta.bollingerBands.middle} Lower=$${ta.bollingerBands.lower} | %B=${ta.bollingerBands.pctB} | BW=${ta.bollingerBands.bandwidth}%`);
  if (ta.atr) lines.push(`  ATR(14): $${ta.atr.atr} (${ta.atr.atrPct}% of price) | 2×ATR Stop: $${ta.atr.stopDistance} | 3×ATR Trail: $${ta.atr.trailingStop}`);
  if (ta.zScore) lines.push(`  Z-Score(20): ${ta.zScore.zScore} (${ta.zScore.interpretation})`);
  if (ta.obv) lines.push(`  OBV Trend: ${ta.obv.trend} | Divergence: ${ta.obv.divergence}`);
  if (ta.volume) lines.push(`  Volume: ${ta.volume.ratio}× avg (${ta.volume.signal})`);
  if (ta.emaAlignment) {
    const e = ta.emaAlignment;
    lines.push(`  EMAs: 9=${e.ema9} 20=${e.ema20} 50=${e.ema50} 200=${e.ema200} | Alignment: ${e.alignment} | Cross: ${e.cross} | vs200: ${e.priceVsEma200Pct}%`);
    lines.push(`  SMAs: 20=${e.sma20} 50=${e.sma50} 200=${e.sma200}`);
  }
  if (ta.fibonacci) {
    const f = ta.fibonacci;
    lines.push(`  Fibonacci (${f.trend}): Swing H=$${f.swingHigh} L=$${f.swingLow}`);
    if (f.nearestSupport) lines.push(`    Nearest Support: $${f.nearestSupport.price} (${f.nearestSupport.fib} retracement)`);
    if (f.nearestResistance) lines.push(`    Nearest Resistance: $${f.nearestResistance.price} (${f.nearestResistance.fib} retracement)`);
  }
  if (ta.onePercentRule) {
    const r = ta.onePercentRule;
    lines.push(`  1% Rule: Max risk $${r.maxRiskDollars} → ${r.maxShares} shares ($${r.positionValue} = ${r.positionPct}% of portfolio)`);
  }
  if (ta._summary?.length) lines.push(`  KEY SIGNALS: ${ta._summary.join(' | ')}`);
  return lines.join('\n');
}

async function createDraft(ticker, strategy, score, reasoning, regime, positionPct, entryPrice, token, alphaKey, signalAttribution) {
  // DEDUP: check Notion for any existing Draft or Paper entry with this ticker
  try {
    const checkData = JSON.stringify({filter:{and:[
      {property:'Ticker',rich_text:{equals:ticker}},
      {property:'Simulation Mode',checkbox:{equals:true}},
      {or:[{property:'Status',select:{equals:'Draft'}},{property:'Status',select:{equals:'Paper'}},{property:'Status',select:{equals:'Open'}}]}
    ]},page_size:1});
    const existing = await new Promise(resolve=>{
      const req=https.request({hostname:'api.notion.com',path:`/v1/databases/${TRADE_DB}/query`,method:'POST',
        headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json','Notion-Version':'2022-06-28','Content-Length':Buffer.byteLength(checkData)}
      },res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{resolve(JSON.parse(d));}catch{resolve({});}});});
      req.on('error',()=>resolve({}));req.write(checkData);req.end();
    });
    if (existing.results && existing.results.length > 0) {
      return { ok: false, skipped: true, reason: `${ticker} already has a Draft/Paper/Open entry`, existingId: existing.results[0].id };
    }
  } catch{}

  // Create the draft
  const stop=+(entryPrice*0.93).toFixed(2),tp1=+(entryPrice*1.08).toFixed(2),
        tp2=+(entryPrice*1.15).toFixed(2),tp3=+(entryPrice*1.22).toFixed(2);
  const today=new Date().toISOString();
  const REGIME_MAP={'MEAN REVERSION ZONE':'Mean Reversion Zone','BREAKOUT ZONE':'Breakout Zone','CAUTION ZONE':'Caution Zone','EXTREME FEAR':'Caution Zone'};
  const regimeName=regime?(REGIME_MAP[regime.toUpperCase()]||regime):null;
  const props={
    'Trade':{title:[{text:{content:`⏳ ${ticker} — ${strategy} [DRAFT]`}}]},
    'Ticker':{rich_text:[{text:{content:ticker}}]},
    'Strategy':{select:{name:strategy}},
    'Status':{select:{name:'Draft'}},
    'Simulation Mode':{checkbox:true},
    'Entry Price':{number:entryPrice},
    'Stop-Loss Price':{number:stop},
    'TP1':{number:tp1},'TP2':{number:tp2},'TP3':{number:tp3},
    'Composite Score':{number:score},
    'What Went Right':{rich_text:[{text:{content:(reasoning||'').slice(0,2000)}}]},
    'Date Opened':{date:{start:today}},
  };
  if(regimeName)props['Market Regime at Entry']={select:{name:regimeName}};
  if(positionPct)props['Position Size %']={number:positionPct};
  // Store signal attribution
  if(signalAttribution&&signalAttribution.length){
    props['Signal Sources']={multi_select:signalAttribution.map(s=>({name:s.source}))};
    props['Signal Attribution']={rich_text:[{text:{content:JSON.stringify(signalAttribution).slice(0,2000)}}]};
  }
  const body=JSON.stringify({parent:{database_id:TRADE_DB},properties:props});
  return new Promise(resolve=>{
    const req=https.request({
      hostname:'api.notion.com',path:'/v1/pages',method:'POST',
      headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json','Notion-Version':'2022-06-28','Content-Length':Buffer.byteLength(body)}
    },res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{
      try{const r=JSON.parse(d);resolve({ok:res.statusCode<300,id:r.id,url:r.url,ticker,entryPrice,stop,tp1});}catch{resolve({ok:false});}
    });});
    req.on('error',()=>resolve({ok:false}));req.write(body);req.end();
  });
}

// ── main handler ─────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS') return res.status(200).end();
  try {

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const NOTION_TOKEN  = process.env.NOTION_TOKEN;
  const ALPHA_KEY     = process.env.FINNHUB_KEY;

  if (!ANTHROPIC_KEY) return res.status(503).json({error:'ANTHROPIC_API_KEY not set in Vercel env vars'});

  let body=''; req.on('data',c=>body+=c);
  await new Promise(r=>req.on('end',r));
  const parsed = JSON.parse(body||'{}');
  const phase = parsed.phase || 'all'; // 'data' = fetch only, 'ai' = Claude only, 'all' = legacy single-call
  const command = parsed.command || 'run investment analysis';
  const mode = parsed.mode || 'full'; // 'quick' = Haiku (cheap), 'full' = Sonnet (deep + attribution)
  let minScore = Number(parsed.minScore) || 65; // configurable BUY threshold (default 65)
  const sourceOverrides = parsed.sourceOverrides || null; // {source: multiplier} from UI

  // Detect single-ticker assessment mode
  const tickerMatch = command.match(/^score\s+([A-Z]{1,5})$/i) || command.match(/^assess\s+([A-Z]{1,5})$/i);
  const assessTicker = parsed.ticker?.toUpperCase() || (tickerMatch ? tickerMatch[1].toUpperCase() : null);
  const assessThesis = parsed.thesis || '';
  const isAssessMode = !!assessTicker;

  // Detect discovery mode
  const isDiscoverMode = mode === 'discover' || /discover|find.*underrated|hidden.*gems/i.test(command);
  const discoverFocus = parsed.focus || ''; // e.g. "tech", "energy", "value", "momentum"

  // Detect diagnose mode (performance evaluation + prescription)
  const isDiagnoseMode = mode === 'diagnose' || mode === 'consistency' || /evaluate.*performance|diagnose|run.*diagnostics/i.test(command);
  const isConsistencyMode = mode === 'consistency';
  const consistencyN = isConsistencyMode ? Math.min(Math.max(parseInt(parsed.n) || 3, 2), 7) : 1;

  // ── PHASE: AI — skip all data fetching, use pre-fetched context ───────
  if (phase === 'ai' && parsed.context) {
    const context = parsed.context;
    const modelId = parsed.modelId || 'claude-haiku-4-5-20251001';
    const maxTokens = parsed.maxTokens || 8192;
    const openFormatted = parsed.openFormatted || [];
    const walletState = parsed.walletState || { cashBalance: 0, totalInvested: 0, totalValue: 0, holdings: {}, txCount: 0 };
    const openTickers = parsed.openTickers || [];
    const consistencyNAi = parsed.consistencyN || 1;

    // System prompts
    const quickSP = `You are Daniel's investment position monitor. Return only valid JSON, no markdown. Check each open position against its stop-loss and take-profit levels using the COMPUTED technical indicators provided. Be concise.`;
    const fullSP = `You are Daniel's investment analyst. Return only valid JSON, no markdown. Use COMPUTED technical indicators (RSI, MACD, Bollinger, ATR, OBV, Z-Score, Stochastic, Fibonacci, EMA) from real OHLCV data — never estimate when data is provided. Use LIVE World Monitor data (macro verdict, F&G composite, geopolitical theaters). Scoring bonuses: Z-Score<-2 +3pts, Z-Score>+2 -3pts, OBV divergence ±3pts, Stoch cross ±2pts, Fib support +2pts, Bollinger %B<0.05 +2pts. Cap positions at 5%. Prefer 2×ATR stops over fixed 7%.`;
    const positionsSP = `You are Daniel's position monitor. Return only valid JSON, no markdown. For each open position, evaluate: distance to stop-loss, distance to TP1/TP2, days held (time stop at 10 days), and whether the regime has changed unfavorably. Use COMPUTED technical indicators. Be concise — 1-2 sentence reasoning per position.`;
    const opportunitiesSP = `You are Daniel's opportunity scanner. Return only valid JSON, no markdown. Use COMPUTED technical indicators, LIVE World Monitor data, and Finviz screener signals to find NEW BUY candidates. Apply the full composite scoring framework rigorously. Scoring bonuses: Z-Score<-2 +3pts, Z-Score>+2 -3pts, OBV divergence ±3pts, Stoch cross ±2pts, Fib support +2pts, Bollinger %B<0.05 +2pts. Cap positions at 5%. Prefer 2×ATR stops over fixed 7%. Be selective — only recommend where multiple signals converge.`;
    const assessSP = `You are Daniel's personal investment analyst performing a DEEP single-ticker assessment. Return only valid JSON, no markdown. Use COMPUTED technical indicators and LIVE World Monitor intelligence. Scoring: Technical(0-40), Fundamental(0-30), Macro(0-20), Timing(0-10). Score<40=AVOID, >75=strong conviction.`;
    const discoverSP = `You are Daniel's investment discovery agent. Find underrated stocks using real screener data, technical indicators, and macro intelligence. Return only valid JSON, no markdown. Be selective — only recommend where multiple signals converge.`;
    const diagnoseSP = `You are an ADVERSARIAL performance reviewer for an algorithmic trading system. Return only valid JSON, no markdown. Find weaknesses, miscalibrations, and missed opportunities. Be brutally honest.`;

    const splitRole = parsed.splitRole; // 'positions' or 'opportunities' or undefined
    const resolvedMode = parsed.mode || mode;
    let sysPrompt;
    if (splitRole === 'positions') sysPrompt = positionsSP;
    else if (splitRole === 'opportunities') sysPrompt = opportunitiesSP;
    else sysPrompt = resolvedMode === 'diagnose' ? diagnoseSP : resolvedMode === 'discover' ? discoverSP : resolvedMode === 'assess' ? assessSP : (resolvedMode === 'quick' ? quickSP : fullSP);

    // For split roles, append focused JSON schema instructions to the context
    let finalContext = context;
    if (splitRole === 'positions') {
      finalContext += `\n\nYou are ONLY checking existing positions. Do NOT find new opportunities.
Respond with JSON: {"regime":{"name":"...","headline":"...","why":"...","action":"...","vix":number,"fg":number_or_null,"spyAbove":boolean},
"positions":[{"ticker":"XXXX","recommendation":"HOLD|TAKE_PROFIT|EXIT_NOW|TIGHTEN_STOP","currentPrice":null,"pnlPct":null,"reasoning":"1-2 sentences","urgency":"urgent|watch|ok",
"signalAttribution":[{"source":"...","weight":number,"signal":"brief","verdict":"BULLISH|BEARISH|NEUTRAL"}]}],
"stance":"Aggressive|Moderate|Defensive","nextCheckIn":"..."}
RULES: Every position needs a DECISIVE recommendation — you are the expert, not an advisor. Cite specific indicator values.
URGENCY DECISION MATRIX (non-negotiable):
- Earnings ≤1 trading day + P&L < +3% → EXIT_NOW (binary risk not justified without cushion)
- Earnings ≤1 trading day + P&L ≥ +3% → TIGHTEN_STOP to breakeven (protect gains through event)
- Earnings 2-5 days + P&L negative → EXIT_NOW (cut loss before binary event)
- Earnings 2-5 days + P&L +0-5% → TIGHTEN_STOP to breakeven, urgency "urgent"
- Earnings 2-5 days + P&L > +5% → HOLD with tightened stop, urgency "watch"
- Price within 2% of stop-loss → EXIT_NOW (stop about to trigger, don't wait)
- Price within 2% of TP1 → TAKE_PROFIT (close enough, don't get greedy)
- Time in trade >10 days + P&L < +3% → EXIT_NOW (time stop)
Flag urgency: "urgent" for any action needed within 24h, "watch" for 2-5 days, "ok" otherwise.`;
    } else if (splitRole === 'opportunities') {
      finalContext += `\n\nYou are ONLY finding NEW buy opportunities. Positions are handled separately.
Already held (do NOT recommend): ${openTickers.join(', ') || 'none'}
Respond with JSON: {"regime":{"name":"...","headline":"...","why":"...","action":"...","vix":number,"fg":number_or_null,"spyAbove":boolean},
"opportunities":[{"ticker":"XXXX","score":number,"action":"BUY|WATCHLIST","strategy":"Mean Reversion|Breakout Momentum|Earnings Catalyst","reasoning":"2-3 sentences","stop":number,"tp1":number,"tp2":number,"positionPct":number,"positionDollars":number,"shares":number,"waitingFor":"only if WATCHLIST",
"signalAttribution":[{"source":"...","weight":number,"signal":"brief","verdict":"BULLISH|BEARISH|NEUTRAL"}]}],
"insights":"1 key observation","stance":"Aggressive|Moderate|Defensive","recommendedCash":"XX%"}
RULES: BUY needs score≥${minScore}, WATCHLIST ${Math.max(0,minScore-15)}-${minScore-1}. Max 5 opportunities. Every BUY needs stop, tp1, tp2, positionDollars (max $${walletState.cashBalance.toFixed(2)}). Never recommend tickers already held.`;
    }

    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    async function aiCall(runNum) {
      try {
        const message = await client.messages.create({ model: modelId, max_tokens: maxTokens, system: sysPrompt, messages: [{ role: 'user', content: finalContext }] });
        const rawText = message.content[0].text;
        const stopReason = message.stop_reason; // 'end_turn' or 'max_tokens'
        const tokensUsed = message.usage?.output_tokens || 0;
        const clean = rawText.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
        try { return { parsed: JSON.parse(clean), raw: rawText, run: runNum, stopReason, tokensUsed }; }
        catch(pe) {
          // Try to repair truncated JSON (close open strings, brackets, braces)
          let repaired = clean;
          // Close any unterminated string
          const quoteCount = (repaired.match(/(?<!\\)"/g) || []).length;
          if (quoteCount % 2 !== 0) repaired += '"';
          // Close open brackets/braces
          const opens = (repaired.match(/[\[{]/g) || []).length;
          const closes = (repaired.match(/[\]}]/g) || []).length;
          for (let i = 0; i < opens - closes; i++) {
            const lastOpen = Math.max(repaired.lastIndexOf('['), repaired.lastIndexOf('{'));
            const lastOpenChar = repaired[lastOpen];
            repaired += lastOpenChar === '[' ? ']' : '}';
          }
          // Remove trailing comma before closing
          repaired = repaired.replace(/,\s*([}\]])/g, '$1');
          try { return { parsed: JSON.parse(repaired), raw: rawText, run: runNum, stopReason, tokensUsed, repaired: true }; }
          catch(pe2) { return { parsed: null, raw: rawText, run: runNum, parseError: pe.message, stopReason, tokensUsed }; }
        }
      } catch(e) { return { parsed: null, raw: null, run: runNum, error: e.message }; }
    }
    const allRuns = await Promise.all(Array.from({ length: consistencyNAi }, (_, i) => aiCall(i + 1)));
    const successfulRuns = allRuns.filter(r => r.parsed);
    if (successfulRuns.length === 0) {
      // Log detailed error for debugging
      const errorDetail = allRuns.map(r => ({
        run: r.run,
        error: r.error || r.parseError,
        stopReason: r.stopReason,
        tokensUsed: r.tokensUsed,
        rawTail: r.raw ? r.raw.slice(-500) : null,
        rawLength: r.raw ? r.raw.length : 0,
      }));
      return res.status(500).json({
        error: 'Claude call failed',
        runs: allRuns.map(r => r.error || r.parseError),
        _errorDetail: errorDetail,
        _debug: { model: modelId, maxTokens, mode: resolvedMode, contextLength: context.length, sysPromptLength: sysPrompt.length }
      });
    }
    let analysis = successfulRuns[0].parsed;
    analysis._phase = 'ai';
    analysis._mode = resolvedMode;
    analysis._model = modelId;
    analysis._assessTicker = parsed.assessTicker || null;
    analysis._worldMonitor = parsed._worldMonitor || {};
    analysis.wallet = walletState;

    // Deduplicate opportunities — keep highest-scored entry per ticker
    if (analysis.opportunities && analysis.opportunities.length > 1) {
      const seen = {};
      analysis.opportunities = analysis.opportunities.filter(opp => {
        const key = (opp.ticker || '').toUpperCase();
        if (!key) return true;
        if (!seen[key] || (opp.score || 0) > (seen[key].score || 0)) {
          seen[key] = opp;
          return true;
        }
        return false;
      });
      // Keep only the best per ticker
      const best = {};
      for (const opp of analysis.opportunities) {
        const key = (opp.ticker || '').toUpperCase();
        if (!best[key] || (opp.score || 0) > (best[key].score || 0)) best[key] = opp;
      }
      analysis.opportunities = Object.values(best);
    }

    // Auto-create drafts for BUY opportunities (skip for positions-only split)
    if (splitRole === 'positions') {
      analysis.draftsCreated = [];
      analysis.draftsSkipped = [];
      analysis.priceAlerts = [];
      analysis._splitRole = 'positions';
      return res.json(analysis);
    }
    analysis._splitRole = splitRole || 'full';
    const openTickerSet = new Set(openTickers.map(t => t.toUpperCase()));
    // Fetch existing drafts to prevent duplicates across runs
    let existingDraftTickers = new Set();
    if (NOTION_TOKEN) {
      try {
        const draftData = JSON.stringify({filter:{and:[{property:'Status',select:{equals:'Draft'}},{property:'Simulation Mode',checkbox:{equals:true}}]},page_size:20});
        const draftResult = await new Promise(resolve=>{
          const req=https.request({hostname:'api.notion.com',path:`/v1/databases/${TRADE_DB}/query`,method:'POST',
            headers:{'Authorization':'Bearer '+NOTION_TOKEN,'Content-Type':'application/json','Notion-Version':'2022-06-28','Content-Length':Buffer.byteLength(draftData)}
          },res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{resolve(JSON.parse(d));}catch{resolve({});}});});
          req.on('error',()=>resolve({}));req.write(draftData);req.end();
        });
        for (const p of (draftResult.results||[])) {
          const t = p.properties?.['Ticker']?.rich_text?.[0]?.plain_text;
          if (t) existingDraftTickers.add(t.toUpperCase());
        }
      } catch{}
    }
    const draftedThisRun = new Set();
    const draftsCreated = [];
    const draftsSkipped = [];
    if (NOTION_TOKEN && ALPHA_KEY && analysis.opportunities) {
      for (const opp of analysis.opportunities) {
        if (opp.action === 'BUY' && opp.score >= minScore && opp.ticker) {
          const tickerKey = opp.ticker.toUpperCase();
          if (openTickerSet.has(tickerKey)) { draftsSkipped.push({ ticker: opp.ticker, reason: 'Already held' }); continue; }
          if (existingDraftTickers.has(tickerKey)) { draftsSkipped.push({ ticker: opp.ticker, reason: 'Draft already exists' }); continue; }
          if (draftedThisRun.has(tickerKey)) { draftsSkipped.push({ ticker: opp.ticker, reason: 'Duplicate in this run' }); continue; }
          let price = null;
          try { const pr = await httpsGet(`https://finnhub.io/api/v1/quote?symbol=${opp.ticker}&token=${ALPHA_KEY}`); const q = JSON.parse(pr.body); price = q && q.c && q.c > 0 ? q.c : null; } catch{}
          if (!price) { opp._priceAlert = `Price unavailable for ${opp.ticker}`; continue; }
          if ((opp.positionDollars || price) > walletState.cashBalance) { draftsSkipped.push({ ticker: opp.ticker, reason: 'Insufficient funds' }); continue; }
          const draft = await createDraft(opp.ticker, opp.strategy, opp.score, opp.reasoning, analysis.regime?.name, opp.positionPct, price, NOTION_TOKEN, ALPHA_KEY, opp.signalAttribution);
          if (draft.ok) { draftsCreated.push(draft); draftedThisRun.add(tickerKey); }
          else if (draft.skipped) { draftsSkipped.push({ ticker: opp.ticker, reason: draft.reason }); }
        }
      }
    }
    analysis.draftsCreated = draftsCreated;
    analysis.draftsSkipped = draftsSkipped;
    analysis.priceAlerts = (analysis.opportunities || []).filter(o => o._priceAlert).map(o => ({ ticker: o.ticker, alert: o._priceAlert }));
    return res.json(analysis);
  }

  // Fetch context — quick mode skips closed trades and limits TA
  const isQuick = mode === 'quick' && !isAssessMode;
  const [market, openTrades, closedTrades, worldMonitor, walletState, finvizSignals, capitolTradesRaw, approvedTunings, quiverData] = await Promise.all([
    fetchMarketData(),
    NOTION_TOKEN ? fetchOpenTrades(NOTION_TOKEN) : Promise.resolve([]),
    (!isQuick && NOTION_TOKEN) ? fetchRecentClosed(NOTION_TOKEN) : Promise.resolve([]),
    fetchWorldMonitor(),
    NOTION_TOKEN ? fetchWalletState(NOTION_TOKEN) : Promise.resolve({ cashBalance: 0, totalInvested: 0, totalValue: 0, holdings: {}, txCount: 0 }),
    (isDiscoverMode || mode === 'full') ? fetchFinvizSignals() : Promise.resolve(null),
    (!isQuick) ? fetchCapitolTrades() : Promise.resolve({ trades: [], _error: null }),
    (!isQuick && !isDiagnoseMode && NOTION_TOKEN) ? fetchApprovedTunings(NOTION_TOKEN) : Promise.resolve([]),
    (mode === 'full' || isDiscoverMode) ? fetchQuiverData() : Promise.resolve({ congressTrades: [], govContracts: [], lobbying: [], insiderTrades: [], _errors: null }),
  ]);
  // Unwrap Capitol Trades (now returns {trades, _error})
  const capitolTrades = capitolTradesRaw.trades || capitolTradesRaw || [];
  const capitolTradesError = capitolTradesRaw._error || null;

  // ── Collect source errors + persist to Notion Error Log (all phases) ──
  const finvizFetchErrors = finvizSignals?._errors || null;
  const sourceErrors = [];
  if (market._errors) market._errors.forEach(e => sourceErrors.push({ source: 'Market Data', error: e }));
  if (worldMonitor._errors && worldMonitor._errors.length > 0) worldMonitor._errors.forEach(e => sourceErrors.push({ source: 'World Monitor', error: e }));
  if (finvizFetchErrors) finvizFetchErrors.forEach(e => sourceErrors.push({ source: 'Finviz', error: e }));
  if (capitolTradesError) sourceErrors.push({ source: 'Capitol Trades', error: capitolTradesError });
  if (quiverData._errors) quiverData._errors.forEach(e => sourceErrors.push({ source: 'Quiver Quantitative', error: e }));

  // Persist to Notion Error Log — fire-and-forget, never blocks response
  if (sourceErrors.length > 0 && NOTION_TOKEN) {
    const ERROR_LOG_DB = '9e459182b763489bbed331506762bd11';
    const errDate = new Date().toISOString();
    Promise.all(sourceErrors.map(se => {
      const props = {
        'Error':     { title: [{ text: { content: `SOURCE_ERROR: ${se.source} — ${se.error}`.slice(0, 100) } }] },
        'Type':      { select: { name: 'SOURCE_ERROR' } },
        'Source':    { select: { name: 'analyze.js' } },
        'Message':   { rich_text: [{ text: { content: `${se.source}: ${se.error}`.slice(0, 500) } }] },
        'Context':   { rich_text: [{ text: { content: JSON.stringify({ mode, command: command.slice(0, 50), phase }).slice(0, 500) } }] },
        'Resolved':  { checkbox: false },
        'Timestamp': { date: { start: errDate } },
      };
      const body = JSON.stringify({ parent: { database_id: ERROR_LOG_DB }, properties: props });
      return new Promise(resolve => {
        const req = https.request({
          hostname: 'api.notion.com', path: '/v1/pages', method: 'POST',
          headers: { 'Authorization': 'Bearer ' + NOTION_TOKEN, 'Content-Type': 'application/json',
            'Notion-Version': '2022-06-28', 'Content-Length': Buffer.byteLength(body) },
        }, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>resolve()); });
        req.on('error',()=>resolve()); req.write(body); req.end();
      });
    })).catch(() => {});
  }

  // ── Tuning-derived minScore override ──────────────────────────────────
  // If approved tunings contain scoring/regime threshold changes, extract
  // the numeric value and use the highest as the effective hard gate.
  // This closes the feedback loop: evaluate → tune → enforce automatically.
  let tuningMinScore = null;
  if (approvedTunings && approvedTunings.length > 0) {
    for (const t of approvedTunings) {
      if (t.category === 'scoring' || t.category === 'regime') {
        // Extract numeric threshold from paramAfter, e.g. "Draft threshold: score >= 75"
        const match = (t.paramAfter || '').match(/(?:score\s*>=?\s*|threshold:\s*)(\d+)/i);
        if (match) {
          const val = Number(match[1]);
          if (val > 0 && (tuningMinScore === null || val > tuningMinScore)) {
            tuningMinScore = val;
          }
        }
      }
    }
    if (tuningMinScore !== null && tuningMinScore > minScore) {
      minScore = tuningMinScore;
    }
  }

  // For diagnose mode, also fetch ALL closed trades (not just recent 8)
  let allClosedTrades = closedTrades;
  if (isDiagnoseMode && NOTION_TOKEN) {
    try {
      const allClosed = await new Promise((resolve) => {
        const data = JSON.stringify({
          filter: { or: [
            { property: 'Status', select: { equals: 'Closed' } },
            { property: 'Status', select: { equals: 'Stopped Out' } },
          ]},
          sorts: [{ timestamp: 'created_time', direction: 'descending' }],
          page_size: 100
        });
        const req = https.request({
          hostname: 'api.notion.com', path: `/v1/databases/${TRADE_DB}/query`, method: 'POST',
          headers: { 'Authorization': 'Bearer ' + NOTION_TOKEN, 'Content-Type': 'application/json',
            'Notion-Version': '2022-06-28', 'Content-Length': Buffer.byteLength(data) }
        }, res => {
          let d = ''; res.on('data', c => d += c);
          res.on('end', () => { try { resolve(JSON.parse(d).results || []); } catch { resolve([]); } });
        });
        req.on('error', () => resolve([]));
        req.write(data); req.end();
      });
      allClosedTrades = allClosed;
    } catch {}
  }

  const openFormatted = openTrades.map(formatTrade).filter(t => {
    // Skip removed/duplicate entries that might still have Paper status
    const title = (t.title || '').toLowerCase();
    return !title.includes('removed') && !title.includes('duplicate') && !title.includes('\ud83d\uddd1') && !title.includes('\u274c');
  });
  const closedFormatted = closedTrades.map(formatTrade);
  const today = new Date().toDateString();

  // Fetch technical analysis — quick mode only fetches SPY + open positions + assess target
  const openTickers = openFormatted.map(t => t.ticker).filter(Boolean);
  const taTickers = ['SPY', ...openTickers];
  if (assessTicker && !taTickers.includes(assessTicker)) taTickers.push(assessTicker);
  // In discover mode, fetch TA for top screener candidates (Finviz + Quiver)
  if (finvizSignals) {
    const allScreenerTickers = [...new Set(Object.entries(finvizSignals).filter(([k])=>k!=='_errors').flatMap(([,v])=>v||[]))];
    for (const t of allScreenerTickers.slice(0, 4)) { // limit to 4 to stay within 60s timeout
      if (!taTickers.includes(t)) taTickers.push(t);
    }
  }
  // Add Quiver multi-signal tickers (appear in 2+ Quiver datasets) to TA fetch list
  if (quiverData && (mode === 'full' || isDiscoverMode)) {
    const qTickers = {};
    [...quiverData.congressTrades, ...quiverData.insiderTrades, ...quiverData.govContracts, ...quiverData.lobbying]
      .forEach(t => { if (t.ticker) qTickers[t.ticker] = (qTickers[t.ticker]||0)+1; });
    const multiSignalQ = Object.entries(qTickers).filter(([,c]) => c >= 2).sort((a,b) => b[1]-a[1]).slice(0, 3);
    for (const [t] of multiSignalQ) {
      if (!taTickers.includes(t)) taTickers.push(t);
    }
  }
  let taData = {};
  if (ALPHA_KEY) {
    try { taData = await fetchTechnicalData(taTickers, ALPHA_KEY); } catch {}
  }

  // Build TA context block
  let taContext = '';
  if (Object.keys(taData).length > 0) {
    taContext = '\n\nCOMPUTED TECHNICAL INDICATORS (from real OHLCV data — use these, do NOT estimate):\n';
    for (const [ticker, ta] of Object.entries(taData)) {
      taContext += `\n${ticker}:\n${formatTA(ta)}\n`;
    }
  }

  // Build World Monitor context block
  const wm = worldMonitor;
  let wmContext = '';
  if (wm.macroSignals || wm.fearGreed || wm.geopolitical || wm.newsHeadlines) {
    wmContext = '\n\n🌍 WORLD MONITOR — LIVE INTELLIGENCE (worldmonitor.app):\n';

    if (wm.macroSignals) {
      const ms = wm.macroSignals;
      wmContext += `\nMACRO SIGNALS (${ms.timestamp}):\n`;
      wmContext += `  Verdict: ${ms.verdict} (${ms.bullishCount}/${ms.totalCount} bullish)\n`;
      for (const [name, sig] of Object.entries(ms.signals)) {
        const details = Object.entries(sig).filter(([k]) => k !== 'status').map(([k,v]) => `${k}=${typeof v==='number'?v.toFixed?.(2)??v:v}`).join(', ');
        wmContext += `  - ${name}: ${sig.status}${details ? ' ('+details+')' : ''}\n`;
      }
    }

    if (wm.fearGreed) {
      const fg = wm.fearGreed;
      wmContext += `\nFEAR & GREED COMPOSITE: ${fg.compositeScore} — "${fg.compositeLabel}" (${fg.seededAt})\n`;
      for (const [name, comp] of Object.entries(fg.components)) {
        let inputStr = '';
        if (comp.inputs) {
          inputStr = ' | ' + Object.entries(comp.inputs).map(([k,v]) => `${k}=${typeof v==='number'?(v.toFixed?.(2)??v):v}`).slice(0, 4).join(', ');
        }
        wmContext += `  - ${name}: score=${comp.score} weight=${comp.weight} contribution=${comp.contribution}${inputStr}\n`;
      }
    }

    if (wm.geopolitical) {
      const geo = wm.geopolitical;
      wmContext += `\nGEOPOLITICAL THREAT THEATERS (${geo.generatedAt}):\n`;
      if (geo.theaters && geo.theaters.length) {
        for (const t of geo.theaters) {
          wmContext += `  ⚠️ ${t.label}\n`;
        }
      } else {
        wmContext += `  No active threat theaters\n`;
      }
    }

    if (wm.newsHeadlines && wm.newsHeadlines.length) {
      wmContext += `\nLIVE NEWS HEADLINES:\n`;
      for (const h of wm.newsHeadlines) {
        wmContext += `  [${h.category}] ${h.title} (${h.source||''})\n`;
      }
    }

    if (wm.earningsCalendar && wm.earningsCalendar.length) {
      // Filter to show portfolio tickers first, then next notable ones
      const portfolioTickers = new Set(openTickers.map(t => t.toUpperCase()));
      const portfolio = wm.earningsCalendar.filter(e => portfolioTickers.has(e.symbol?.toUpperCase()));
      const others = wm.earningsCalendar.filter(e => !portfolioTickers.has(e.symbol?.toUpperCase())).slice(0, 10);
      const show = [...portfolio, ...others];
      if (show.length) {
        wmContext += `\nUPCOMING EARNINGS (next 2 weeks):\n`;
        for (const e of show) {
          const flag = portfolioTickers.has(e.symbol?.toUpperCase()) ? ' ⚠️ IN PORTFOLIO' : '';
          wmContext += `  ${e.date} ${e.time||''} — ${e.symbol} (${e.name||''}) EPS est: ${e.estimate||'?'}${flag}\n`;
        }
      }
    }

    if (wm.economicCalendar && wm.economicCalendar.length) {
      wmContext += `\nUPCOMING ECONOMIC EVENTS:\n`;
      for (const e of wm.economicCalendar) {
        wmContext += `  ${e.date} — ${e.event} (${e.country||''}) Impact: ${e.impact||'?'} | Forecast: ${e.forecast||'?'} | Prev: ${e.previous||'?'}\n`;
      }
    }
  }

  // Determine Fear & Greed display — prefer World Monitor composite over CNN
  const fgDisplay = wm.fearGreed
    ? `${wm.fearGreed.compositeScore} — "${wm.fearGreed.compositeLabel}" (World Monitor composite, VIX=${wm.fearGreed.components?.volatility?.inputs?.vix || market.vix || '?'})`
    : (market.vix ? `VIX proxy: ${market.vix.toFixed(2)} (CNN F&G blocked)` : 'unavailable');

  // Build source status map (after taData is available)
  const finvizTickers = finvizSignals ? Object.entries(finvizSignals).filter(([k])=>k!=='_errors') : [];
  const finvizHasData = finvizTickers.some(([,v]) => Array.isArray(v) && v.length > 0);
  const _sourceStatus = {
    technicalAnalysis: Object.keys(taData).length > 0 ? 'ok' : 'failed',
    worldMonitor: (wm.macroSignals || wm.fearGreed) ? 'ok' : 'failed',
    finvizScreener: finvizSignals ? (finvizFetchErrors ? 'error' : (finvizHasData ? 'ok' : 'empty')) : 'skipped',
    capitolTrades: capitolTrades.length > 0 ? 'ok' : (capitolTradesError ? 'error' : 'failed'),
    earningsCalendar: wm.earningsCalendar && wm.earningsCalendar.length > 0 ? 'ok' : 'empty',
    fearGreed: wm.fearGreed ? 'ok' : 'failed',
    finnhubPrice: market.spyPrice ? 'ok' : 'failed',
    quiverQuantitative: (mode === 'full' || isDiscoverMode)
      ? ((quiverData.congressTrades.length + quiverData.govContracts.length + quiverData.insiderTrades.length + quiverData.lobbying.length) > 0
        ? (quiverData._errors ? 'partial' : 'ok')
        : (quiverData._errors ? 'error' : 'empty'))
      : 'skipped',
  };

  // Build market header (shared by both modes)
  const marketHeader = `TODAY: ${today}

LIVE MARKET DATA:
- VIX: ${market.vix ? market.vix.toFixed(2) : (wm.fearGreed?.components?.volatility?.inputs?.vix || 'unavailable')}
- Fear & Greed: ${fgDisplay}
- SPY: ${market.spyPrice ? '$'+market.spyPrice.toFixed(2) : 'unavailable'} | Above 50 EMA: ${taData.SPY?.emaAlignment ? (taData.SPY.emaAlignment.above50?'YES':'NO') + ' (computed: price $'+taData.SPY.price+' vs EMA50 $'+taData.SPY.emaAlignment.ema50+')' : market.spyAbove===null?'approx from VIX':market.spyAbove?'YES':'NO'}
${taContext}${wmContext}

${(()=>{
  // Build source health report for Claude — tells it which sources to mark NO_DATA vs NEUTRAL
  const failed = [];
  if (!market.vix) failed.push('VIX' + (market._errors ? ` (${market._errors.find(e=>e.startsWith('VIX'))})` : ''));
  if (!market.spyPrice) failed.push('SPY Price' + (market._errors ? ` (${market._errors.find(e=>e.startsWith('SPY'))})` : ''));
  if (wm._errors && wm._errors.length > 0) wm._errors.forEach(e => failed.push(e));
  if (finvizFetchErrors) finvizFetchErrors.forEach(e => failed.push(`Finviz ${e}`));
  if (capitolTradesError) failed.push(`Capitol Trades: ${capitolTradesError}`);
  if (quiverData._errors) quiverData._errors.forEach(e => failed.push(`Quiver ${e}`));
  if (failed.length === 0) return '';
  return `⚠️ DATA SOURCE FAILURES (${failed.length}):
${failed.map(f => `  ❌ ${f}`).join('\n')}
IMPORTANT: For sources that FAILED above, use verdict NO_DATA with weight 0 in signalAttribution. For sources that loaded successfully but have no specific signal for a ticker, use verdict NEUTRAL with weight 3-8%.
`;
})()}
💰 VIRTUAL WALLET:
- Cash Available: $${walletState.cashBalance.toFixed(2)}
- Total Invested: $${walletState.totalInvested.toFixed(2)}
- Portfolio Value (at cost): $${walletState.totalValue.toFixed(2)}
- Holdings: ${Object.entries(walletState.holdings).map(([t,h])=>`${t}(${h.shares.toFixed(4)}sh@$${(h.totalCost/h.shares).toFixed(2)})`).join(', ') || 'None'}
⚠️ WALLET CONSTRAINT: You may ONLY recommend BUY if the cost fits within available cash ($${walletState.cashBalance.toFixed(2)}). Position sizing must be in DOLLARS and SHARES based on this wallet, not percentages of a hypothetical portfolio. If cash is insufficient, recommend WATCHLIST instead of BUY.

${(()=>{
    if (!computeSourceWeights || !closedFormatted.length) return '';
    try {
      const sw = computeSourceWeights(closedFormatted);
      if (!sw.ranked.length) return '';
      return `📊 SIGNAL SOURCE RELIABILITY (Multiplicative Weights from ${sw.tradesAnalyzed} closed trades):
${sw.ranked.filter(s=>s.totalTrades>0).map(s=>`  ${s.rank}. ${s.source}: ${s.weight}% weight | ${s.winRate}% win rate (${s.wins}W/${s.losses}L) | confidence: ${s.confidence}`).join('\n')}
  Top: ${sw.topSource} | Weakest: ${sw.weakestSource}
⚠️ Give MORE weight to higher-ranked sources in your analysis. Sources with "low" confidence have few data points — don't over-trust them yet.
`;
    } catch { return ''; }
  })()}
${capitolTrades && capitolTrades.length > 0 ? `🏛️ CAPITOL TRADES — LIVE CONGRESSIONAL TRADING (capitoltrades.com):
${capitolTrades.map(t => `  ${t.type} ${t.ticker} — ${t.politician} | ${t.amount} | ${t.date}`).join('\n')}
${(() => {
  // Flag overlap with open positions or screener candidates
  const ctTickers = new Set(capitolTrades.map(t => t.ticker));
  const overlap = openTickers.filter(t => ctTickers.has(t));
  const buys = capitolTrades.filter(t => t.type === 'BUY');
  return (overlap.length ? `⚠️ PORTFOLIO OVERLAP: ${overlap.join(', ')} — congress members also trading these\n` : '') +
         (buys.length >= 3 ? `📈 CLUSTER BUY SIGNAL: ${buys.length} congressional purchases detected — historically bullish\n` : '');
})()}` : '🏛️ CAPITOL TRADES: Data unavailable — scraper returned no results\n'}

${(()=>{
  const qd = quiverData;
  const hasData = qd.congressTrades.length + qd.govContracts.length + qd.insiderTrades.length + qd.lobbying.length > 0;
  if (!hasData) return '📊 QUIVER QUANTITATIVE: Data unavailable — scraper returned no results\n';
  let block = '📊 QUIVER QUANTITATIVE — ALTERNATIVE DATA INTELLIGENCE (quiverquant.com):\n';
  if (qd.congressTrades.length > 0) {
    block += `\n  CONGRESSIONAL TRADES (${qd.congressTrades.length}):\n`;
    block += qd.congressTrades.map(t => `    ${t.type} ${t.ticker} — ${t.politician} | ${t.amount} | ${t.date}`).join('\n') + '\n';
    // Cross-reference with Capitol Trades for stronger signal
    const ctTickers = new Set(capitolTrades.map(t => t.ticker));
    const overlap = qd.congressTrades.filter(t => ctTickers.has(t.ticker)).map(t => t.ticker);
    const unique = [...new Set(overlap)];
    if (unique.length > 0) block += `    🔗 CROSS-CONFIRMED with Capitol Trades: ${unique.join(', ')} — higher confidence signal\n`;
  }
  if (qd.insiderTrades.length > 0) {
    block += `\n  INSIDER TRADING (${qd.insiderTrades.length}):\n`;
    block += qd.insiderTrades.map(t => `    ${t.type} ${t.ticker} — ${t.insider} | ${t.shares} shares | ${t.value} | ${t.date}`).join('\n') + '\n';
    // Flag cluster insider buying
    const buyCounts = {};
    qd.insiderTrades.filter(t => /buy|purchase|acquisition/i.test(t.type)).forEach(t => { buyCounts[t.ticker] = (buyCounts[t.ticker]||0)+1; });
    const clusters = Object.entries(buyCounts).filter(([,c]) => c >= 2).map(([t,c]) => `${t}(${c}×)`);
    if (clusters.length > 0) block += `    🔥 INSIDER CLUSTER BUYS: ${clusters.join(', ')} — multiple insiders buying = strong signal\n`;
  }
  if (qd.govContracts.length > 0) {
    block += `\n  GOVERNMENT CONTRACTS (${qd.govContracts.length}):\n`;
    block += qd.govContracts.slice(0, 10).map(t => `    ${t.ticker} — ${t.agency} | ${t.amount} | ${t.date}${t.description ? ' | '+t.description.slice(0,60) : ''}`).join('\n') + '\n';
  }
  if (qd.lobbying.length > 0) {
    block += `\n  LOBBYING ACTIVITY (${qd.lobbying.length}):\n`;
    block += qd.lobbying.slice(0, 10).map(t => `    ${t.ticker} — ${t.issue} | ${t.amount} | ${t.date}`).join('\n') + '\n';
  }
  // Summary: tickers appearing across multiple Quiver datasets
  const allQuiverTickers = {};
  qd.congressTrades.forEach(t => { allQuiverTickers[t.ticker] = (allQuiverTickers[t.ticker]||0)+1; });
  qd.insiderTrades.forEach(t => { allQuiverTickers[t.ticker] = (allQuiverTickers[t.ticker]||0)+1; });
  qd.govContracts.forEach(t => { allQuiverTickers[t.ticker] = (allQuiverTickers[t.ticker]||0)+1; });
  qd.lobbying.forEach(t => { allQuiverTickers[t.ticker] = (allQuiverTickers[t.ticker]||0)+1; });
  const multiSignal = Object.entries(allQuiverTickers).filter(([,c]) => c >= 2).sort((a,b) => b[1]-a[1]).slice(0, 5);
  if (multiSignal.length > 0) {
    block += `\n  🎯 MULTI-SIGNAL TICKERS (appear in 2+ Quiver datasets): ${multiSignal.map(([t,c]) => `${t}(${c})`).join(', ')}\n`;
  }
  return block;
})()}

OPEN PAPER TRADES (${openFormatted.length}):
${openFormatted.length ? openFormatted.map(t=>`- ${t.ticker} | ${t.strategy} | Entry: $${t.entry} | Stop: $${t.stop} | TP1: $${t.tp1} | Score: ${t.score} | Opened: ${t.dateOpened}`).join('\n') : 'None'}
${approvedTunings && approvedTunings.length > 0 ? `
🔧 ACTIVE TUNING OVERRIDES (approved parameter changes — YOU MUST FOLLOW THESE):
${approvedTunings.map((t, i) => `  ${i+1}. [${t.category.toUpperCase()}] ${t.recommendation}
     Before: ${t.paramBefore}
     After: ${t.paramAfter}
     Priority: ${t.priority}`).join('\n')}
⚠️ These tunings override default parameters. Apply them to all relevant analyses.
` : ''}`;

  // ── QUICK MODE: Haiku — regime + position status only ──────────────────
  const quickContext = `${marketHeader}

USER COMMAND: ${command}

Respond with a JSON object (no markdown, pure JSON):
{
  "regime": {
    "name": "MEAN REVERSION ZONE|BREAKOUT ZONE|CAUTION ZONE|EXTREME FEAR",
    "headline": "one-line summary",
    "why": "1-2 sentences on current conditions",
    "action": "recommended action",
    "vix": number, "fg": number_or_null, "spyAbove": true/false
  },
  "positions": [
    {
      "ticker": "XXXX",
      "recommendation": "HOLD|TAKE_PROFIT|EXIT_NOW|TIGHTEN_STOP",
      "currentPrice": number_or_null,
      "pnlPct": number_or_null,
      "reasoning": "1-2 sentences: what to do and why",
      "urgency": "urgent|watch|ok"
    }
  ],
  "opportunities": [],
  "stance": "Aggressive|Moderate|Defensive",
  "nextCheckIn": "time/date"
}

RULES:
- Focus on position status and regime. No new opportunities in quick mode.
- Every position needs a specific recommendation with reasoning.
- Use the COMPUTED TECHNICAL INDICATORS — cite specific values.
- Use WORLD MONITOR data — reference macro verdict, F&G composite, and any active geopolitical threats.
- If any position is near its stop-loss or TP1, flag urgency as "urgent" or "watch".`;

  // ── FULL MODE: Sonnet — deep analysis with attribution ─────────────────
  // Build source weight guidance from overrides (user manual adjustments)
  let sourceOverrideText = '';
  if (sourceOverrides && Object.keys(sourceOverrides).length > 0) {
    const parts = Object.entries(sourceOverrides)
      .filter(([, mult]) => mult !== 1.0)
      .map(([src, mult]) => `${src}: ${mult}× weight`);
    if (parts.length > 0) {
      sourceOverrideText = `\nUSER WEIGHT OVERRIDES (apply these multipliers when assigning signalAttribution weights — e.g. if a source normally gets 15% and has 1.5× override, give it ~22%): ${parts.join(', ')}. After applying multipliers, normalize so weights still sum to 100.`;
    }
  }
  const attributionRulesText = `- Include "signalAttribution" array with ALL 8 sources: "Technical Analysis", "CNN Fear & Greed", "Capitol Trades", "Finviz Screener", "Earnings Calendar", "Sector Momentum", "World Monitor", "Quiver Quantitative". Each: {source, weight(0-100, sum=100), signal(1 sentence), verdict(BULLISH/BEARISH/NEUTRAL/NO_DATA)}.
NOTE: "Quiver Quantitative" covers congressional trades (cross-ref with Capitol Trades), insider trading, government contracts, and lobbying data. If Quiver insider data confirms Capitol Trades signals for a ticker, boost both weights. "Insider Activity" is now merged INTO the "Quiver Quantitative" source — do NOT use a separate "Insider Activity" attribution.
CRITICAL WEIGHT RULES:
- Use NO_DATA (weight 0) ONLY when the data source itself failed to load or is completely unavailable.
- If a source was checked but found no specific signal for this ticker, use verdict NEUTRAL with a small weight (3-8%) and explain what was checked (e.g. "Capitol Trades: No congressional activity for this ticker in recent filings" = NEUTRAL with weight 5, NOT NO_DATA).
- "No signal found" ≠ NO_DATA. Absence of activity IS information. Only a broken/missing data feed = NO_DATA.
- Every source that was successfully fetched MUST get weight > 0, even if the signal is weak or neutral.${sourceOverrideText}`;

  const fullContext = `${marketHeader}

RECENT CLOSED TRADES (last ${closedFormatted.length}):
${closedFormatted.length ? closedFormatted.map(t=>`- ${t.ticker} | ${t.strategy} | P&L: ${t.pnl!=null?(t.pnl>0?'+':'')+t.pnl.toFixed(1)+'%':'open'} | Score was: ${t.score||'?'} | Lesson: ${t.lesson||'none'}`).join('\n') : 'None yet'}
${finvizSignals ? `
📊 FINVIZ SCREENER SIGNALS (live unusual activity — use these to find NEW opportunities):
${Object.entries(finvizSignals).filter(([k])=>k!=='_errors').map(([screen, tickers]) =>
  `  ${screen}: ${Array.isArray(tickers) && tickers.length ? tickers.join(', ') : 'none'}`).join('\n')}
NOTE: Stocks appearing in MULTIPLE screeners are stronger candidates. Cross-reference with TA data above.
` : ''}
USER COMMAND: ${command}

Respond with a JSON object (no markdown, pure JSON):
{
  "regime": {
    "name": "MEAN REVERSION ZONE|BREAKOUT ZONE|CAUTION ZONE|EXTREME FEAR",
    "headline": "one-line summary",
    "why": "2-3 sentences explaining current conditions",
    "action": "specific recommended action",
    "vix": number, "fg": number_or_null, "spyAbove": true/false
  },
  "positions": [
    {"ticker":"XXXX","recommendation":"HOLD|TAKE_PROFIT|EXIT_NOW|TIGHTEN_STOP","currentPrice":number_or_null,"pnlPct":number_or_null,"reasoning":"1-2 sentences","urgency":"urgent|watch|ok",
     "signalAttribution":[{"source":"source_name","weight":number,"signal":"brief","verdict":"BULLISH|BEARISH|NEUTRAL"}]}
  ],
  "opportunities": [
    {"ticker":"XXXX","score":number,"action":"BUY|WATCHLIST","strategy":"Mean Reversion|Breakout Momentum|Earnings Catalyst","reasoning":"2-3 sentences","stop":number,"tp1":number,"tp2":number,"positionPct":number,"positionDollars":number,"shares":number,"waitingFor":"only if WATCHLIST",
     "signalAttribution":[{"source":"source_name","weight":number,"signal":"brief","verdict":"BULLISH|BEARISH|NEUTRAL"}]}
  ],
  "insights":"1 key observation",
  "stance":"Aggressive|Moderate|Defensive",
  "recommendedCash":"XX%",
  "nextCheckIn":"time"
}

RULES:
- Already held: ${openTickers.length ? openTickers.join(', ') : 'none'} — do NOT recommend BUY for these. Use positions array for HOLD/EXIT/TP.
- BUY needs score≥${minScore}, WATCHLIST ${Math.max(0,minScore-15)}-${minScore-1}. Skip entries below ${Math.max(0,minScore-15)}.
- Every BUY: stop, tp1, tp2, positionDollars (max $${walletState.cashBalance.toFixed(2)} total), shares. No entryPrice — system fetches live.
- Max risk 1% of $${walletState.totalValue.toFixed(0)} per trade. Cite 2-3 indicator values per reasoning.
- Keep response CONCISE. Max 3 opportunities. Short reasoning (2 sentences).
- NEVER recommend the same ticker twice. Each ticker appears at most ONCE in opportunities.
POSITION URGENCY RULES (you are the expert — make the decision, never just flag):
- Earnings ≤1 day + P&L < +3% → EXIT_NOW | Earnings ≤1 day + P&L ≥ +3% → TIGHTEN_STOP
- Earnings 2-5 days + P&L negative → EXIT_NOW | Earnings 2-5 days + P&L 0-5% → TIGHTEN_STOP, urgent
- Price within 2% of stop → EXIT_NOW | Price within 2% of TP1 → TAKE_PROFIT
- >10 days held + P&L < +3% → EXIT_NOW (time stop)
${attributionRulesText}`;

  // ── ASSESS MODE: deep single-ticker analysis ──────────────────────────
  const assessContext = assessTicker ? `${marketHeader}

TARGET TICKER: ${assessTicker}
${assessThesis ? `\nUSER THESIS:\n${assessThesis}\n` : ''}
${taData[assessTicker] ? `FULL TECHNICAL ANALYSIS for ${assessTicker}:\n${formatTA(taData[assessTicker])}\n` : `⚠️ No TA data available for ${assessTicker} — ticker may be invalid or data delayed.\n`}
ALREADY HELD: ${openTickers.includes(assessTicker) ? 'YES — already have an open position' : 'NO'}

Perform a DEEP ASSESSMENT of ${assessTicker}. Score it rigorously using the composite framework.
${assessThesis ? 'Evaluate the user thesis — confirm or challenge each claim with data.' : ''}

Respond with JSON (no markdown):
{
  "ticker": "${assessTicker}",
  "score": number_0_to_100,
  "verdict": "STRONG BUY|BUY|WATCHLIST|HOLD|AVOID",
  "headline": "one-line summary",
  "thesisEvaluation": ${assessThesis ? '"2-3 sentences evaluating the user thesis — what holds up, what doesn\'t"' : 'null'},
  "technicalSetup": {
    "score": number_0_to_40,
    "summary": "key TA signals with specific indicator values",
    "trend": "BULLISH|BEARISH|NEUTRAL",
    "keyLevels": {"support": number, "resistance": number, "pivot": number}
  },
  "fundamentalSetup": {
    "score": number_0_to_30,
    "summary": "valuation, earnings, sector context",
    "catalysts": ["upcoming catalyst 1", "catalyst 2"],
    "risks": ["risk 1", "risk 2"]
  },
  "macroAlignment": {
    "score": number_0_to_20,
    "summary": "how macro/geopolitical conditions affect this ticker"
  },
  "timingScore": {
    "score": number_0_to_10,
    "summary": "why now vs later"
  },
  "action": "BUY|WATCHLIST|AVOID",
  "strategy": "Mean Reversion|Breakout Momentum|Earnings Catalyst|Value Play|Sector Rotation",
  "entryZone": {"low": number, "mid": number, "high": number},
  "stop": number,
  "targets": {"tp1": number, "tp2": number, "tp3": number},
  "positionSizing": {
    "positionPct": number,
    "positionDollars": number,
    "shares": number,
    "riskDollars": number
  },
  "signalAttribution": [
    {"source": "string", "weight": number, "signal": "string", "verdict": "BULLISH|BEARISH|NEUTRAL"}
  ],
  "comparables": ["TICKER1 — why similar", "TICKER2 — why similar"],
  "waitConditions": "what needs to change before entry (if WATCHLIST/AVOID)",
  "timeHorizon": "1-3 days|1-2 weeks|2-4 weeks|1-3 months"
}

CRITICAL:
- Use the COMPUTED technical indicators — reference specific RSI, MACD, Z-Score, Bollinger, Fibonacci values.
- All 8 signal sources MUST appear in signalAttribution (NO_DATA sources get weight 0).
- positionDollars must not exceed wallet cash ($${walletState.cashBalance.toFixed(2)}).
- Be brutally honest. If the thesis is wrong, say so. Score below 40 = AVOID.
${attributionRulesText}` : null;

  // ── DISCOVER MODE: find underrated tickers ────────────────────────────
  const discoverContext = isDiscoverMode ? `${marketHeader}

🔍 DISCOVERY MODE — Find Underrated/Overlooked Stocks
${discoverFocus ? `FOCUS: ${discoverFocus}` : 'BROAD SEARCH — look across all sectors'}

FINVIZ SCREENER SIGNALS (live):
${finvizSignals ? Object.entries(finvizSignals).filter(([k])=>k!=='_errors').map(([screen, tickers]) =>
  `  ${screen}: ${Array.isArray(tickers) && tickers.length ? tickers.join(', ') : 'none found'}`
).join('\n') : '  Screener data unavailable'}

${(()=>{
  const qd = quiverData;
  const hasQData = qd.congressTrades.length + qd.insiderTrades.length + qd.govContracts.length + qd.lobbying.length > 0;
  if (!hasQData) return 'QUIVER QUANTITATIVE: Data unavailable\n';
  let qBlock = 'QUIVER QUANTITATIVE SIGNALS (live alternative data):\n';
  if (qd.insiderTrades.length > 0) qBlock += `  Insider Trades: ${[...new Set(qd.insiderTrades.map(t=>t.ticker))].join(', ')}\n`;
  if (qd.congressTrades.length > 0) qBlock += `  Congressional Trades: ${[...new Set(qd.congressTrades.map(t=>t.ticker))].join(', ')}\n`;
  if (qd.govContracts.length > 0) qBlock += `  Gov Contracts: ${[...new Set(qd.govContracts.map(t=>t.ticker))].join(', ')}\n`;
  if (qd.lobbying.length > 0) qBlock += `  Lobbying: ${[...new Set(qd.lobbying.map(t=>t.ticker))].join(', ')}\n`;
  return qBlock;
})()}

${Object.keys(taData).filter(t => t !== 'SPY' && !openTickers.includes(t)).length > 0 ?
  'TECHNICAL DATA FOR SCREENER CANDIDATES:\n' +
  Object.entries(taData).filter(([t]) => t !== 'SPY' && !openTickers.includes(t))
    .map(([ticker, ta]) => `${ticker}:\n${formatTA(ta)}`).join('\n\n')
  : ''}

ALREADY HELD (skip these): ${openTickers.join(', ') || 'none'}

YOUR TASK: Identify 3-5 UNDERRATED stocks that are:
1. NOT already held in the portfolio
2. Showing early accumulation signals (unusual volume, insider buying, oversold RSI bounce)
3. Aligned with current macro regime and sector rotation
4. Within wallet budget ($${walletState.cashBalance.toFixed(2)} available cash)

For EACH candidate, use the Finviz screener data, Quiver Quantitative signals, World Monitor intelligence, and computed TA indicators.
Cross-reference: a stock appearing in multiple screener categories OR in both Finviz and Quiver is a stronger signal.

Respond with JSON (no markdown):
{
  "regime": {
    "name": "current regime",
    "headline": "one-line regime summary",
    "discoveryBias": "what type of stocks the current regime favors"
  },
  "discoveries": [
    {
      "ticker": "XXXX",
      "score": number_0_to_100,
      "verdict": "STRONG BUY|BUY|WATCHLIST",
      "headline": "one catchy line — why this is underrated",
      "reasoning": "3-4 sentences: what screeners flagged it, TA confirmation, macro alignment, catalyst",
      "strategy": "Mean Reversion|Breakout Momentum|Earnings Catalyst|Value Play|Sector Rotation",
      "screenersHit": ["oversoldValue", "unusualVolume", etc.],
      "entryPrice": number,
      "stop": number,
      "tp1": number, "tp2": number,
      "positionDollars": number,
      "shares": number,
      "riskReward": "X:1",
      "timeHorizon": "1-3 days|1-2 weeks|2-4 weeks",
      "signalAttribution": [{"source":"...","weight":number,"signal":"...","verdict":"BULLISH|BEARISH|NEUTRAL"}]
    }
  ],
  "sectorRotation": "which sectors are seeing the most accumulation right now",
  "avoidSectors": "sectors to avoid and why"
}

CRITICAL:
- Only include stocks with score >= 50. Quality over quantity.
- Each discovery MUST cite specific TA values from computed data if available.
- Position sizing must respect wallet limits.
- If a stock appears in 3+ Finviz screeners, give it extra weight.
${attributionRulesText}` : null;

  // ── DIAGNOSE MODE: adversarial performance review ─────────────────────
  let diagnoseContext = null;
  let diagnosticData = null;
  if (isDiagnoseMode) {
    // Run diagnostics engine on all closed trades
    const allClosedFormatted = allClosedTrades.map(formatTrade);
    if (runDiagnostics) {
      diagnosticData = runDiagnostics(allClosedFormatted, openFormatted);
    }
    // Compute source weights for context
    let swData = null;
    if (computeSourceWeights && allClosedFormatted.length > 0) {
      try { swData = computeSourceWeights(allClosedFormatted); } catch {}
    }

    diagnoseContext = `PERFORMANCE EVALUATION MODE — ADVERSARIAL REVIEW
You are now acting as an INDEPENDENT REVIEWER, not the stock-picking analyst. Your job is to find weaknesses, miscalibrations, and improvement opportunities in this trading system's historical performance.

TRADE HISTORY (${allClosedFormatted.length} closed trades):
${allClosedFormatted.map(t => {
  let line = `${t.ticker} | ${t.strategy} | Score: ${t.score || '?'} | P&L: ${t.pnl != null ? (t.pnl > 0 ? '+' : '') + t.pnl.toFixed(1) + '%' : '?'} | Regime: ${t.regime || '?'} | Days: ${t.daysHeld || '?'}`;
  if (t.closeReason) line += ` | Close: ${t.closeReason}`;
  if (t.lesson) line += ` | Lesson: ${t.lesson}`;
  if (t.signalAttribution) {
    const attr = typeof t.signalAttribution === 'string' ? JSON.parse(t.signalAttribution) : t.signalAttribution;
    if (Array.isArray(attr)) {
      const topSources = attr.filter(a => a.weight > 15).map(a => `${a.source}(${a.verdict}:${a.weight}%)`).join(', ');
      if (topSources) line += ` | Signals: ${topSources}`;
    }
  }
  return `- ${line}`;
}).join('\n')}

OPEN POSITIONS (${openFormatted.length}):
${openFormatted.length ? openFormatted.map(t => `- ${t.ticker} | ${t.strategy} | Entry: $${t.entry} | Score: ${t.score}`).join('\n') : 'None'}

${diagnosticData ? `AUTOMATED DIAGNOSTIC FINDINGS (from our statistical engine):
${JSON.stringify(diagnosticData, null, 2)}` : 'Diagnostic engine unavailable — perform your own analysis.'}

${swData ? `SIGNAL SOURCE RELIABILITY (MWU Algorithm):
${swData.ranked.map(s => `  ${s.rank}. ${s.source}: ${s.weight}% weight | ${s.winRate != null ? s.winRate + '% WR' : 'no data'} (${s.wins}W/${s.losses}L) | conf: ${s.confidence}`).join('\n')}` : ''}

YOUR TASK: Produce specific, actionable tuning recommendations. For each finding, propose a concrete parameter change that could improve performance.

Respond with JSON (no markdown):
{
  "overallGrade": "A|B|C|D|F",
  "headline": "one-line summary of system health",
  "summary": "2-3 sentences on overall performance strengths and weaknesses",
  "recommendations": [
    {
      "id": "rec_1",
      "category": "regime|strategy|stop-loss|signal-weights|position-sizing|scoring|diversification|timing",
      "title": "Short descriptive title",
      "severity": "critical|high|medium|low",
      "finding": "What the data shows (specific numbers)",
      "diagnosis": "Why this is happening (root cause analysis)",
      "recommendation": "What to change (specific parameter adjustment)",
      "paramBefore": "Current setting/behavior",
      "paramAfter": "Proposed new setting/behavior",
      "expectedImpact": "Expected improvement if applied",
      "confidence": "high|medium|low",
      "evidence": "Supporting data points"
    }
  ],
  "positives": [
    {
      "title": "What's working well",
      "detail": "Supporting evidence"
    }
  ],
  "tradesAnalyzed": number,
  "riskScore": number_1_to_10
}

QUALITY GATES — MANDATORY FILTERING:
You are an autonomous system. Your recommendations will be AUTOMATICALLY APPLIED without human review. This means you MUST self-filter aggressively. Only output recommendations that pass ALL of these gates:

1. STATISTICAL SIGNIFICANCE: Do NOT recommend parameter changes based on fewer than 5 supporting data points. If you only have 1-2 trades in a category, the pattern is anecdotal, not actionable. State this in your reasoning and EXCLUDE the rec.
2. EVIDENCE OVER INTUITION: Every recommendation must cite specific trade outcomes (tickers, P&L, dates). "This seems like it would help" is not evidence. If you can't point to specific trades that would have gone differently, EXCLUDE the rec.
3. NO ARBITRARY WEIGHTS: Do NOT propose signal source weight changes unless you have win-rate-by-source data showing statistically significant differences. Equal weights with MWU organic adjustment is the correct approach during data collection phase.
4. CONFLICT CHECK: Do NOT recommend changes that would invalidate current open positions. Check the open positions list — if a rec would trigger an immediate stop-loss or force-close on an open position, EXCLUDE it or defer it with "applyAfter" field.
5. ACTIONABLE & SPECIFIC: "Adjust scoring" is useless. "Raise draft threshold from 65 to 72 for Earnings Catalyst strategy based on 3/4 sub-70 entries losing money" is actionable.

Each recommendation must include:
- "qualityScore": 1-10 (your confidence this will improve outcomes based on evidence)
- "applyAfter": null (apply immediately) OR ISO date string (defer until after this date, e.g. after earnings season)
- Only output recs with qualityScore >= 6. Drop anything below — it's noise.

ADDITIONAL RULES:
- Every recommendation MUST have paramBefore and paramAfter — these will be auto-applied.
- Do NOT recommend things outside the system's control (e.g., "get better data"). Focus on tunable parameters.
- Categories must be one of: regime, strategy, stop-loss, signal-weights, position-sizing, scoring, diversification, timing
- Each recommendation needs a unique id starting with "rec_"
- If the system is performing well and you cannot find 6+ quality recs, output FEWER. Quality over quantity. Even zero recs is valid if nothing meets the quality gates.`;
  }

  const context = isDiagnoseMode ? diagnoseContext : (isDiscoverMode ? discoverContext : (isAssessMode ? assessContext : (isQuick ? quickContext : fullContext)));

  // ── PHASE: DATA — return context + metadata, skip Claude call ────────
  if (phase === 'data') {
    return res.json({
      _phase: 'data',
      context,
      mode: isDiagnoseMode ? 'diagnose' : (isDiscoverMode ? 'discover' : (isAssessMode ? 'assess' : mode)),
      modelId: isQuick ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-6',
      maxTokens: isQuick ? 2048 : 8192,
      assessTicker: assessTicker || null,
      consistencyN,
      openTickers: openFormatted.map(t => t.ticker).filter(Boolean),
      openFormatted,
      walletState,
      _worldMonitor: {
        macroVerdict: wm.macroSignals?.verdict || null,
        fearGreed: wm.fearGreed ? `${wm.fearGreed.compositeScore} (${wm.fearGreed.compositeLabel})` : null,
        geoTheaters: wm.geopolitical?.theaters?.map(t => t.label) || [],
      },
      _sourceStatus,
      _sourceErrors: sourceErrors.length > 0 ? sourceErrors : undefined,
    });
  }

  // ── PHASE: AI — receive pre-fetched context, call Claude only ────────
  // (phase === 'all' falls through to here and uses locally-built context)

  // System prompts — quick mode is lightweight, full mode has scoring framework
  const quickSystemPrompt = `You are Daniel's investment position monitor. Return only valid JSON, no markdown.
Check each open position against its stop-loss and take-profit levels using the COMPUTED technical indicators provided. Be concise.`;

  const fullSystemPrompt = `You are Daniel's investment analyst. Return only valid JSON, no markdown. Use COMPUTED technical indicators (RSI, MACD, Bollinger, ATR, OBV, Z-Score, Stochastic, Fibonacci, EMA) from real OHLCV data — never estimate when data is provided. Use LIVE World Monitor data (macro verdict, F&G composite, geopolitical theaters). Scoring bonuses: Z-Score<-2 +3pts, Z-Score>+2 -3pts, OBV divergence ±3pts, Stoch cross ±2pts, Fib support +2pts, Bollinger %B<0.05 +2pts. Cap positions at 5%. Prefer 2×ATR stops over fixed 7%.`;

  // Assessment mode system prompt
  const assessSystemPrompt = `You are Daniel's personal investment analyst performing a DEEP single-ticker assessment. Apply the composite scoring framework rigorously. Return only valid JSON, no markdown.

You have COMPUTED technical indicators from real OHLCV data and LIVE World Monitor intelligence. Reference specific values — do not estimate when real data is provided.

Scoring dimensions:
- Technical Setup (0-40): RSI, MACD, Z-Score, Bollinger, Fibonacci, OBV, volume, EMA alignment
- Fundamental Setup (0-30): valuation, earnings, sector strength, catalysts
- Macro Alignment (0-20): regime fit, geopolitical risk, sector rotation
- Timing (0-10): entry timing quality, upcoming catalysts/risks

Be brutally honest. A score below 40 = AVOID. Above 75 = strong conviction. Challenge weak theses.`;

  const discoverSystemPrompt = `You are Daniel's investment discovery agent. Your job is to find underrated, overlooked, or early-stage momentum stocks using real screener data, technical indicators, and macro intelligence. Return only valid JSON, no markdown.

Be selective — only recommend stocks where multiple signals converge. A stock appearing in Finviz unusual volume AND showing RSI oversold bounce AND aligned with macro regime is far stronger than one signal alone.

You have COMPUTED technical indicators and LIVE World Monitor data. Reference specific values.`;

  const diagnoseSystemPrompt = `You are an ADVERSARIAL performance reviewer for an algorithmic trading system. You are NOT the stock-picking analyst — you are the quality control engineer who audits the analyst's work. Return only valid JSON, no markdown.

Your goal: find every weakness, miscalibration, and missed opportunity in this system's historical performance. Be brutally honest. The analyst will naturally resist your findings — that's expected. Your job is to find the truth in the data.

Approach:
1. Look at win rates by regime, strategy, and score bands — are scores actually predictive?
2. Check if stop-losses are too tight (many stopped-out trades that would have recovered) or too loose (large losses)
3. Examine signal source reliability — which sources actually correlate with winners?
4. Check position sizing — are large positions outperforming or underperforming?
5. Look for sector concentration risk in open positions
6. Check if the system has blind spots — types of trades it consistently loses on
7. Verify score calibration — does a score of 80 actually perform better than 70?

Be constructive but unflinching. Every recommendation must be specific and implementable.`;

  // Call Claude API — Haiku for quick checks, Sonnet for deep analysis + assessments + discovery + diagnose
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
  const modelId = isQuick ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-6';
  const maxTokens = isQuick ? 2048 : 8192;
  const systemPrompt = isDiagnoseMode ? diagnoseSystemPrompt : (isDiscoverMode ? discoverSystemPrompt : (isAssessMode ? assessSystemPrompt : (isQuick ? quickSystemPrompt : fullSystemPrompt)));

  // Run Claude call(s) — single for normal, PARALLEL for consistency mode
  async function singleClaudeCall(runNum) {
    try {
      const message = await client.messages.create({
        model: modelId,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: context }],
      });
      const rawText = message.content[0].text;
      const clean = rawText.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
      try {
        return { parsed: JSON.parse(clean), raw: rawText, run: runNum };
      } catch(pe) {
        return { parsed: null, raw: rawText, run: runNum, parseError: pe.message };
      }
    } catch(e) {
      return { parsed: null, raw: null, run: runNum, error: e.message };
    }
  }
  const allRuns = await Promise.all(
    Array.from({ length: consistencyN }, (_, i) => singleClaudeCall(i + 1))
  );

  // If all runs failed, return error
  const successfulRuns = allRuns.filter(r => r.parsed);
  if (successfulRuns.length === 0) {
    return res.status(500).json({ error: 'All Claude calls failed', runs: allRuns.map(r => r.error || r.parseError) });
  }

  // For consistency mode: compute cross-run stability metrics
  let consistencyReport = null;
  if (isConsistencyMode && successfulRuns.length >= 2) {
    // Extract all recommendations across runs
    const allRecs = successfulRuns.map(r => r.parsed.recommendations || []);

    // Semantic fingerprint: category + severity (primary), with keyword extraction for display
    // Two recs with same category+severity are the SAME finding expressed differently
    function recFingerprint(rec) {
      return `${rec.category}::${rec.severity}`;
    }

    // Extract key terms from title for display grouping
    function extractKeyTerms(title) {
      return (title || '').toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 3 && !['that','this','from','with','have','been','into','open','data'].includes(w))
        .slice(0, 5)
        .sort()
        .join(',');
    }

    // Count how many runs each category+severity combo appears in
    const fpCounts = {};
    const fpExamples = {}; // best example per fingerprint (longest title)
    const fpAllTitles = {}; // all titles seen for this fingerprint
    for (let i = 0; i < allRecs.length; i++) {
      const seen = new Set(); // dedupe within a single run
      for (const rec of allRecs[i]) {
        const fp = recFingerprint(rec);
        if (!seen.has(fp)) {
          fpCounts[fp] = (fpCounts[fp] || 0) + 1;
          if (!fpExamples[fp] || (rec.title || '').length > (fpExamples[fp].title || '').length) {
            fpExamples[fp] = rec;
          }
          if (!fpAllTitles[fp]) fpAllTitles[fp] = [];
          fpAllTitles[fp].push(rec.title);
          seen.add(fp);
        }
      }
    }

    // Category-level consistency (how many runs flagged this category at all)
    const catCounts = {};
    for (let i = 0; i < allRecs.length; i++) {
      const seen = new Set();
      for (const rec of allRecs[i]) {
        if (!seen.has(rec.category)) {
          catCounts[rec.category] = (catCounts[rec.category] || 0) + 1;
          seen.add(rec.category);
        }
      }
    }

    const N = successfulRuns.length;
    const stableRecs = Object.entries(fpCounts)
      .filter(([fp, count]) => count >= Math.ceil(N * 0.6)) // appears in 60%+ of runs
      .map(([fp, count]) => ({
        fingerprint: fp,
        appearedIn: count,
        totalRuns: N,
        stability: Math.round((count / N) * 100),
        example: fpExamples[fp],
        variations: fpAllTitles[fp] || [],
      }))
      .sort((a, b) => b.stability - a.stability);

    const unstableRecs = Object.entries(fpCounts)
      .filter(([fp, count]) => count < Math.ceil(N * 0.6))
      .map(([fp, count]) => ({
        fingerprint: fp,
        appearedIn: count,
        totalRuns: N,
        stability: Math.round((count / N) * 100),
        example: fpExamples[fp],
        variations: fpAllTitles[fp] || [],
      }))
      .sort((a, b) => b.stability - a.stability);

    // Category consistency
    const categoryStability = Object.entries(catCounts).map(([cat, count]) => ({
      category: cat,
      appearedIn: count,
      totalRuns: N,
      stability: Math.round((count / N) * 100),
    })).sort((a, b) => b.stability - a.stability);

    // Grade consistency
    const grades = successfulRuns.map(r => r.parsed.overallGrade || '?');
    const gradeMode = grades.sort().reduce((a, b, i, arr) =>
      arr.filter(v => v === a).length >= arr.filter(v => v === b).length ? a : b);
    const gradeConsistency = Math.round((grades.filter(g => g === gradeMode).length / N) * 100);

    // Risk score variance
    const risks = successfulRuns.map(r => r.parsed.riskScore || 0);
    const riskMean = risks.reduce((a, b) => a + b, 0) / risks.length;
    const riskVariance = risks.reduce((a, b) => a + Math.pow(b - riskMean, 2), 0) / risks.length;

    // Overall system confidence
    const totalFingerprints = Object.keys(fpCounts).length;
    const stableCount = stableRecs.length;
    const overallConfidence = totalFingerprints > 0 ? Math.round((stableCount / totalFingerprints) * 100) : 0;

    consistencyReport = {
      runsCompleted: N,
      runsRequested: consistencyN,
      overallConfidence,
      confidenceLabel: overallConfidence >= 80 ? 'High' : overallConfidence >= 50 ? 'Medium' : 'Low',
      gradeConsensus: gradeMode,
      gradeConsistency,
      grades,
      riskScores: risks,
      riskMean: Math.round(riskMean * 10) / 10,
      riskStdDev: Math.round(Math.sqrt(riskVariance) * 10) / 10,
      stableRecommendations: stableRecs,
      unstableRecommendations: unstableRecs,
      categoryStability,
      totalUniqueFingerprints: totalFingerprints,
    };
  }

  // Use the first successful run as the primary analysis
  const analysisText = successfulRuns[0].raw;
  let analysis = successfulRuns[0].parsed;
  if (!analysis) {
    return res.json({ raw: analysisText, parseError: 'Failed to parse' });
  }

  // Persist attribution + reasoning back to Notion for open positions (full mode only)
  const attributionUpdates = { attempted: 0, saved: 0, missing: [] };
  if (!isQuick && NOTION_TOKEN && analysis.positions) {
    const tickerToNotionId = {};
    for (const t of openFormatted) { if (t.ticker && t.notionId) tickerToNotionId[t.ticker] = t.notionId; }
    for (const p of analysis.positions) {
      attributionUpdates.attempted++;
      if (!p.signalAttribution || !p.signalAttribution.length) {
        attributionUpdates.missing.push(p.ticker || 'unknown');
        continue;
      }
      if (!tickerToNotionId[p.ticker]) continue;
      try {
        await updatePositionInNotion(tickerToNotionId[p.ticker], p.signalAttribution, p.reasoning, NOTION_TOKEN);
        attributionUpdates.saved++;
      } catch {}
    }
  }
  analysis._attributionSync = attributionUpdates;
  analysis._mode = isDiagnoseMode ? 'diagnose' : (isDiscoverMode ? 'discover' : (isAssessMode ? 'assess' : mode));
  analysis._assessTicker = assessTicker || null;
  analysis._model = modelId;
  analysis._worldMonitor = {
    macroVerdict: wm.macroSignals?.verdict || null,
    fearGreed: wm.fearGreed ? `${wm.fearGreed.compositeScore} (${wm.fearGreed.compositeLabel})` : null,
    geoTheaters: wm.geopolitical?.theaters?.map(t => t.label) || [],
    newsCount: wm.newsHeadlines?.length || 0,
    earningsCount: wm.earningsCalendar?.length || 0,
    econEventsCount: wm.economicCalendar?.length || 0,
  };

  // Deduplicate opportunities — keep highest-scored entry per ticker
  if (analysis.opportunities && analysis.opportunities.length > 1) {
    const best = {};
    for (const opp of analysis.opportunities) {
      const key = (opp.ticker || '').toUpperCase();
      if (!key) continue;
      if (!best[key] || (opp.score || 0) > (best[key].score || 0)) best[key] = opp;
    }
    analysis.opportunities = Object.values(best);
  }

  // Auto-create Order Drafts for BUY opportunities with score ≥ minScore
  // Skip tickers that already have open positions or existing drafts
  const openTickerSet = new Set(openFormatted.map(t => t.ticker.toUpperCase()).filter(Boolean));
  // Fetch existing drafts to prevent duplicates
  let existingDraftTickers = new Set();
  if (NOTION_TOKEN) {
    try {
      const draftData = JSON.stringify({filter:{and:[{property:'Status',select:{equals:'Draft'}},{property:'Simulation Mode',checkbox:{equals:true}}]},page_size:20});
      const draftResult = await new Promise(resolve=>{
        const req=https.request({hostname:'api.notion.com',path:`/v1/databases/${TRADE_DB}/query`,method:'POST',
          headers:{'Authorization':'Bearer '+NOTION_TOKEN,'Content-Type':'application/json','Notion-Version':'2022-06-28','Content-Length':Buffer.byteLength(draftData)}
        },res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{resolve(JSON.parse(d));}catch{resolve({});}});});
        req.on('error',()=>resolve({}));req.write(draftData);req.end();
      });
      for (const p of (draftResult.results||[])) {
        const t = p.properties?.['Ticker']?.rich_text?.[0]?.plain_text;
        if (t) existingDraftTickers.add(t.toUpperCase());
      }
    } catch{}
  }
  const draftedThisRun = new Set();
  const draftsCreated = [];
  const draftsSkipped = [];
  if (NOTION_TOKEN && ALPHA_KEY && analysis.opportunities) {
    for (const opp of analysis.opportunities) {
      if (opp.action === 'BUY' && opp.score >= minScore && opp.ticker) {
        const tickerKey = opp.ticker.toUpperCase();
        // Prevent duplicate positions
        if (openTickerSet.has(tickerKey)) {
          draftsSkipped.push({ ticker: opp.ticker, reason: 'Already have an open position' });
          opp._skippedDraft = true;
          continue;
        }
        if (existingDraftTickers.has(tickerKey)) { draftsSkipped.push({ ticker: opp.ticker, reason: 'Draft already exists' }); continue; }
        if (draftedThisRun.has(tickerKey)) { draftsSkipped.push({ ticker: opp.ticker, reason: 'Duplicate in this run' }); continue; }
        // ALWAYS fetch live price — never trust Claude's price suggestion
        let price = null;
        try {
          const pr = await httpsGet(`https://finnhub.io/api/v1/quote?symbol=${opp.ticker}&token=${ALPHA_KEY}`);
          const q = JSON.parse(pr.body);
          price = q && q.c && q.c > 0 ? q.c : null;
        } catch{}

        // No live price = skip draft but alert
        if (!price) {
          opp._priceAlert = `PRICE UNAVAILABLE for ${opp.ticker} — draft not created. Check Finnhub API or verify ticker symbol.`;
          opp.reasoning = `🚨 ALERT: ${opp._priceAlert} | ${opp.reasoning}`;
          continue;
        }

        // 💰 WALLET ENFORCEMENT — hard limit, server-side
        const positionCost = opp.positionDollars || (opp.positionPct ? walletState.totalValue * opp.positionPct / 100 : price);
        if (positionCost > walletState.cashBalance) {
          draftsSkipped.push({
            ticker: opp.ticker,
            reason: `INSUFFICIENT_FUNDS: need $${positionCost.toFixed(2)} but only $${walletState.cashBalance.toFixed(2)} cash available`,
          });
          opp._walletBlocked = true;
          opp._walletAlert = `💰 BLOCKED: $${positionCost.toFixed(2)} exceeds available cash $${walletState.cashBalance.toFixed(2)}`;
          continue;
        }

        {
          const draft = await createDraft(
            opp.ticker, opp.strategy, opp.score,
            opp.reasoning, analysis.regime?.name,
            opp.positionPct, price, NOTION_TOKEN, ALPHA_KEY,
            opp.signalAttribution
          );
          if (draft.ok) { draftsCreated.push(draft); draftedThisRun.add(tickerKey); }
          else if (draft.skipped) { draftsSkipped.push({ ticker: opp.ticker, reason: draft.reason }); }
        }
      }
    }
  }

  analysis.draftsCreated = draftsCreated;
  analysis.draftsSkipped = draftsSkipped;
  analysis.wallet = walletState;
  if (isDiagnoseMode && diagnosticData) analysis._diagnostics = diagnosticData;
  if (isConsistencyMode && consistencyReport) analysis._consistency = consistencyReport;
  analysis._activeTunings = approvedTunings ? approvedTunings.length : 0;
  analysis._effectiveMinScore = minScore;
  if (tuningMinScore !== null) analysis._tuningMinScore = tuningMinScore;

  // Attach source status + errors to response (collected earlier, before phase split)
  analysis._sourceStatus = _sourceStatus;
  if (sourceErrors.length > 0) analysis._sourceErrors = sourceErrors;

  // Collect price alerts for opportunities that couldn't get live prices
  analysis.priceAlerts = (analysis.opportunities || [])
    .filter(o => o._priceAlert)
    .map(o => ({ ticker: o.ticker, alert: o._priceAlert }));
  // Collect wallet-blocked alerts
  analysis.walletAlerts = (analysis.opportunities || [])
    .filter(o => o._walletBlocked)
    .map(o => ({ ticker: o.ticker, alert: o._walletAlert }));
  res.json(analysis);
  } catch (fatalErr) {
    console.error('FATAL analyze.js error:', fatalErr);
    return res.status(500).json({ error: fatalErr.message, stack: fatalErr.stack?.split('\n').slice(0,5) });
  }
};
