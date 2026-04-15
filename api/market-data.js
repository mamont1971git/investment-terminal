const https = require('https');

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://finance.yahoo.com',
      },
      timeout: 8000,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error('JSON parse error: ' + d.slice(0,100))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300'); // cache 5 min on Vercel edge

  const [vixRes, spyRes, fgRes] = await Promise.allSettled([
    get('https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=2d'),
    get('https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=120d'),
    get('https://production.dataviz.cnn.io/index/fearandgreed/graphdata'),
  ]);

  // VIX
  let vix = null;
  try {
    const r = vixRes.value?.chart?.result?.[0];
    if (r) {
      const v = r.meta.regularMarketPrice, p = r.meta.previousClose || v;
      vix = { value: v, change: v - p, pct: (v - p) / p * 100 };
    }
  } catch(e) {}

  // SPY + 50-day EMA
  let spy = null;
  try {
    const r = spyRes.value?.chart?.result?.[0];
    if (r) {
      const closes = r.indicators.quote[0].close.filter(x => x != null);
      if (closes.length >= 52) {
        const price = closes[closes.length - 1];
        const prev  = closes[closes.length - 2];
        const k = 2 / 51;
        let ema = closes.slice(0, 50).reduce((a, b) => a + b, 0) / 50;
        for (let i = 50; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
        spy = { price, change: price - prev, pct: (price - prev) / prev * 100,
                ema50: ema, above: price > ema, pctAbove: (price - ema) / ema * 100 };
      }
    }
  } catch(e) {}

  // Fear & Greed — handle multiple possible structures
  let fg = null;
  try {
    const d = fgRes.value;
    const obj = d?.fear_and_greed ?? d?.fgi ?? d?.data;
    const val = obj?.score ?? obj?.value ?? d?.score ?? d?.value;
    const lbl = obj?.rating ?? obj?.label ?? d?.rating ?? d?.classification ?? '';
    if (val != null) fg = { value: Math.round(Number(val)), label: String(lbl).replace(/_/g, ' ') };
  } catch(e) {}

  res.json({
    vix, spy, fg,
    ts: new Date().toISOString(),
    errors: {
      vix: vixRes.status === 'rejected' ? vixRes.reason?.message : null,
      spy: spyRes.status === 'rejected' ? spyRes.reason?.message : null,
      fg:  fgRes.status  === 'rejected' ? fgRes.reason?.message  : null,
    }
  });
};
