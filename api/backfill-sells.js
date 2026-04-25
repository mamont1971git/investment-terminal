// GET /api/backfill-sells?execute=true
// One-time endpoint: creates SELL wallet transactions for closed trades that are missing them
// Without ?execute=true, runs in dry-run mode (shows what would be created)
const https = require('https');

const WALLET_DB = 'f0e0d34f98334542a24081bfe6c80110';
const TRADE_DB = '661bed1034ae4030be88d3ee7d125d42';

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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const TOKEN = process.env.NOTION_TOKEN;
  if (!TOKEN) return res.status(503).json({ error: 'NOTION_TOKEN not set' });

  const execute = req.query.execute === 'true';

  // 1. Get all wallet transactions
  const walletData = await notionPost(`/v1/databases/${WALLET_DB}/query`, { page_size: 200 }, TOKEN);
  const walletTxs = walletData?.results || [];

  // Build per-ticker share counts
  const tickerShares = {};
  for (const page of walletTxs) {
    const p = page.properties;
    const type = p?.['Type']?.select?.name;
    const ticker = (p?.['Ticker']?.rich_text?.[0]?.plain_text || '').toUpperCase();
    const shares = p?.['Shares']?.number || 0;
    const amount = p?.['Amount']?.number || 0;
    if (!ticker) continue;
    if (!tickerShares[ticker]) tickerShares[ticker] = { buyShares: 0, sellShares: 0, buyAmount: 0 };
    if (type === 'BUY') {
      tickerShares[ticker].buyShares += shares;
      tickerShares[ticker].buyAmount += Math.abs(amount);
    } else if (type === 'SELL') {
      tickerShares[ticker].sellShares += shares;
    }
  }

  // 2. Get all closed/stopped trades (simulation mode only)
  const closedData = await notionPost(`/v1/databases/${TRADE_DB}/query`, {
    filter: {
      and: [
        { or: [
          { property: 'Status', select: { equals: 'Closed' } },
          { property: 'Status', select: { equals: 'Stopped Out' } },
        ]},
        { property: 'Simulation Mode', checkbox: { equals: true } },
      ]
    },
    page_size: 100,
  }, TOKEN);
  const closedTrades = closedData?.results || [];

  // 3. Find trades needing backfill
  const toBackfill = [];
  for (const trade of closedTrades) {
    const p = trade.properties;
    const ticker = (p?.['Ticker']?.rich_text?.[0]?.plain_text || '').toUpperCase();
    const exitPrice = p?.['Exit Price']?.number;
    const entryPrice = p?.['Entry Price']?.number;
    const dateClosed = p?.['Date Closed']?.date?.start;
    const closeReason = p?.['Close Reason']?.select?.name || 'Manual';

    if (!ticker || !exitPrice) continue;

    const ts = tickerShares[ticker];
    if (!ts || ts.buyShares <= ts.sellShares + 0.0001) continue;

    const sharesToSell = +(ts.buyShares - ts.sellShares).toFixed(4);
    const proceeds = +(sharesToSell * exitPrice).toFixed(2);
    const pnlPct = entryPrice ? +(((exitPrice - entryPrice) / entryPrice) * 100).toFixed(1) : null;

    toBackfill.push({
      ticker, exitPrice, entryPrice, sharesToSell, proceeds, pnlPct,
      tradeId: trade.id, dateClosed, closeReason,
    });

    ts.sellShares += sharesToSell;
  }

  if (!execute) {
    // Dry run — show what would be created
    let currentBalance = 0;
    for (const page of walletTxs) {
      currentBalance += (page.properties?.['Amount']?.number || 0);
    }
    let projectedBalance = currentBalance;
    for (const t of toBackfill) projectedBalance += t.proceeds;

    return res.json({
      mode: 'DRY RUN — add ?execute=true to apply',
      currentBalance: +currentBalance.toFixed(2),
      projectedBalance: +projectedBalance.toFixed(2),
      fundsToRecover: +(projectedBalance - currentBalance).toFixed(2),
      closedTradesFound: closedTrades.length,
      needingBackfill: toBackfill.length,
      details: toBackfill.map(t => ({
        ticker: t.ticker,
        shares: t.sharesToSell,
        exitPrice: t.exitPrice,
        proceeds: t.proceeds,
        pnl: t.pnlPct !== null ? `${t.pnlPct}%` : 'unknown',
        closeReason: t.closeReason,
        dateClosed: t.dateClosed,
      })),
      tickerShares,
    });
  }

  // 4. Execute: create SELL transactions
  let runningBalance = 0;
  for (const page of walletTxs) {
    runningBalance += (page.properties?.['Amount']?.number || 0);
  }
  const startBalance = +runningBalance.toFixed(2);

  const results = [];
  for (const t of toBackfill) {
    runningBalance = +(runningBalance + t.proceeds).toFixed(2);
    const result = await notionPost('/v1/pages', {
      parent: { database_id: WALLET_DB },
      properties: {
        'Transaction': { title: [{ text: { content: `SELL ${t.ticker} × ${t.sharesToSell.toFixed(4)} [BACKFILL]` } }] },
        'Type': { select: { name: 'SELL' } },
        'Ticker': { rich_text: [{ text: { content: t.ticker } }] },
        'Shares': { number: t.sharesToSell },
        'Price': { number: t.exitPrice },
        'Amount': { number: t.proceeds },
        'Balance After': { number: runningBalance },
        'Date': { date: { start: t.dateClosed || new Date().toISOString() } },
        'Trade Link': { relation: [{ id: t.tradeId }] },
      },
    }, TOKEN);

    results.push({
      ticker: t.ticker,
      ok: result?.object !== 'error',
      proceeds: t.proceeds,
      balance: runningBalance,
      error: result?.object === 'error' ? result.message : undefined,
    });

    // Rate limit
    await new Promise(r => setTimeout(r, 350));
  }

  res.json({
    mode: 'EXECUTED',
    startBalance,
    finalBalance: +runningBalance.toFixed(2),
    fundsRecovered: +(runningBalance - startBalance).toFixed(2),
    transactions: results,
  });
};
