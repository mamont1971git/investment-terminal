const https = require('https');

// ── http helper ─────────────────────────────────────────────────────────────
function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': '*/*',
        ...headers,
      },
      timeout: 9000,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', reject)
      .on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
  });
}

// ── parsers ──────────────────────────────────────────────────────────────────
function parseStooqCSV(csv) {
  return csv.trim().split('\n').slice(1)
    .map(l => { const p = l.split(','); return { date: p[0], close: parseFloat(p[4] ?? p[1]) }; })
    .filter(r => r.date && !isNaN(r.close) && r.close > 0);
}

function parseAlphaVantageDaily(json) {
  const ts = json['Time Series (Daily)'];
  if (!ts) return [];
  return Object.entries(ts)
    .sort(([a],[b]) => a > b ? 1 : -1)
    .map(([date, v]) => ({ date, close: parseFloat(v['4. close']) }));
}

// ── 50-day EMA ───────────────────────────────────────────────────────────────
function calc50EMA(rows) {
  if (rows.length < 52) return null;
  const r = rows.slice(-120);
  const price = r[r.length - 1].close;
  const prev  = r[r.length - 2].close;
  const k = 2 / 51;
  let ema = r.slice(0, 50).reduce((s, x) => s + x.close, 0) / 50;
  for (let i = 50; i < r.length; i++) ema = r[i].close * k + ema * (1 - k);
  return { price: +price.toFixed(2), change: +(price-prev).toFixed(2),
           pct: +((price-prev)/prev*100).toFixed(2), ema50: +ema.toFixed(2),
           above: price > ema, pctAbove: +((price-ema)/ema*100).toFixed(2) };
}

// ── F&G from VIX proxy ───────────────────────────────────────────────────────
function vixToFG(vix, spyAbove, spyPct) {
  let v = Math.round(100 - (vix - 9) * 2.9);
  if (spyAbove) v += 4; else v -= 4;
  if (spyPct > 1.5) v += 8; else if (spyPct < -1.5) v -= 8;
  const value = Math.max(4, Math.min(96, v));
  const label = value>=75?'Extreme Greed':value>=60?'Greed':value>=45?'Neutral':value>=25?'Fear':'Extreme Fear';
  return { value, label, source: 'vix-proxy' };
}

// ── main handler ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  const ALPHA_KEY = process.env.ALPHA_VANTAGE_KEY || 'demo';
  const notes = [];
  let vix = null, spy = null, fg = null;

  // ── VIX: Stooq (reliable, no bot block) ──────────────────────────────────
  try {
    const r = await get('https://stooq.com/q/d/l/?s=%5EVIX&i=d');
    const rows = parseStooqCSV(r.body);
    if (rows.length < 2) throw new Error(`only ${rows.length} rows`);
    const v = rows[rows.length-1].close, p = rows[rows.length-2].close;
    vix = { value: +v.toFixed(2), change: +(v-p).toFixed(2), pct: +((v-p)/p*100).toFixed(2) };
  } catch(e) {
    notes.push('VIX/Stooq failed: ' + e.message);
    // Fallback: Alpha Vantage
    try {
      const r = await get(`https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=VIX&apikey=${ALPHA_KEY}`);
      const rows = parseAlphaVantageDaily(JSON.parse(r.body));
      if (rows.length < 2) throw new Error('no rows');
      const v = rows[rows.length-1].close, p = rows[rows.length-2].close;
      vix = { value: +v.toFixed(2), change: +(v-p).toFixed(2), pct: +((v-p)/p*100).toFixed(2), source: 'alphavantage' };
    } catch(e2) { notes.push('VIX/AlphaVantage also failed: ' + e2.message); }
  }

  // ── SPY: try 3 sources ───────────────────────────────────────────────────
  // Source 1: Stooq historical (works during market hours)
  try {
    const r = await get('https://stooq.com/q/d/l/?s=spy.us&i=d');
    const rows = parseStooqCSV(r.body);
    if (rows.length < 52) throw new Error(`only ${rows.length} rows`);
    spy = calc50EMA(rows);
    if (!spy) throw new Error('EMA calc failed');
  } catch(e) {
    notes.push('SPY/Stooq: ' + e.message);

    // Source 2: Alpha Vantage (works any time, 25 free calls/day)
    try {
      const r = await get(`https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=SPY&outputsize=compact&apikey=${ALPHA_KEY}`);
      const d = JSON.parse(r.body);
      if (d.Note || d.Information) throw new Error('Alpha Vantage rate limit: ' + (d.Note || d.Information).slice(0,60));
      const rows = parseAlphaVantageDaily(d);
      if (rows.length < 52) throw new Error(`only ${rows.length} rows`);
      spy = calc50EMA(rows);
      if (spy) spy.source = 'alphavantage';
      else throw new Error('EMA calc failed');
    } catch(e2) {
      notes.push('SPY/AlphaVantage: ' + e2.message);

      // Source 3: Alpha Vantage GLOBAL_QUOTE (current price, no rate limit issues)
      try {
        const r = await get(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=SPY&apikey=${ALPHA_KEY}`);
        const d = JSON.parse(r.body);
        const q = d['Global Quote'];
        if (!q || !q['05. price']) throw new Error('No quote data: ' + JSON.stringify(d).slice(0,100));
        const price = parseFloat(q['05. price']);
        const prev  = parseFloat(q['08. previous close'] || q['05. price']);
        // Approximate above/below 50 EMA from VIX level
        const aboveEMA = vix ? vix.value < 22 : true;
        spy = { price: +price.toFixed(2), change: +(price-prev).toFixed(2),
                pct: +((price-prev)/prev*100).toFixed(2),
                ema50: null, above: aboveEMA, pctAbove: null, source: 'alpha-quote' };
        notes.push('SPY: current price from Alpha Vantage, EMA approximated from VIX');
      } catch(e3) {
        notes.push('SPY/alpha-quote: ' + e3.message);
        // Final fallback: derive entirely from VIX
        if (vix) {
          spy = { price: null, above: vix.value < 22, pctAbove: null, source: 'vix-inferred' };
          notes.push('SPY: fully inferred from VIX');
        }
      }
    }
  }

  // ── Fear & Greed ─────────────────────────────────────────────────────────
  // Try CNN mobile UA first
  try {
    const r = await get('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15',
      'Referer': 'https://www.cnn.com/markets/fear-and-greed',
      'Origin': 'https://www.cnn.com',
    });
    const d = JSON.parse(r.body);
    const s = d?.fear_and_greed?.score;
    if (s == null) throw new Error('no score');
    fg = { value: Math.round(Number(s)), label: d.fear_and_greed.rating?.replace(/_/g,' '), source: 'cnn' };
  } catch(e) {
    notes.push('F&G/CNN: ' + e.message + ' — using VIX proxy');
    if (vix) fg = vixToFG(vix.value, spy?.above ?? true, spy?.pct ?? 0);
  }

  // Auto-log signal to Notion (non-blocking, silent fail)
  logSignalToNotion(vix, spy, fg, process.env.NOTION_TOKEN).catch(() => {});

  res.json({ vix, spy, fg, ts: new Date().toISOString(), notes });
};

// ── auto-log signal to Notion (if token available) ───────────────────────────
async function logSignalToNotion(vix, spy, fg, token) {
  if (!token) return;
  const SIGNAL_DB = 'c4a2f27b5636414d8930065adb36b12e';
  const regime = !vix ? 'Neutral' :
    vix.value > 30 ? 'Caution Zone' :
    (vix.value < 18 && spy?.above) ? 'Breakout Zone' : 'Mean Reversion Zone';
  const body = JSON.stringify({
    parent: { database_id: SIGNAL_DB },
    properties: {
      'Date':              { title: [{ text: { content: new Date().toISOString().split('T')[0] + ' — ' + new Date().toLocaleTimeString('en-US',{timeZone:'America/New_York'}) + ' ET' } }] },
      'Market Regime':     { select: { name: regime } },
      'VIX Level':         vix  ? { number: vix.value }  : { number: null },
      'Fear & Greed Index':fg   ? { number: fg.value }   : { number: null },
      'S&P vs 50 EMA':     spy  ? { select: { name: spy.above ? 'Solidly Above' : 'Below' } } : undefined,
      'Alert Sent':        { checkbox: false },
    },
  });
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.notion.com', path: '/v1/pages', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); resolve(); });
    req.on('error', resolve); // silent fail
    req.write(body); req.end();
  });
}
