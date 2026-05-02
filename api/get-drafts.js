// GET /api/get-drafts — returns all Draft status trades for the Order Panel
const https = require('https');
const TRADE_DB = '661bed1034ae4030be88d3ee7d125d42';

function notionQuery(token) {
  return new Promise((resolve,reject)=>{
    const data=JSON.stringify({filter:{or:[
      {property:'Status',select:{equals:'Draft'}},
      {property:'Status',select:{equals:'Queued'}},
    ]},page_size:20});
    const req=https.request({
      hostname:'api.notion.com',path:`/v1/databases/${TRADE_DB}/query`,method:'POST',
      headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json','Notion-Version':'2022-06-28','Content-Length':Buffer.byteLength(data)}
    },res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve(JSON.parse(d)));});
    req.on('error',reject);req.write(data);req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control','no-cache');
  const TOKEN = process.env.NOTION_TOKEN;
  if (!TOKEN) return res.status(503).json({error:'NOTION_TOKEN not set'});
  try {
    const result = await notionQuery(TOKEN);
    const drafts = (result.results||[]).map(p=>({
      id: p.id,
      status: p.properties['Status']?.select?.name || 'Draft',
      ticker: p.properties['Ticker']?.rich_text?.[0]?.plain_text || '',
      strategy: p.properties['Strategy']?.select?.name || '',
      entryPrice: p.properties['Entry Price']?.number,
      stop: p.properties['Stop-Loss Price']?.number,
      tp1: p.properties['TP1']?.number,
      tp2: p.properties['TP2']?.number,
      score: p.properties['Composite Score']?.number,
      reasoning: p.properties['What Went Right']?.rich_text?.[0]?.plain_text || '',
      regime: p.properties['Market Regime at Entry']?.select?.name || '',
      positionPct: p.properties['Position Size %']?.number,
      date: p.properties['date:Date Opened:start']?.date?.start || '',
    }));
    res.json({drafts, count:drafts.length});
  } catch(e) { res.status(500).json({error:e.message}); }
};
