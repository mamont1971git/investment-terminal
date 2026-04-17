// POST /api/paper-trade
// Auto-creates a paper trade in Notion with current market price
const https = require('https');

const TRADE_DB   = '661bed1034ae4030be88d3ee7d125d42';
const WATCHLIST  = '050aaa8a0ed44562bbed9cc63eccc7ee';

function notionPost(path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.notion.com', path, method: 'POST',
      headers: { 'Authorization':'Bearer '+token, 'Content-Type':'application/json',
                 'Notion-Version':'2022-06-28', 'Content-Length':Buffer.byteLength(data) },
    }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(d)})); });
    req.on('error', reject); req.write(data); req.end();
  });
}

async function fetchPrice(ticker, apiKey) {
  return new Promise((resolve) => {
    const url = `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${apiKey}`;
    https.get(url, { headers:{'User-Agent':'Mozilla/5.0'}, timeout:5000 }, res => {
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{
        try {
          const q = JSON.parse(d);
          resolve(q && q.c && q.c > 0 ? q.c : null);
        } catch { resolve(null); }
      });
    }).on('error',()=>resolve(null)).on('timeout',function(){this.destroy();resolve(null);});
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS') return res.status(200).end();

  const TOKEN = process.env.NOTION_TOKEN;
  const ALPHA = process.env.FINNHUB_KEY;
  if (!TOKEN) return res.status(503).json({error:'NOTION_TOKEN not set'});

  let body=''; req.on('data',c=>body+=c);
  await new Promise(r=>req.on('end',r));
  let t; try { t=JSON.parse(body); } catch { return res.status(400).json({error:'Invalid JSON'}); }

  const ticker = (t.ticker||'').toUpperCase();
  if (!ticker) return res.status(400).json({error:'ticker required'});

  // Fetch current price if not provided
  let entryPrice = t.entryPrice ? parseFloat(t.entryPrice) : null;
  if (!entryPrice && ALPHA) entryPrice = await fetchPrice(ticker, ALPHA);
  if (!entryPrice) return res.status(503).json({error:`Could not fetch price for ${ticker}`});

  const stop  = +(entryPrice * 0.93).toFixed(2);
  const tp1   = +(entryPrice * 1.08).toFixed(2);
  const tp2   = +(entryPrice * 1.15).toFixed(2);
  const tp3   = +(entryPrice * 1.22).toFixed(2);
  const score = t.score ? Number(t.score) : null;
  const today = new Date().toISOString().split('T')[0];

  const props = {
    'Trade':              { title:[{text:{content:`🧪 ${ticker} — ${t.strategy||'Paper'} [SIM]`}}] },
    'Ticker':             { rich_text:[{text:{content:ticker}}] },
    'Strategy':           { select:{name:t.strategy||'Mean Reversion'} },
    'Status':             { select:{name:'Paper'} },
    'Simulation Mode':    { checkbox:true },
    'Rules Followed':     { checkbox:true },
    'Entry Price':        { number:entryPrice },
    'Stop-Loss Price':    { number:stop },
    'TP1':                { number:tp1 },
    'TP2':                { number:tp2 },
    'TP3':                { number:tp3 },
    'Date Opened':        { date:{start:today} },
    'What Went Right':    { rich_text:[{text:{content:t.reasoning||''}}] },
  };
  const REGIME_MAP = {'MEAN REVERSION ZONE':'Mean Reversion Zone','BREAKOUT ZONE':'Breakout Zone','CAUTION ZONE':'Caution Zone','EXTREME FEAR':'Caution Zone'};
  if (score)             props['Composite Score']      = { number:score };
  if (score)             props['Recommendation Score'] = { number:score };
  if (t.regime)          props['Market Regime at Entry']= { select:{name:REGIME_MAP[t.regime.toUpperCase()]||t.regime} };
  if (t.positionPct)     props['Position Size %']      = { number:Number(t.positionPct) };

  try {
    const r = await notionPost('/v1/pages', { parent:{database_id:TRADE_DB}, properties:props }, TOKEN);
    res.json({
      ok: r.status < 300,
      notionId: r.body.id,
      url: r.body.url,
      trade: { ticker, entryPrice, stop, tp1, tp2, tp3, score, date: today }
    });
  } catch(e) { res.status(500).json({error:e.message}); }
};
