// POST /api/close-position
// Closes a paper trade in Notion: sets exit price, P&L, close reason, date
// Creates a SELL wallet transaction to return funds to the virtual wallet
// Used by dashboard Take Profit / Exit / Tighten Stop actions
const https = require('https');

const WALLET_DB = 'f0e0d34f98334542a24081bfe6c80110';

function notionPatch(pageId, props, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ properties: props });
    const req = https.request({
      hostname: 'api.notion.com', path: `/v1/pages/${pageId}`, method: 'PATCH',
      headers: {
        'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28', 'Content-Length': Buffer.byteLength(data),
      },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: 500, body: {} }); } });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

async function getPrice(ticker, apiKey) {
  return new Promise(resolve => {
    https.get(
      `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${apiKey}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 },
      res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const q = JSON.parse(d);
            resolve(q && q.c && q.c > 0 ? q.c : null);
          } catch { resolve(null); }
        });
      }
    ).on('error', () => resolve(null)).on('timeout', function () { this.destroy(); resolve(null); });
  });
}

// ── Wallet helpers ──────────────────────────────────────────────────
function notionPost(path, body, token) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.notion.com', path, method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28', 'Content-Length': Buffer.byteLength(data) },
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } }); });
    req.on('error', () => resolve(null)); req.write(data); req.end();
  });
}

async function getWalletBalance(token) {
  const result = await notionPost(`/v1/databases/${WALLET_DB}/query`, {
    sorts: [{ property: 'Date', direction: 'ascending' }],
    page_size: 200,
  }, token);
  let cash = 0;
  for (const page of (result?.results || [])) {
    cash += (page.properties?.['Amount']?.number || 0);
  }
  return +cash.toFixed(2);
}

function getWalletShares(results, ticker) {
  // Sum shares from BUY transactions, subtract SELL transactions for this ticker
  let shares = 0;
  for (const page of (results || [])) {
    const p = page.properties;
    const type = p?.['Type']?.select?.name;
    const t = (p?.['Ticker']?.rich_text?.[0]?.plain_text || '').toUpperCase();
    if (t !== ticker) continue;
    const s = p?.['Shares']?.number || 0;
    if (type === 'BUY') shares += s;
    else if (type === 'SELL') shares -= s;
  }
  return +shares.toFixed(4);
}

async function createWalletSell(ticker, shares, price, amount, tradeId, token) {
  const balance = await getWalletBalance(token);
  const newBalance = +(balance + amount).toFixed(2); // amount is positive for SELL
  const result = await notionPost('/v1/pages', {
    parent: { database_id: WALLET_DB },
    properties: {
      'Transaction': { title: [{ text: { content: `SELL ${ticker} × ${shares.toFixed(4)}` } }] },
      'Type': { select: { name: 'SELL' } },
      'Ticker': { rich_text: [{ text: { content: ticker } }] },
      'Shares': { number: +shares.toFixed(4) },
      'Price': { number: price },
      'Amount': { number: +amount.toFixed(2) },
      'Balance After': { number: newBalance },
      'Date': { date: { start: new Date().toISOString() } },
      'Trade Link': { relation: [{ id: tradeId }] },
    },
  }, token);
  return { ok: result?.object !== 'error', newBalance, walletTxId: result?.id };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const TOKEN = process.env.NOTION_TOKEN;
  const ALPHA = process.env.FINNHUB_KEY;
  if (!TOKEN) return res.status(503).json({ error: 'NOTION_TOKEN not set' });

  let body = ''; req.on('data', c => body += c);
  await new Promise(r => req.on('end', r));
  let t;
  try { t = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  const { notionId, action, ticker, entryPrice, decisionReason, decisionRule } = t;
  if (!notionId) return res.status(400).json({ error: 'notionId required' });

  const today = new Date().toISOString();

  // Fetch live price if available
  let currentPrice = t.exitPrice ? parseFloat(t.exitPrice) : null;
  if (!currentPrice && ticker && ALPHA) {
    currentPrice = await getPrice(ticker, ALPHA);
  }

  // Calculate P&L
  const entry = entryPrice ? parseFloat(entryPrice) : null;
  const pnlPct = (currentPrice && entry) ? +((currentPrice - entry) / entry * 100).toFixed(2) : null;
  const daysHeld = t.dateOpened
    ? Math.floor((Date.now() - new Date(t.dateOpened).getTime()) / 86400000)
    : null;

  // Determine close reason and status based on action
  let closeReason, status;
  switch (action) {
    case 'take_profit_1':
      closeReason = 'Hit TP1'; status = 'Closed'; break;
    case 'take_profit_2':
      closeReason = 'Hit TP2'; status = 'Closed'; break;
    case 'take_profit_3':
      closeReason = 'Hit TP3'; status = 'Closed'; break;
    case 'exit_now':
      closeReason = 'Manual'; status = 'Closed'; break;
    case 'stopped_out':
      closeReason = 'Stopped Out'; status = 'Stopped Out'; break;
    case 'time_stop':
      closeReason = 'Time Stop'; status = 'Closed'; break;
    default:
      closeReason = 'Manual'; status = 'Closed';
  }

  const props = {
    'Status': { select: { name: status } },
    'Close Reason': { select: { name: closeReason } },
    'Date Closed': { date: { start: today } },
  };
  if (currentPrice) props['Exit Price'] = { number: currentPrice };
  if (pnlPct !== null) props['P&L %'] = { number: pnlPct };
  if (daysHeld !== null) props['Days Held'] = { number: daysHeld };

  // Record the system's decision reasoning — full audit trail
  if (decisionReason) {
    props['What Went Right'] = {
      rich_text: [{ text: { content: `SYSTEM DECISION (${today}): ${decisionReason}`.slice(0, 2000) } }]
    };
  }

  // Update title to show closed status
  const emoji = pnlPct > 0 ? '✅' : '❌';
  if (ticker) {
    const strategy = t.strategy || '';
    props['Trade'] = { title: [{ text: { content: `${emoji} ${ticker} — ${strategy} [${closeReason}]` } }] };
  }

  try {
    const r = await notionPatch(notionId, props, TOKEN);
    if (r.status >= 300) {
      const msg = r.body?.message || JSON.stringify(r.body).slice(0, 200);
      return res.json({ ok: false, error: `Notion error: ${msg}` });
    }
    // ── Create SELL wallet transaction to return funds ──
    let walletResult = null;
    if (ticker && currentPrice && action !== 'tighten_stop') {
      try {
        // Look up how many shares we hold from wallet transactions
        const walletData = await notionPost(`/v1/databases/${WALLET_DB}/query`, {
          filter: { property: 'Ticker', rich_text: { equals: ticker } },
          page_size: 50,
        }, TOKEN);
        const shares = getWalletShares(walletData?.results, ticker);
        if (shares > 0) {
          const sellProceeds = +(shares * currentPrice).toFixed(2);
          walletResult = await createWalletSell(ticker, shares, currentPrice, sellProceeds, notionId, TOKEN);
        }
      } catch (walletErr) {
        // Don't fail the close if wallet tx fails — log but continue
        console.error('Wallet SELL failed:', walletErr.message);
      }
    }

    res.json({
      ok: true,
      closed: {
        ticker, action, closeReason, status,
        exitPrice: currentPrice, entryPrice: entry,
        pnlPct, daysHeld, date: today,
        walletSell: walletResult ? { proceeds: +(walletResult.newBalance || 0), txId: walletResult.walletTxId } : null,
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
