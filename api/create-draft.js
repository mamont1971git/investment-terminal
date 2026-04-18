// POST /api/create-draft
// Called by investment skill after generating a BUY recommendation.
// Creates a Draft entry in Notion Trade Journal — waits for user Confirm/Reject.
const https = require('https');
const TRADE_DB = '661bed1034ae4030be88d3ee7d125d42';

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
  return new Promise(resolve => {
    https.get(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${apiKey}`,
      {headers:{'User-Agent':'Mozilla/5.0'},timeout:5000}, res => {
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{ try{ const q=JSON.parse(d); resolve(q&&q.c&&q.c>0?q.c:null); }catch{resolve(null);} });
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
  let t; try{t=JSON.parse(body);}catch{return res.status(400).json({error:'Invalid JSON'});}

  const ticker=(t.ticker||'').toUpperCase();
  if (!ticker) return res.status(400).json({error:'ticker required'});

  // DEDUP: check if Draft/Paper/Open entry already exists for this ticker
  try {
    const checkResult = await notionPost(`/v1/databases/${TRADE_DB}/query`, {
      filter:{and:[
        {property:'Ticker',rich_text:{equals:ticker}},
        {property:'Simulation Mode',checkbox:{equals:true}},
        {or:[{property:'Status',select:{equals:'Draft'}},{property:'Status',select:{equals:'Paper'}},{property:'Status',select:{equals:'Open'}}]}
      ]},page_size:1
    }, TOKEN);
    if (checkResult.body?.results?.length > 0) {
      return res.json({ok:false, error:`${ticker} already has an active Draft or Paper trade`, duplicate:true});
    }
  } catch{}

  // ALWAYS use the live market price — never trust Claude's suggested price
  // Claude's training data has stale prices (e.g., 2025 prices for 2026 trades)
  let entryPrice = null;
  if (ALPHA) entryPrice = await fetchPrice(ticker, ALPHA);
  if (!entryPrice) {
    // API failed — fall back to Claude's suggestion as last resort, but warn
    entryPrice = t.entryPrice ? parseFloat(t.entryPrice) : null;
  }
  if (!entryPrice) return res.status(503).json({error:`Could not fetch live price for ${ticker}. Try again.`});

  const stop=+(entryPrice*0.93).toFixed(2), tp1=+(entryPrice*1.08).toFixed(2),
        tp2=+(entryPrice*1.15).toFixed(2), tp3=+(entryPrice*1.22).toFixed(2);
  const today=new Date().toISOString().split('T')[0];

  // Map regime names from Claude (UPPER CASE) to Notion select options (Title Case)
  const REGIME_MAP = {
    'MEAN REVERSION ZONE': 'Mean Reversion Zone',
    'BREAKOUT ZONE': 'Breakout Zone',
    'CAUTION ZONE': 'Caution Zone',
    'EXTREME FEAR': 'Caution Zone',
  };
  const regimeName = t.regime ? (REGIME_MAP[t.regime.toUpperCase()] || REGIME_MAP[t.regime] || t.regime) : null;

  const props = {
    'Trade':           {title:[{text:{content:`⏳ ${ticker} — ${t.strategy||'Paper'} [DRAFT]`}}]},
    'Ticker':          {rich_text:[{text:{content:ticker}}]},
    'Strategy':        {select:{name:t.strategy||'Mean Reversion'}},
    'Status':          {select:{name:'Draft'}},
    'Simulation Mode': {checkbox:true},
    'Entry Price':     {number:entryPrice},
    'Stop-Loss Price': {number:stop},
    'TP1':             {number:tp1}, 'TP2':{number:tp2}, 'TP3':{number:tp3},
    'Composite Score': {number:t.score?Number(t.score):null},
    'Recommendation Score':{number:t.score?Number(t.score):null},
    'What Went Right': {rich_text:[{text:{content:(t.reasoning||'').slice(0,2000)}}]},
    'Date Opened':     {date:{start:today}},
  };
  if (regimeName)    props['Market Regime at Entry'] = {select:{name:regimeName}};
  if (t.positionPct) props['Position Size %']        = {number:Number(t.positionPct)};

  const r = await notionPost('/v1/pages', { parent:{database_id:TRADE_DB}, properties:props }, TOKEN);

  if (r.status >= 300) {
    const msg = r.body?.message || r.body?.code || JSON.stringify(r.body).slice(0,200);
    return res.json({ok:false, error:`Notion error: ${msg}`, status:r.status});
  }

  res.json({ok:true, notionId:r.body.id, url:r.body.url,
    draft:{ticker,entryPrice,stop,tp1,tp2,tp3,score:t.score,date:today}});
};
