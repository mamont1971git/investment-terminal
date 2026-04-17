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
function httpsGet(url, headers={}) {
  return new Promise((resolve,reject) => {
    https.get(url,{headers:{'User-Agent':'Mozilla/5.0',...headers},timeout:8000},res=>{
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve({status:res.statusCode,body:d}));
    }).on('error',reject).on('timeout',function(){this.destroy();reject(new Error('timeout'));});
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
  for (const [name, params] of Object.entries(screens)) {
    try {
      const r = await httpsGet(`https://finviz.com/screener.ashx?${params}`, {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html',
      });
      // Extract tickers from HTML table — look for ticker links
      const tickerMatches = r.body.match(/screener-link-primary"[^>]*>([A-Z]{1,5})<\/a>/g) || [];
      results[name] = tickerMatches.slice(0, 8).map(m => {
        const t = m.match(/>([A-Z]{1,5})</);
        return t ? t[1] : null;
      }).filter(Boolean);
    } catch { results[name] = []; }
  }
  return results;
}

// ── World Monitor: live geopolitical + macro intelligence ───────────────
async function fetchWorldMonitor() {
  const WM = 'https://api.worldmonitor.app';
  const results = { macroSignals: null, fearGreed: null, geopolitical: null, newsHeadlines: null, earningsCalendar: null, economicCalendar: null };
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
      const macro = JSON.parse(macroR.body);
      const signals = {};
      for (const [k, v] of Object.entries(macro.signals || {})) {
        const { sparkline, history, ...rest } = v; // strip large arrays
        signals[k] = rest;
      }
      results.macroSignals = {
        timestamp: macro.timestamp,
        verdict: macro.verdict,
        bullishCount: macro.bullishCount,
        totalCount: macro.totalCount,
        signals,
      };
    } catch {}

    // 2. Fear & Greed Composite — score + component breakdown
    try {
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
    } catch {}

    // 3. Geopolitical Forecast — active threat theaters
    try {
      const sim = JSON.parse(simR.body);
      const theaters = JSON.parse(sim.theaterSummariesJson || '[]');
      results.geopolitical = {
        generatedAt: sim.generatedAt ? new Date(sim.generatedAt).toISOString() : null,
        theaterCount: sim.theaterCount,
        theaters: theaters.map(t => ({ id: t.theaterId, label: t.theaterLabel })),
      };
    } catch {}

    // 4. News Headlines — top 3 from finance + geopolitical categories
    try {
      const news = JSON.parse(newsR.body);
      const cats = news.categories || {};
      const headlines = [];
      for (const cat of ['finance', 'us', 'middleeast', 'europe', 'politics']) {
        const items = cats[cat]?.items || [];
        for (const item of items.slice(0, 3)) {
          headlines.push({ category: cat, title: item.title, source: item.source });
        }
      }
      results.newsHeadlines = headlines.slice(0, 12); // cap at 12 headlines
    } catch {}

    // 5. Earnings Calendar — next 2 weeks, filtered to relevant tickers
    try {
      const earn = JSON.parse(earningsR.body);
      const allEarnings = earn.earnings || [];
      // Keep: tickers in portfolio, plus top market-cap names (max 15 total to stay lean)
      results.earningsCalendar = allEarnings
        .filter(e => e.symbol && e.date)
        .map(e => ({ symbol: e.symbol, date: e.date, time: e.time || '', estimate: e.epsEstimate, name: e.name }))
        .slice(0, 20); // cap to keep prompt lean
    } catch {}

    // 6. Economic Calendar — upcoming macro events (FOMC, CPI, NFP, etc.)
    try {
      const econ = JSON.parse(econR.body);
      const events = econ.events || [];
      results.economicCalendar = events
        .filter(e => e.event || e.name)
        .map(e => ({ date: e.date, event: e.event || e.name, country: e.country, impact: e.impact, actual: e.actual, forecast: e.forecast, previous: e.previous }))
        .slice(0, 15); // cap at 15 events
    } catch {}
  } catch {} // outer catch — if entire WM is down, proceed without it

  return results;
}

