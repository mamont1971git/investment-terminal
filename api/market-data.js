const https = require('https');

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/json,text/csv,*/*',
        ...headers,
      },
      timeout: 8000,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', reject)
      .on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
  });
}

// Parse Stooq daily CSV  → [{date, close}]
// Stooq format: Date,Open,High,Low,Close,Volume
function parseCSV(csv) {
  return csv.trim().split('\n').slice(1)
    .map(line => { const p = line.split(','); return { date: p[0], close: parseFloat(p[4] ?? p[1]) }; })
    .filter(r => !isNaN(r.close) && r.close > 0);
}

// VIX → approximate Fear & Greed (used as fallback when CNN blocks us)
// Calibrated: VIX 18 ≈ F&G 47, VIX 30 ≈ F&G 18, VIX 12 ≈ F&G 70
function vixToFG(vix, spyAbove, spyDayPct) {
  let base = Math.round(100 - (vix - 9) * 2.9);
  if (spyAbove) base += 5; else base -= 5;
  if (spyDayPct >  1.5) base += 8;
  else if (spyDayPct > 0.5) base += 3;
  else if (spyDayPct < -1.5) base -= 8;
  else if (spyDayPct < -0.5) base -= 3;
  const value = Math.max(4, Math.min(96, base));
  const label = value >= 75 ? 'Extreme Greed' : value >= 60 ? 'Greed' :
                value >= 45 ? 'Neutral' : value >= 25 ? 'Fear' : 'Extreme Fear';
  return { value, label, source: 'vix-proxy' };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  const errors = {};
  let vix = null, spy = null, fg = null;

  // ── VIX via Stooq (no bot detection, reliable) ──────────────────────────
  try {
    const r = await get('https://stooq.com/q/d/l/?s=%5EVIX&i=d');
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const rows = parseCSV(r.body);
    if (rows.length < 2) throw new Error('Not enough rows: ' + rows.length);
    const v = rows[rows.length - 1].close;
    const p = rows[rows.length - 2].close;
    vix = { value: v, change: +(v - p).toFixed(2), pct: +((v - p) / p * 100).toFixed(2) };
  } catch(e) { errors.vix = e.message; }

  // ── SPY via Stooq (120 days for 50-day EMA) ──────────────────────────────
  try {
    const r = await get('https://stooq.com/q/d/l/?s=spy.us&i=d');
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const rows = parseCSV(r.body).slice(-120);
    if (rows.length < 52) throw new Error('Not enough rows: ' + rows.length);
    const price = rows[rows.length - 1].close;
    const prev  = rows[rows.length - 2].close;
    const k = 2 / 51;
    let ema = rows.slice(0, 50).reduce((s, r) => s + r.close, 0) / 50;
    for (let i = 50; i < rows.length; i++) ema = rows[i].close * k + ema * (1 - k);
    spy = {
      price: +price.toFixed(2),
      change: +(price - prev).toFixed(2),
      pct: +((price - prev) / prev * 100).toFixed(2),
      ema50: +ema.toFixed(2),
      above: price > ema,
      pctAbove: +((price - ema) / ema * 100).toFixed(2),
    };
  } catch(e) { errors.spy = e.message; }

  // ── Fear & Greed: try CNN first, fall back to VIX proxy ─────────────────
  try {
    // Mobile UA often bypasses bot detection on CNN
    const r = await get('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      'Referer': 'https://www.cnn.com/markets/fear-and-greed',
      'Origin': 'https://www.cnn.com',
      'Accept': 'application/json',
    });
    const d = JSON.parse(r.body);
    const obj = d?.fear_and_greed;
    if (obj?.score == null) throw new Error('No score in response');
    fg = { value: Math.round(Number(obj.score)), label: obj.rating?.replace(/_/g, ' '), source: 'cnn' };
  } catch(e) {
    errors.fg = 'CNN blocked (' + e.message + ') — using VIX proxy';
    // Calculate from VIX if available
    if (vix) fg = vixToFG(vix.value, spy?.above ?? true, spy?.pct ?? 0);
  }

  res.json({ vix, spy, fg, ts: new Date().toISOString(), errors });
};
