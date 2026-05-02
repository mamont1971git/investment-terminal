// POST /api/execute-queued
// Finds all Queued trades, fetches live prices, and confirms them as Paper trades.
// Called automatically on dashboard load during market hours, or by scheduled task.
const https = require('https');

const TRADE_DB = '661bed1034ae4030be88d3ee7d125d42';
const WALLET_DB = 'f0e0d34f98334542a24081bfe6c80110';

function notionPost(path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.notion.com', path, method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28', 'Content-Length': Buffer.byteLength(data) },
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', reject); req.write(data); req.end();
  });
}

function notionPatch(pageId, props, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ properties: props });
    const req = https.request({
      hostname: 'api.notion.com', path: `/v1/pages/${pageId}`, method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28', 'Content-Length': Buffer.byteLength(data) },
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', reject); req.write(data); req.end();
  });
}

function fetchPrice(ticker, apiKey) {
  return new Promise(resolve => {
    https.get(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${apiKey}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 }, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { const q = JSON.parse(d); resolve(q && q.o && q.o > 0 ? q.o : (q.c > 0 ? q.c : null)); } catch { resolve(null); } });
      }).on('error', () => resolve(null)).on('timeout', function () { this.destroy(); resolve(null); });
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

// Check if US market is currently open (ET timezone)
function isMarketOpen() {
  const now = new Date();
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et = new Date(etStr);
  const day = et.getDay();
  const h = et.getHours(), m = et.getMinutes();
  const mins = h * 60 + m;
  if (day === 0 || day === 6) return false;
  return mins >= 570 && mins < 960; // 9:30 AM - 4:00 PM ET
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const TOKEN = process.env.NOTION_TOKEN;
  const ALPHA = process.env.FINNHUB_KEY;
  if (!TOKEN) return res.status(503).json({ error: 'NOTION_TOKEN not set' });

  // Safety check: only execute during market hours
  if (!isMarketOpen()) {
    return res.json({ ok: true, executed: 0, message: 'Market is closed — queued orders will execute at next open' });
  }

  try {
    // Find all Queued trades
    const queryResult = await notionPost(`/v1/databases/${TRADE_DB}/query`, {
      filter: { property: 'Status', select: { equals: 'Queued' } },
      page_size: 20,
    }, TOKEN);

    const queued = queryResult.results || [];
    if (queued.length === 0) {
      return res.json({ ok: true, executed: 0, message: 'No queued orders' });
    }

    const results = [];

    for (const page of queued) {
      const props = page.properties;
      const pageId = page.id;
      const ticker = props['Ticker']?.rich_text?.[0]?.plain_text || '';
      const strategy = props['Strategy']?.select?.name || '';
      const positionPct = props['Position Size %']?.number;
      const originalEntry = props['Entry Price']?.number;

      // Fetch LIVE price (use open price for morning execution)
      let livePrice = null;
      if (ALPHA && ticker) livePrice = await fetchPrice(ticker, ALPHA);

      if (!livePrice) {
        results.push({ ticker, status: 'skipped', reason: 'Could not fetch live price' });
        continue;
      }

      // Recalculate stops and targets based on live price
      const stop = +(livePrice * 0.93).toFixed(2);
      const tp1 = +(livePrice * 1.08).toFixed(2);
      const tp2 = +(livePrice * 1.15).toFixed(2);
      const tp3 = +(livePrice * 1.22).toFixed(2);

      // Calculate position cost
      let positionCost = 0;
      let shares = 0;
      const walletBalance = await getWalletBalance(TOKEN);
      if (positionPct) {
        positionCost = Math.min(walletBalance, walletBalance * (positionPct / 100) * 2);
        if (positionCost < 1) positionCost = walletBalance * (positionPct / 100);
      } else {
        positionCost = walletBalance * 0.05;
      }
      shares = positionCost / livePrice;

      // Check wallet balance
      if (positionCost > walletBalance + 0.01) {
        results.push({ ticker, status: 'skipped', reason: `Insufficient funds: need $${positionCost.toFixed(2)}, have $${walletBalance.toFixed(2)}` });
        continue;
      }

      // Create wallet BUY transaction
      if (positionCost > 0) {
        const newBalance = +(walletBalance - positionCost).toFixed(2);
        await notionPost('/v1/pages', {
          parent: { database_id: WALLET_DB },
          properties: {
            'Transaction': { title: [{ text: { content: `BUY ${ticker} × ${shares.toFixed(4)} [QUEUED→OPEN]` } }] },
            'Type': { select: { name: 'BUY' } },
            'Ticker': { rich_text: [{ text: { content: ticker } }] },
            'Shares': { number: +shares.toFixed(4) },
            'Price': { number: livePrice },
            'Amount': { number: -positionCost },
            'Balance After': { number: newBalance },
            'Date': { date: { start: new Date().toISOString() } },
            'Trade Link': { relation: [{ id: pageId }] },
          },
        }, TOKEN);
      }

      // Update the trade: set live price, recalculated levels, activate as Paper
      const priceNote = originalEntry !== livePrice
        ? ` [Queued at $${originalEntry}, filled at $${livePrice}]`
        : '';
      await notionPatch(pageId, {
        'Status': { select: { name: 'Paper' } },
        'Simulation Mode': { checkbox: true },
        'Entry Price': { number: livePrice },
        'Stop-Loss Price': { number: stop },
        'TP1': { number: tp1 },
        'TP2': { number: tp2 },
        'TP3': { number: tp3 },
        'Trade': { title: [{ text: { content: `🧪 ${ticker} — ${strategy} [SIM]${priceNote}` } }] },
        'Rules Followed': { checkbox: true },
      }, TOKEN);

      results.push({
        ticker,
        status: 'executed',
        originalEntry,
        livePrice,
        priceDiff: originalEntry ? +((livePrice - originalEntry) / originalEntry * 100).toFixed(2) : null,
        stop, tp1, tp2,
        shares: +shares.toFixed(4),
        cost: +positionCost.toFixed(2),
      });
    }

    const executedCount = results.filter(r => r.status === 'executed').length;
    return res.json({
      ok: true,
      executed: executedCount,
      skipped: results.filter(r => r.status === 'skipped').length,
      total: queued.length,
      results,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