async function fetchMarketData() {
  try {
    const r = await httpsGet(`https://stooq.com/q/d/l/?s=%5EVIX&i=d`);
    const lines = r.body.trim().split('\n').slice(1).filter(l=>l.includes(','));
    const last = lines[lines.length-1]?.split(',');
    const vix = last ? parseFloat(last[4]||last[1]) : null;

    // SPY price via Finnhub
    const FINNHUB = process.env.FINNHUB_KEY;
    let spyPrice=null, spyAbove=null;
    if (FINNHUB) {
      const sr = await httpsGet(`https://finnhub.io/api/v1/quote?symbol=SPY&token=${FINNHUB}`);
      const q = JSON.parse(sr.body);
      spyPrice = q && q.c && q.c > 0 ? q.c : null;
      spyAbove = vix ? vix < 22 : null; // approximate
    }

    return { vix, spyPrice, spyAbove, fg: null }; // F&G often blocked, Claude will note
  } catch { return { vix: null, spyPrice: null, spyAbove: null, fg: null }; }
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
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }, res => {
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
  for (const ticker of tickers) { // no limit — Finnhub allows 60 calls/min
    const bars = await fetchOHLCV(ticker, apiKey);
    if (bars && bars.length >= 30) {
      results[ticker] = computeAll(bars);
    }
    if (tickers.length > 1) await new Promise(r => setTimeout(r, 250));
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
  // Reuse create-draft logic inline
  const stop=+(entryPrice*0.93).toFixed(2),tp1=+(entryPrice*1.08).toFixed(2),
        tp2=+(entryPrice*1.15).toFixed(2),tp3=+(entryPrice*1.22).toFixed(2);
  const today=new Date().toISOString().split('T')[0];
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

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const NOTION_TOKEN  = process.env.NOTION_TOKEN;
  const ALPHA_KEY     = process.env.FINNHUB_KEY;

  if (!ANTHROPIC_KEY) return res.status(503).json({error:'ANTHROPIC_API_KEY not set in Vercel env vars'});

  let body=''; req.on('data',c=>body+=c);
  await new Promise(r=>req.on('end',r));
  const parsed = JSON.parse(body||'{}');
  const command = parsed.command || 'run investment analysis';
  const mode = parsed.mode || 'full'; // 'quick' = Haiku (cheap), 'full' = Sonnet (deep + attribution)

  // Detect single-ticker assessment mode
  const tickerMatch = command.match(/^score\s+([A-Z]{1,5})$/i) || command.match(/^assess\s+([A-Z]{1,5})$/i);
  const assessTicker = parsed.ticker?.toUpperCase() || (tickerMatch ? tickerMatch[1].toUpperCase() : null);
  const assessThesis = parsed.thesis || '';
  const isAssessMode = !!assessTicker;

  // Detect discovery mode
  const isDiscoverMode = mode === 'discover' || /discover|find.*underrated|hidden.*gems/i.test(command);
  const discoverFocus = parsed.focus || ''; // e.g. "tech", "energy", "value", "momentum"

  // Detect diagnose mode (performance evaluation + prescription)
  const isDiagnoseMode = mode === 'diagnose' || /evaluate.*performance|diagnose|run.*diagnostics/i.test(command);

  // Fetch context — quick mode skips closed trades and limits TA
  const isQuick = mode === 'quick' && !isAssessMode;
  const [market, openTrades, closedTrades, worldMonitor, walletState, finvizSignals, approvedTunings] = await Promise.all([
    fetchMarketData(),
    NOTION_TOKEN ? fetchOpenTrades(NOTION_TOKEN) : Promise.resolve([]),
    (!isQuick && NOTION_TOKEN) ? fetchRecentClosed(NOTION_TOKEN) : Promise.resolve([]),
    fetchWorldMonitor(),
    NOTION_TOKEN ? fetchWalletState(NOTION_TOKEN) : Promise.resolve({ cashBalance: 0, totalInvested: 0, totalValue: 0, holdings: {}, txCount: 0 }),
    (isDiscoverMode || mode === 'full') ? fetchFinvizSignals() : Promise.resolve(null),
    (!isQuick && !isDiagnoseMode && NOTION_TOKEN) ? fetchApprovedTunings(NOTION_TOKEN) : Promise.resolve([]),
  ]);

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

  const openFormatted = openTrades.map(formatTrade);
  const closedFormatted = closedTrades.map(formatTrade);
  const today = new Date().toDateString();

  // Fetch technical analysis — quick mode only fetches SPY + open positions + assess target
  const openTickers = openFormatted.map(t => t.ticker).filter(Boolean);
  const taTickers = ['SPY', ...openTickers];
  if (assessTicker && !taTickers.includes(assessTicker)) taTickers.push(assessTicker);
  // In discover mode, fetch TA for top screener candidates
  if (finvizSignals) {
    const allScreenerTickers = [...new Set(Object.values(finvizSignals).flat())];
    for (const t of allScreenerTickers.slice(0, 6)) { // limit to 6 to respect rate limits
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

  // Build market header (shared by both modes)
  const marketHeader = `TODAY: ${today}

LIVE MARKET DATA:
- VIX: ${market.vix ? market.vix.toFixed(2) : (wm.fearGreed?.components?.volatility?.inputs?.vix || 'unavailable')}
- Fear & Greed: ${fgDisplay}
- SPY: ${market.spyPrice ? '$'+market.spyPrice.toFixed(2) : 'unavailable'} | Above 50 EMA: ${taData.SPY?.emaAlignment ? (taData.SPY.emaAlignment.above50?'YES':'NO') + ' (computed: price $'+taData.SPY.price+' vs EMA50 $'+taData.SPY.emaAlignment.ema50+')' : market.spyAbove===null?'approx from VIX':market.spyAbove?'YES':'NO'}
${taContext}${wmContext}

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
  const attributionRulesText = `- Every position and opportunity MUST include a "signalAttribution" array with ALL 7 core sources.
- Each entry has: source (exact name from list), weight (0-100, all weights must sum to 100), signal (1 sentence what this source specifically says for THIS ticker), verdict (BULLISH/BEARISH/NEUTRAL/NO_DATA).
- ALWAYS include ALL of these 7 sources for every ticker:
  1. "Technical Analysis" — cite specific RSI, MACD, Z-Score, Bollinger, OBV values from computed data above
  2. "CNN Fear & Greed" — current market sentiment from VIX/F&G. If VIX data available, use it as proxy
  3. "Capitol Trades" — any known congressional trading activity for this ticker. If none known, say "No recent congressional trades detected" with verdict NO_DATA and weight 0
  4. "Finviz Screener" — whether this ticker appears in oversold/breakout screeners based on its current technicals. Infer from the computed indicators whether it would show up
  5. "Earnings Calendar" — use the UPCOMING EARNINGS data from World Monitor above. Flag if a ticker reports within 7 days (risk for mean reversion, catalyst for momentum). If not in calendar, say "No earnings in next 2 weeks"
  6. "Sector Momentum" — how this ticker's sector is performing (tech, gold, healthcare, etc.)
  7. "World Monitor" — MANDATORY. Use the World Monitor live intelligence above: macro signals verdict, geopolitical threat theaters, fear/greed composite breakdown, and news headlines. This is REAL LIVE DATA — cite specific values (e.g., macro verdict, theater names, F&G composite score).
- Optionally add "Insider Activity" if relevant
- Sources with NO_DATA get weight 0. Remaining weights must sum to 100.
- The signal field should explain HOW this source affected the analysis — not just state a fact but connect it to the recommendation.`;

  const fullContext = `${marketHeader}

RECENT CLOSED TRADES (last ${closedFormatted.length}):
${closedFormatted.length ? closedFormatted.map(t=>`- ${t.ticker} | ${t.strategy} | P&L: ${t.pnl!=null?(t.pnl>0?'+':'')+t.pnl.toFixed(1)+'%':'open'} | Score was: ${t.score||'?'} | Lesson: ${t.lesson||'none'}`).join('\n') : 'None yet'}
${finvizSignals ? `
📊 FINVIZ SCREENER SIGNALS (live unusual activity — use these to find NEW opportunities):
${Object.entries(finvizSignals).map(([screen, tickers]) =>
  `  ${screen}: ${tickers.length ? tickers.join(', ') : 'none'}`).join('\n')}
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
    {
      "ticker": "XXXX",
      "recommendation": "HOLD|TAKE_PROFIT|EXIT_NOW|TIGHTEN_STOP",
      "currentPrice": number_or_null,
      "pnlPct": number_or_null,
      "reasoning": "2-3 sentences: why this action, what changed, what to watch",
      "urgency": "urgent|watch|ok",
      "signalAttribution": [
        {
          "source": "Technical Analysis|Capitol Trades|Finviz Screener|CNN Fear & Greed|World Monitor|Earnings Calendar|Insider Activity|Sector Momentum",
          "weight": number_0_to_100,
          "signal": "what this source specifically says now (1 sentence)",
          "verdict": "BULLISH|BEARISH|NEUTRAL"
        }
      ]
    }
  ],
  "opportunities": [
    {
      "ticker": "XXXX",
      "score": number_0_to_100,
      "action": "BUY|WATCHLIST",
      "strategy": "Mean Reversion|Breakout Momentum|Earnings Catalyst",
      "reasoning": "3-4 sentences explaining the setup and why now",
      "entryPrice": number,
      "stop": number, "tp1": number, "tp2": number,
      "positionPct": number,
      "positionDollars": number_dollar_amount_from_wallet,
      "shares": number_of_shares_to_buy,
      "waitingFor": "only for WATCHLIST — what needs to improve",
      "signalAttribution": [
        {
          "source": "Technical Analysis|Capitol Trades|Finviz Screener|CNN Fear & Greed|World Monitor|Earnings Calendar|Insider Activity|Sector Momentum",
          "weight": number_0_to_100,
          "signal": "what this source specifically said (1 sentence)",
          "verdict": "BULLISH|BEARISH|NEUTRAL"
        }
      ]
    }
  ],
  "insights": "1-2 key portfolio observations from trade history",
  "stance": "Aggressive|Moderate|Defensive",
  "recommendedCash": "XX%",
  "nextCheckIn": "time/date"
}

CRITICAL RULES:
- NEVER recommend BUY for tickers that are already in OPEN PAPER TRADES above. These tickers are ALREADY HELD: ${openTickers.length ? openTickers.join(', ') : 'none'}. Only recommend new tickers not in this list. Handle existing positions in the "positions" array with HOLD/TAKE_PROFIT/EXIT_NOW/TIGHTEN_STOP.
- For "full analysis" or "run investment analysis": ONLY return BUY (score≥65) and WATCHLIST (score 50-64) in opportunities. Do NOT include SKIP entries — they waste space. Focus on actionable items only.
- For "score" commands on a specific ticker: include the full verdict even if SKIP.
- For "portfolio review": focus entirely on positions array with detailed actions. Opportunities array can be empty.
- Every BUY must have stop, tp1, tp2, positionPct, positionDollars, shares. Calculate positionDollars from the wallet cash available ($${walletState.cashBalance.toFixed(2)}), then shares = positionDollars / estimated_price. Do NOT include entryPrice — the system will fetch the live price automatically. If you don't know the current price, still recommend the trade; the system handles pricing.
- WALLET ENFORCEMENT: Total cost of ALL BUY recommendations in this response must NOT exceed available cash ($${walletState.cashBalance.toFixed(2)}). If insufficient cash, use WATCHLIST instead of BUY.
- Every position must have a specific recommendation and reasoning. Never say "monitor" — say exactly what to do.
- Be specific with price levels and percentages. The user needs exact numbers to act on.
- USE THE COMPUTED TECHNICAL INDICATORS above — they are calculated from real OHLCV data. Refer to specific RSI, MACD, Bollinger, Z-Score, Fibonacci, OBV, volume ratio values in your reasoning.
- Apply the 1% Rule: never risk more than 1% of total portfolio value ($${(walletState.totalValue * 0.01).toFixed(2)}) on any single trade. Use the computed 1% rule max shares as a guide.
- Reference Fibonacci support/resistance levels for entry/exit targets when available.
- If OBV shows bearish divergence (price up but volume not confirming), flag it as a warning.
- Z-Score below -2 is a strong mean reversion signal; above +2 is overbought warning.
- In your reasoning for each position/opportunity, cite at least 2-3 specific indicator values.

SIGNAL ATTRIBUTION RULES:
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
- All 7 signal sources MUST appear in signalAttribution (NO_DATA sources get weight 0).
- positionDollars must not exceed wallet cash ($${walletState.cashBalance.toFixed(2)}).
- Be brutally honest. If the thesis is wrong, say so. Score below 40 = AVOID.
${attributionRulesText}` : null;

  // ── DISCOVER MODE: find underrated tickers ────────────────────────────
  const discoverContext = isDiscoverMode ? `${marketHeader}

🔍 DISCOVERY MODE — Find Underrated/Overlooked Stocks
${discoverFocus ? `FOCUS: ${discoverFocus}` : 'BROAD SEARCH — look across all sectors'}

FINVIZ SCREENER SIGNALS (live):
${finvizSignals ? Object.entries(finvizSignals).map(([screen, tickers]) =>
  `  ${screen}: ${tickers.length ? tickers.join(', ') : 'none found'}`
).join('\n') : '  Screener data unavailable'}

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

For EACH candidate, use the Finviz screener data, World Monitor intelligence, and computed TA indicators.
Cross-reference: a stock appearing in multiple screener categories is a stronger signal.

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

CRITICAL RULES:
- Be specific. "Adjust scoring" is useless. "Raise draft threshold from 65 to 75 in Caution Zone regimes" is actionable.
- Every recommendation MUST have paramBefore and paramAfter — these will be used to apply fixes.
- Challenge the scoring model, the signal source weights, the stop-loss methodology, the position sizing — everything.
- If the system is doing well, say so — but still find 2-3 things to improve.
- Do NOT recommend things outside the system's control (e.g., "get better data"). Focus on tunable parameters.
- Categories must be one of: regime, strategy, stop-loss, signal-weights, position-sizing, scoring, diversification, timing
- Each recommendation needs a unique id starting with "rec_"`;
  }

  const context = isDiagnoseMode ? diagnoseContext : (isDiscoverMode ? discoverContext : (isAssessMode ? assessContext : (isQuick ? quickContext : fullContext)));


  // System prompts — quick mode is lightweight, full mode has scoring framework
  const quickSystemPrompt = `You are Daniel's investment position monitor. Return only valid JSON, no markdown.
Check each open position against its stop-loss and take-profit levels using the COMPUTED technical indicators provided. Be concise.`;

  const fullSystemPrompt = `You are Daniel's personal investment analyst. Apply the composite scoring framework rigorously. Return only valid JSON, no markdown.

You have access to COMPUTED technical indicators (RSI, MACD, Bollinger Bands, ATR, OBV, Z-Score, Stochastic, Williams %R, CCI, Fibonacci retracement, SMA/EMA alignment) calculated from real OHLCV price data. ALWAYS reference these computed values in your analysis — do not estimate or guess indicator values when real data is provided.

You also have LIVE World Monitor intelligence: macro signals with a machine-generated BUY/SELL/HOLD verdict, a composite Fear & Greed index with VIX/put-call/breadth inputs, active geopolitical threat theaters, and live news headlines. This is REAL-TIME data — incorporate it into every analysis. World Monitor is a MANDATORY signal source for attribution.

Scoring framework additions:
- Z-Score < -2: +3pts to Technical Setup (statistically extreme oversold)
- Z-Score > +2: -3pts (overbought warning)
- OBV bullish divergence (price down, volume accumulating): +3pts
- OBV bearish divergence (price up, volume dropping): -3pts
- Stochastic bullish cross in oversold zone: +2pts
- Stochastic bearish cross in overbought zone: -2pts
- Fibonacci: if price is at 0.618 or 0.786 retracement support: +2pts
- Bollinger %B < 0.05 (at lower band): +2pts for mean reversion
- 1% Rule: if computed position size exceeds 5% of portfolio, cap at 5%
- ATR-based stops: prefer 2×ATR stop over fixed 7% when ATR data available`;

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
  const modelId = (isQuick && !isAssessMode && !isDiscoverMode && !isDiagnoseMode) ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-6';
  const maxTokens = isQuick ? 2048 : 8192;
  const systemPrompt = isDiagnoseMode ? diagnoseSystemPrompt : (isDiscoverMode ? discoverSystemPrompt : (isAssessMode ? assessSystemPrompt : (isQuick ? quickSystemPrompt : fullSystemPrompt)));

  let analysisText;
  try {
    const message = await client.messages.create({
      model: modelId,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: context }],
    });
    analysisText = message.content[0].text;
  } catch(e) {
    return res.status(500).json({error:'Claude API error: '+e.message});
  }

  // Parse JSON response
  let analysis;
  try {
    // Strip any markdown code fences if present
    const clean = analysisText.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
    analysis = JSON.parse(clean);
  } catch(e) {
    // If JSON parse fails, return raw text in a wrapper
    return res.json({ raw: analysisText, parseError: e.message });
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

  // Auto-create Order Drafts for BUY opportunities with score ≥ 65
  // Skip tickers that already have open positions to prevent duplicates
  const openTickerSet = new Set(openFormatted.map(t => t.ticker.toUpperCase()).filter(Boolean));
  const draftsCreated = [];
  const draftsSkipped = [];
  if (NOTION_TOKEN && ALPHA_KEY && analysis.opportunities) {
    for (const opp of analysis.opportunities) {
      if (opp.action === 'BUY' && opp.score >= 65 && opp.ticker) {
        // Prevent duplicate positions
        if (openTickerSet.has(opp.ticker.toUpperCase())) {
          draftsSkipped.push({ ticker: opp.ticker, reason: 'Already have an open position' });
          opp._skippedDraft = true;
          continue;
        }
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
          if (draft.ok) draftsCreated.push(draft);
        }
      }
    }
  }

  analysis.draftsCreated = draftsCreated;
  analysis.draftsSkipped = draftsSkipped;
  analysis.wallet = walletState;
  if (isDiagnoseMode && diagnosticData) analysis._diagnostics = diagnosticData;
  analysis._activeTunings = approvedTunings ? approvedTunings.length : 0;
  // Collect price alerts for opportunities that couldn't get live prices
  analysis.priceAlerts = (analysis.opportunities || [])
    .filter(o => o._priceAlert)
    .map(o => ({ ticker: o.ticker, alert: o._priceAlert }));
  // Collect wallet-blocked alerts
  analysis.walletAlerts = (analysis.opportunities || [])
    .filter(o => o._walletBlocked)
    .map(o => ({ ticker: o.ticker, alert: o._walletAlert }));
  res.json(analysis);
};
