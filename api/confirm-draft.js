// POST /api/confirm-draft
// {notionId, action: 'confirm'|'reject', mode: 'dry-run'|'ibkr'}
// Confirm → changes Status to Paper (dry-run) or routes to IBKR (future)
// Reject  → changes Status to Closed with Close Reason = Manual
const https = require('https');

function notionPatch(pageId, props, token) {
  return new Promise((resolve,reject)=>{
    const data=JSON.stringify({properties:props});
    const req=https.request({
      hostname:'api.notion.com',path:`/v1/pages/${pageId}`,method:'PATCH',
      headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json','Notion-Version':'2022-06-28','Content-Length':Buffer.byteLength(data)}
    },res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve(JSON.parse(d)));});
    req.on('error',reject);req.write(data);req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS') return res.status(200).end();

  const TOKEN = process.env.NOTION_TOKEN;
  if (!TOKEN) return res.status(503).json({error:'NOTION_TOKEN not set'});

  let body=''; req.on('data',c=>body+=c);
  await new Promise(r=>req.on('end',r));
  const {notionId, action, mode} = JSON.parse(body);

  if (!notionId || !action) return res.status(400).json({error:'notionId and action required'});

  if (action === 'reject') {
    // Mark as closed/rejected — remove from drafts
    const r = await notionPatch(notionId, {
      'Status':       {select:{name:'Closed'}},
      'Close Reason': {select:{name:'Manual'}},
      'What Went Wrong': {rich_text:[{text:{content:'Rejected by user at draft stage'}}]},
    }, TOKEN);
    return res.json({ok:r.object!=='error', action:'rejected'});
  }

  if (action === 'confirm') {
    const tradingMode = mode || 'dry-run';

    if (tradingMode === 'ibkr') {
      // 🔮 Future: call /api/place-order.js here
      // For now: return instructional response
      return res.json({
        ok: false,
        action: 'ibkr-not-connected',
        message: 'IBKR integration not yet configured. See Broker Integration Roadmap in Notion. Falling back to Dry Run.',
      });
    }

    // Dry Run: activate the paper trade
    const title = (await notionPatch(notionId, {
      'Status':          {select:{name:'Paper'}},
      'Simulation Mode': {checkbox:true},
      'Trade':           {title:[{text:{content:''}}]}, // will be updated below
    }, TOKEN));

    // Update the title to remove ⏳ and add 🧪
    const ticker = title.properties?.['Ticker']?.rich_text?.[0]?.plain_text || 'TRADE';
    const strategy = title.properties?.['Strategy']?.select?.name || '';
    await notionPatch(notionId, {
      'Trade': {title:[{text:{content:`🧪 ${ticker} — ${strategy} [SIM]`}}]},
    }, TOKEN);

    return res.json({ok:true, action:'confirmed-dry-run', notionId});
  }

  res.status(400).json({error:'Unknown action'});
};
