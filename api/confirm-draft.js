// POST /api/confirm-draft
// {notionId, action: 'confirm'|'reject', mode: 'dry-run'|'ibkr'}
// Confirm → changes Status to Paper (dry-run) or routes to IBKR (future)
// Reject  → changes Status to Closed with Close Reason = Manual
// Now also creates wallet BUY transaction on confirm
const https = require('https');

const WALLET_DB = 'f0e0d34f98334542a24081bfe6c80110';

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

function notionPost(path, body, token) {
  return new Promise((resolve,reject)=>{
    const data=JSON.stringify(body);
    const req=https.request({
      hostname:'api.notion.com',path,method:'POST',
      headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json','Notion-Version':'2022-06-28','Content-Length':Buffer.byteLength(data)}
    },res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve(JSON.parse(d)));});
    req.on('error',reject);req.write(data);req.end();
  });
}

function notionGet(pageId, token) {
  return new Promise((resolve,reject)=>{
    https.get(`https://api.notion.com/v1/pages/${pageId}`,{
      headers:{'Authorization':'Bearer '+token,'Notion-Version':'2022-06-28'}
    },res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve(JSON.parse(d)));})
    .on('error',reject);
  });
}

async function getWalletBalance(token) {
  const result = await notionPost(`/v1/databases/${WALLET_DB}/query`, {
    sorts: [{ property: 'Date', direction: 'ascending' }],
    page_size: 200,
  }, token);
  let cash = 0;
  for (const page of (result.results || [])) {
    cash += (page.properties?.['Amount']?.number || 0);
  }
  return +cash.toFixed(2);
}

async function createWalletBuy(ticker, shares, price, amount, tradeId, token) {
  const balance = await getWalletBalance(token);
  if (Math.abs(amount) > balance + 0.01) {
    return { error: 'INSUFFICIENT_FUNDS', balance, required: Math.abs(amount) };
  }
  const newBalance = +(balance + amount).toFixed(2); // amount is negative for BUY
  const result = await notionPost('/v1/pages', {
    parent: { database_id: WALLET_DB },
    properties: {
      'Transaction': { title: [{ text: { content: `BUY ${ticker} × ${shares.toFixed(4)}` } }] },
      'Type': { select: { name: 'BUY' } },
      'Ticker': { rich_text: [{ text: { content: ticker } }] },
      'Shares': { number: +shares.toFixed(4) },
      'Price': { number: price },
      'Amount': { number: amount },
      'Balance After': { number: newBalance },
      'Date': { date: { start: new Date().toISOString().split('T')[0] } },
      'Trade Link': { relation: [{ id: tradeId }] },
    },
  }, token);
  return { ok: result.object !== 'error', newBalance, walletTxId: result.id };
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

    // Dry Run: activate the paper trade + deduct from wallet
    // First, read the draft to get entry price and position size
    const draft = await notionGet(notionId, TOKEN);
    const ticker = draft.properties?.['Ticker']?.rich_text?.[0]?.plain_text || 'TRADE';
    const strategy = draft.properties?.['Strategy']?.select?.name || '';
    const entryPrice = draft.properties?.['Entry Price']?.number;
    const positionPct = draft.properties?.['Position Size %']?.number;

    // Calculate position cost and shares
    let positionCost = 0;
    let shares = 0;
    if (entryPrice && positionPct) {
      // Get wallet total value to compute dollar amount from percentage
      const walletBalance = await getWalletBalance(TOKEN);
      // Use a conservative estimate: positionPct of (cash + invested)
      // For simplicity, use absolute dollar amounts based on wallet cash
      positionCost = Math.min(walletBalance, walletBalance * (positionPct / 100) * 2); // rough
      if (positionCost < 1) positionCost = walletBalance * (positionPct / 100);
      shares = positionCost / entryPrice;
    } else if (entryPrice) {
      // Fallback: use 5% of wallet
      const walletBalance = await getWalletBalance(TOKEN);
      positionCost = walletBalance * 0.05;
      shares = positionCost / entryPrice;
    }

    // Create wallet BUY transaction (enforce balance check)
    if (positionCost > 0 && entryPrice) {
      const walletResult = await createWalletBuy(ticker, shares, entryPrice, -positionCost, notionId, TOKEN);
      if (walletResult.error === 'INSUFFICIENT_FUNDS') {
        return res.json({
          ok: false,
          action: 'wallet-blocked',
          message: `Insufficient funds: need $${walletResult.required.toFixed(2)} but only $${walletResult.balance.toFixed(2)} available`,
          balance: walletResult.balance,
          required: walletResult.required,
        });
      }
    }

    // Activate the paper trade
    await notionPatch(notionId, {
      'Status':          {select:{name:'Paper'}},
      'Simulation Mode': {checkbox:true},
      'Trade':           {title:[{text:{content:`🧪 ${ticker} — ${strategy} [SIM]`}}]},
      'Rules Followed':  {checkbox:true},
    }, TOKEN);

    return res.json({ok:true, action:'confirmed-dry-run', notionId, walletDeducted: positionCost > 0 ? +positionCost.toFixed(2) : 0});
  }

  res.status(400).json({error:'Unknown action'});
};
