// GET /api/check-paper-trades
// Called by evening agent: checks all open paper trades against current prices,
// auto-closes stops/TPs, updates Notion
const https = require('https');

const TRADE_DB = '661bed1034ae4030be88d3ee7d125d42';

function notionGet(path, token) {
  return new Promise((resolve, reject) => {
    https.get(`https://api.notion.com${path}`, {
      headers:{'Authorization':'Bearer '+token,'Notion-Version':'2022-06-28','Content-Type':'application/json'}
    }, res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve(JSON.parse(d)));}).on('error',reject);
  });
}
function notionPatch(pageId, props, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({properties:props});
    const req = https.request({
      hostname:'api.notion.com', path:`/v1/pages/${pageId}`, method:'PATCH',
      headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json','Notion-Version':'2022-06-28','Content-Length':Buffer.byteLength(data)}
    }, res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve(JSON.parse(d)));});
    req.on('error',reject); req.write(data); req.end();
  });
}
function notionQuery(dbId, filter, token) {
  return new Promise((resolve,reject)=>{
    const data=JSON.stringify({filter,page_size:50});
    const req=https.request({
      hostname:'api.notion.com',path:`/v1/databases/${dbId}/query`,method:'POST',
      headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json','Notion-Version':'2022-06-28','Content-Length':Buffer.byteLength(data)}
    },res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve(JSON.parse(d)));});
    req.on('error',reject);req.write(data);req.end();
  });
}
async function getPrice(ticker, apiKey) {
  return new Promise(resolve=>{
    https.get(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${ticker}&apikey=${apiKey}`,
      {headers:{'User-Agent':'Mozilla/5.0'}},
      res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{
        try{const q=JSON.parse(d)['Global Quote'];resolve(q?.['05. price']?parseFloat(q['05. price']):null);}
        catch{resolve(null);}
      });}).on('error',()=>resolve(null));
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  const TOKEN = process.env.NOTION_TOKEN;
  const ALPHA = process.env.ALPHA_VANTAGE_KEY;
  if (!TOKEN||!ALPHA) return res.status(503).json({error:'Missing env vars'});

  // Fetch all open paper trades from Notion
  const result = await notionQuery(TRADE_DB, {
    and:[
      {property:'Simulation Mode',checkbox:{equals:true}},
      {property:'Status',select:{equals:'Paper'}}
    ]
  }, TOKEN);

  const trades = result.results || [];
  const updates = [];
  const today = new Date().toISOString().split('T')[0];

  for (const page of trades) {
    const p = page.properties;
    const ticker      = p['Ticker']?.rich_text?.[0]?.plain_text || p['Trade']?.title?.[0]?.plain_text?.match(/🧪\s*(\w+)/)?.[1];
    const entryPrice  = p['Entry Price']?.number;
    const stopLoss    = p['Stop-Loss Price']?.number;
    const tp1         = p['TP1']?.number;
    const tp2         = p['TP2']?.number;
    const openDate    = p['date:Date Opened:start']?.date?.start || p['Date Opened']?.date?.start;

    if (!ticker || !entryPrice || !stopLoss || !tp1) continue;

    const currentPrice = await getPrice(ticker, ALPHA);
    if (!currentPrice) { updates.push({ticker,error:'price fetch failed'}); continue; }

    const pnlPct = +((currentPrice - entryPrice) / entryPrice * 100).toFixed(2);
    const daysHeld = openDate ? Math.floor((new Date()-new Date(openDate))/86400000) : 0;

    let closeReason = null;
    let newStatus = null;

    if (currentPrice <= stopLoss) {
      closeReason = 'Stopped Out'; newStatus = 'Stopped Out';
    } else if (currentPrice >= tp2) {
      closeReason = 'Hit TP2'; newStatus = 'Closed';
    } else if (currentPrice >= tp1) {
      closeReason = 'Hit TP1'; newStatus = 'Closed';
    } else if (daysHeld >= 10) {
      closeReason = 'Time Stop'; newStatus = 'Closed';
    }

    if (closeReason) {
      const props = {
        'Status':          { select:{name:newStatus} },
        'Exit Price':      { number:currentPrice },
        'P&L %':           { number:pnlPct },
        'Auto Closed':     { checkbox:true },
        'Close Reason':    { select:{name:closeReason} },
        'Days Held':       { number:daysHeld },
        'date:Date Closed:start': today,
      };
      await notionPatch(page.id, props, TOKEN);
      updates.push({ticker,action:'closed',reason:closeReason,entryPrice,exitPrice:currentPrice,pnlPct,daysHeld});
    } else {
      updates.push({ticker,action:'monitoring',currentPrice,pnlPct,daysHeld,status:'open'});
    }
  }

  res.json({checked:trades.length, updates, ts:new Date().toISOString()});
};
