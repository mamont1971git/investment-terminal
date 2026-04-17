// GET /api/get-positions
// Returns all open paper trades from Notion with live price + P&L
// Also returns closed trades for portfolio stats
// Uses Finnhub API (60 calls/min free) for live prices and OHLCV candles
const https = require('https');
let computeAll;
try { computeAll = require('./_lib/indicators').computeAll; } catch { computeAll = null; }
let computeSourceWeights, computePortfolioMetrics;
try {
  const sw = require('./_lib/signal-weights');
  computeSourceWeights = sw.computeSourceWeights;
  computePortfolioMetrics = sw.computePortfolioMetrics;
} catch { computeSourceWeights = null; computePortfolioMetrics = null; }
let runDiagnostics;
try { runDiagnostics = require('./_lib/diagnostics').runDiagnostics; } catch { runDiagnostics = null; }

const TRADE_DB = '661bed1034ae4030be88d3ee7d125d42';
const WALLET_DB = 'f0e0d34f98334542a24081bfe6c80110';
const TUNING_DB = 'c326714ad2b748878e94c473760c97e3';

function notionQuery(filter, sorts, token, pageSize=50) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ filter, sorts, page_size: pageSize });
    const req = https.request({
      hostname: 'api.notion.com', path: `/v1/databases/${TRADE_DB}/query`, method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28', 'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ results: [] }); } });
    });
    req.on('error', () => resolve({ results: [] }));
    req.write(body); req.end();
  });
}

function fetchOHLCV(ticker, apiKey) {
  return new Promise(resolve => {
    const to = Math.floor(Date.now() / 1000);
    const from = to - 120 * 86400; // ~120 days of daily candles
    const url = `https://finnhub.io/api/v1/stock/candle?symbol=${ticker}&resolution=D&from=${from}&to=${to}&token=${apiKey}`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(d);
          if (json.s !== 'ok' || !json.c || !json.c.length) { resolve(null); return; }
          const bars = json.t.map((ts, i) => ({
            date: new Date(ts * 1000).toISOString().split('T')[0],
            open: json.o[i], high: json.h[i], low: json.l[i],
            close: json.c[i], volume: json.v[i],
          }));
          resolve(bars);
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null)).on('timeout', function() { this.destroy(); resolve(null); });
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
    ).on('error', () => resolve(null)).on('timeout', function() { this.destroy(); resolve(null); });
  });
}

function formatTrade(page) {
  const p = page.properties;
  return {
    id: page.id,
    url: page.url,
    title: p['Trade']?.title?.[0]?.plain_text || '',
    ticker: p['Ticker']?.rich_text?.[0]?.plain_text || '',
    strategy: p['Strategy']?.select?.name || '',
    status: p['Status']?.select?.name || '',
    entryPrice: p['Entry Price']?.number,
    exitPrice: p['Exit Price']?.number,
    stopLoss: p['Stop-Loss Price']?.number,
    tp1: p['TP1']?.number,
    tp2: p['TP2']?.number,
    tp3: p['TP3']?.number,
    score: p['Composite Score']?.number,
    pnlPct: p['P&L %']?.number,
    positionPct: p['Position Size %']?.number,
    rulesFollowed: p['Rules Followed']?.checkbox,
    sim: p['Simulation Mode']?.checkbox,
    regime: p['Market Regime at Entry']?.select?.name || '',
    closeReason: p['Close Reason']?.select?.name || '',
    daysHeld: p['Days Held']?.number,
    dateOpened: p['Date Opened']?.date?.start || '',
    dateClosed: p['Date Closed']?.date?.start || '',
    right: p['What Went Right']?.rich_text?.[0]?.plain_text || '',
    wrong: p['What Went Wrong']?.rich_text?.[0]?.plain_text || '',
    lesson: p['Lesson Learned']?.rich_text?.[0]?.plain_text || '',
    signalSources: (p['Signal Sources']?.multi_select || []).map(s => s.name),
    signalAttribution: (() => {
      try { return JSON.parse(p['Signal Attribution']?.rich_text?.[0]?.plain_text || 'null'); } catch { return null; }
    })(),
  };
}

// ── Sync: normalize open trades to current schema ───────────────────────
function notionPatch(pageId, props, token) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ properties: props });
    const req = https.request({
      hostname: 'api.notion.com', path: `/v1/pages/${pageId}`, method: 'PATCH',
      headers: {
        'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28', 'Content-Length': Buffer.byteLength(data),
      },
    }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{
      try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: 500 }); }
    });});
    req.on('error', () => resolve({ status: 500 })); req.write(data); req.end();
  });
}

// ── Wallet helpers ─────────────────────────────────────────────────────
function walletQuery(token, pageSize=100) {
  return notionQuery(
    undefined, // no filter — get all transactions
    [{ property: 'Date', direction: 'ascending' }],
    token, pageSize
  );
}

// Override notionQuery to support no-filter queries for wallet
function notionQueryDB(dbId, filter, sorts, token, pageSize=50) {
  return new Promise((resolve, reject) => {
    const payload = { sorts, page_size: pageSize };
    if (filter) payload.filter = filter;
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.notion.com', path: `/v1/databases/${dbId}/query`, method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28', 'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ results: [] }); } });
    });
    req.on('error', () => resolve({ results: [] }));
    req.write(body); req.end();
  });
}

function formatWalletTx(page) {
  const p = page.properties;
  return {
    id: page.id,
    transaction: p['Transaction']?.title?.[0]?.plain_text || '',
    type: p['Type']?.select?.name || '',
    ticker: p['Ticker']?.rich_text?.[0]?.plain_text || '',
    shares: p['Shares']?.number,
    price: p['Price']?.number,
    amount: p['Amount']?.number,
    balanceAfter: p['Balance After']?.number,
    date: p['Date']?.date?.start || '',
  };
}

function computeWalletState(transactions) {
  // Sort by date, then by amount (deposits first)
  const sorted = [...transactions].sort((a, b) => {
    const d = (a.date || '').localeCompare(b.date || '');
    if (d !== 0) return d;
    return (b.amount || 0) - (a.amount || 0); // deposits (positive) first
  });

  let cashBalance = 0;
  const holdings = {}; // ticker -> { shares, avgCost }

  for (const tx of sorted) {
    if (tx.type === 'DEPOSIT' || tx.type === 'DIVIDEND') {
      cashBalance += (tx.amount || 0);
    } else if (tx.type === 'BUY') {
      cashBalance += (tx.amount || 0); // amount is negative for buys
      const ticker = tx.ticker;
      if (ticker) {
        if (!holdings[ticker]) holdings[ticker] = { shares: 0, totalCost: 0 };
        holdings[ticker].shares += (tx.shares || 0);
        holdings[ticker].totalCost += Math.abs(tx.amount || 0);
      }
    } else if (tx.type === 'SELL') {
      cashBalance += (tx.amount || 0); // amount is positive for sells
      const ticker = tx.ticker;
      if (ticker && holdings[ticker]) {
        holdings[ticker].shares -= (tx.shares || 0);
        // Reduce cost basis proportionally
        if (holdings[ticker].shares <= 0) {
          delete holdings[ticker];
        } else {
          const ratio = holdings[ticker].shares / (holdings[ticker].shares + (tx.shares || 0));
          holdings[ticker].totalCost *= ratio;
        }
      }
    } else if (tx.type === 'WITHDRAWAL') {
      cashBalance += (tx.amount || 0); // negative
    }
  }

  // Compute avg cost per share
  const holdingSummary = {};
  for (const [ticker, h] of Object.entries(holdings)) {
    if (h.shares > 0) {
      holdingSummary[ticker] = {
        shares: +h.shares.toFixed(4),
        avgCost: +(h.totalCost / h.shares).toFixed(2),
        totalCost: +h.totalCost.toFixed(2),
      };
    }
  }

  const totalInvested = Object.values(holdingSummary).reduce((s, h) => s + h.totalCost, 0);

  return {
    cashBalance: +cashBalance.toFixed(2),
    totalInvested: +totalInvested.toFixed(2),
    totalValue: +(cashBalance + totalInvested).toFixed(2), // at cost; live value computed later
    holdings: holdingSummary,
    transactionCount: sorted.length,
  };
}

function createWalletTx(tx, balanceAfter, token) {
  return new Promise((resolve, reject) => {
    const props = {
      'Transaction': { title: [{ text: { content: tx.transaction } }] },
      'Type': { select: { name: tx.type } },
      'Amount': { number: tx.amount },
      'Balance After': { number: balanceAfter },
    };
    if (tx.ticker) props['Ticker'] = { rich_text: [{ text: { content: tx.ticker } }] };
    if (tx.shares) props['Shares'] = { number: tx.shares };
    if (tx.price) props['Price'] = { number: tx.price };
    if (tx.date) props['Date'] = { date: { start: tx.date } };
    if (tx.tradeLink) props['Trade Link'] = { relation: [{ id: tx.tradeLink }] };

    const body = JSON.stringify({ parent: { database_id: WALLET_DB }, properties: props });
    const req = https.request({
      hostname: 'api.notion.com', path: '/v1/pages', method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28', 'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.write(body); req.end();
  });
}

function buildSyncFixes(trade) {
  const fixes = {};
  const ticker = trade.ticker;
  const strategy = trade.strategy || 'Paper';
  const expectedTitle = `🧪 ${ticker} — ${strategy} [SIM]`;
  if (trade.title !== expectedTitle) fixes['Trade'] = { title: [{ text: { content: expectedTitle } }] };
  if (trade.status !== 'Paper') fixes['Status'] = { select: { name: 'Paper' } };
  if (!trade.sim) fixes['Simulation Mode'] = { checkbox: true };
  if (!trade.rulesFollowed) fixes['Rules Followed'] = { checkbox: true };
  if (trade.entryPrice && !trade.tp1) fixes['TP1'] = { number: +(trade.entryPrice * 1.08).toFixed(2) };
  if (trade.entryPrice && !trade.tp2) fixes['TP2'] = { number: +(trade.entryPrice * 1.15).toFixed(2) };
  if (trade.entryPrice && !trade.tp3) fixes['TP3'] = { number: +(trade.entryPrice * 1.22).toFixed(2) };
  if (trade.entryPrice && !trade.stopLoss) fixes['Stop-Loss Price'] = { number: +(trade.entryPrice * 0.93).toFixed(2) };
  return fixes;
}

async function handleSync(token, res) {
  const [paperResult, openResult] = await Promise.all([
    notionQuery(
      { and: [{ property: 'Status', select: { equals: 'Paper' } }, { property: 'Simulation Mode', checkbox: { equals: true } }] },
      [{ timestamp: 'created_time', direction: 'descending' }], token, 100
    ),
    notionQuery(
      { and: [{ property: 'Status', select: { equals: 'Open' } }, { property: 'Simulation Mode', checkbox: { equals: false } }] },
      [{ timestamp: 'created_time', direction: 'descending' }], token, 20
    ),
  ]);
  const allTrades = [...(paperResult.results||[]), ...(openResult.results||[])].map(formatTrade);
  const synced = [], skipped = [], errors = [];

  for (const trade of allTrades) {
    if (!trade.ticker) { skipped.push({ id: trade.id, reason: 'No ticker' }); continue; }
    const fixes = buildSyncFixes(trade);
    if (!Object.keys(fixes).length) { skipped.push({ ticker: trade.ticker, reason: 'Up to date' }); continue; }
    try {
      const r = await notionPatch(trade.id, fixes, token);
      if (r.status < 300) synced.push({ ticker: trade.ticker, fixes: Object.keys(fixes) });
      else errors.push({ ticker: trade.ticker, error: r.body?.message || 'Unknown' });
    } catch (e) { errors.push({ ticker: trade.ticker, error: e.message }); }
    await new Promise(r => setTimeout(r, 350));
  }
  return res.json({ ok: true, total: allTrades.length, synced: synced.length, skipped: skipped.length, errors: errors.length, details: { synced, skipped, errors } });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-cache');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const TOKEN = process.env.NOTION_TOKEN;
  const ALPHA = process.env.FINNHUB_KEY;
  if (!TOKEN) return res.status(503).json({ error: 'NOTION_TOKEN not set' });

  // POST = sync positions OR wallet transaction
  if (req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    await new Promise(r => req.on('end', r));
    let parsed;
    try { parsed = JSON.parse(body); } catch { parsed = {}; }

    // Route: wallet transaction
    if (parsed.action === 'wallet_tx') {
      const tx = parsed.tx;
      if (!tx || !tx.type || !tx.amount) return res.status(400).json({ error: 'tx.type and tx.amount required' });
      // Get current wallet state to compute new balance
      const walletResult = await notionQueryDB(WALLET_DB, undefined,
        [{ property: 'Date', direction: 'ascending' }], TOKEN, 200);
      const transactions = (walletResult.results || []).map(formatWalletTx);
      const walletState = computeWalletState(transactions);

      // Enforce balance check for BUY
      if (tx.type === 'BUY') {
        const cost = Math.abs(tx.amount);
        if (cost > walletState.cashBalance) {
          return res.status(400).json({
            error: 'INSUFFICIENT_FUNDS',
            message: `Need $${cost.toFixed(2)} but only $${walletState.cashBalance.toFixed(2)} available`,
            cashBalance: walletState.cashBalance,
            required: cost,
          });
        }
      }

      const newBalance = +(walletState.cashBalance + tx.amount).toFixed(2);
      const result = await createWalletTx(tx, newBalance, TOKEN);
      if (!result || result.object === 'error') {
        return res.status(500).json({ error: 'Failed to create wallet transaction', detail: result });
      }
      return res.json({ ok: true, walletTx: result.id, newBalance, walletState: { ...walletState, cashBalance: newBalance } });
    }

    // Route: write tuning recommendation to Notion Tuning Log
    if (parsed.action === 'tuning_log') {
      const rec = parsed.rec;
      if (!rec || !rec.title) return res.status(400).json({ error: 'rec.title required' });
      const today = new Date().toISOString().split('T')[0];
      const props = {
        'Recommendation': { title: [{ text: { content: rec.title } }] },
        'Category': { select: { name: rec.category || 'scoring' } },
        'Status': { select: { name: 'Approved' } },
        'Priority': { select: { name: rec.severity === 'critical' ? 'Critical' : rec.severity === 'high' ? 'High' : rec.severity === 'medium' ? 'Medium' : 'Low' } },
        'Evidence': { rich_text: [{ text: { content: (rec.evidence || '').slice(0, 2000) } }] },
        'Expected Impact': { rich_text: [{ text: { content: (rec.expectedImpact || '').slice(0, 2000) } }] },
        'Parameter Before': { rich_text: [{ text: { content: (rec.paramBefore || '').slice(0, 2000) } }] },
        'Parameter After': { rich_text: [{ text: { content: (rec.paramAfter || '').slice(0, 2000) } }] },
        'Date Proposed': { date: { start: today } },
        'Trades Analyzed': { number: rec.tradesAnalyzed || 0 },
        'Confidence': { select: { name: rec.confidence === 'high' ? 'High' : rec.confidence === 'medium' ? 'Medium' : 'Low' } },
      };
      const body = JSON.stringify({ parent: { database_id: TUNING_DB }, properties: props });
      return new Promise(resolve => {
        const req = https.request({
          hostname: 'api.notion.com', path: '/v1/pages', method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json',
            'Notion-Version': '2022-06-28', 'Content-Length': Buffer.byteLength(body),
          },
        }, response => {
          let d = ''; response.on('data', c => d += c);
          response.on('end', () => {
            try {
              const r = JSON.parse(d);
              if (response.statusCode < 300) {
                resolve(res.json({ ok: true, tuningId: r.id }));
              } else {
                resolve(res.status(400).json({ error: r.message || 'Failed to create tuning entry', detail: r }));
              }
            } catch { resolve(res.status(500).json({ error: 'Parse error' })); }
          });
        });
        req.on('error', () => resolve(res.status(500).json({ error: 'Network error' })));
        req.write(body); req.end();
      });
    }

    // Route: sync positions (existing)
    return handleSync(TOKEN, res);
  }

  // Fetch open paper trades + recent closed + wallet in parallel
  const [openResult, closedResult, walletResult] = await Promise.all([
    notionQuery(
      { and: [
        { property: 'Simulation Mode', checkbox: { equals: true } },
        { or: [
          { property: 'Status', select: { equals: 'Paper' } },
          { property: 'Status', select: { equals: 'Open' } },
        ]}
      ]},
      [{ timestamp: 'created_time', direction: 'descending' }],
      TOKEN, 20
    ),
    notionQuery(
      { and: [
        { property: 'Simulation Mode', checkbox: { equals: true } },
        { or: [
          { property: 'Status', select: { equals: 'Closed' } },
          { property: 'Status', select: { equals: 'Stopped Out' } },
        ]}
      ]},
      [{ timestamp: 'created_time', direction: 'descending' }],
      TOKEN, 50
    ),
    notionQueryDB(WALLET_DB, undefined,
      [{ property: 'Date', direction: 'ascending' }], TOKEN, 200
    ),
  ]);

  const openTrades = (openResult.results || []).map(formatTrade);
  const closedTrades = (closedResult.results || []).map(formatTrade);

  // Compute wallet state
  const walletTransactions = (walletResult.results || []).map(formatWalletTx);
  const wallet = computeWalletState(walletTransactions);

  // Fetch live prices for open trades (respect Alpha Vantage rate limit)
  const uniqueTickers = [...new Set(openTrades.map(t => t.ticker).filter(Boolean))];
  const prices = {};

  // Fetch OHLCV for TA indicators — no ticker limit (Finnhub: 60 calls/min)
  const taData = {};
  if (ALPHA && computeAll && uniqueTickers.length > 0) {
    for (const ticker of uniqueTickers) {
      try {
        const bars = await fetchOHLCV(ticker, ALPHA);
        if (bars && bars.length >= 30) taData[ticker] = computeAll(bars);
      } catch {}
      if (uniqueTickers.length > 1) await new Promise(r => setTimeout(r, 250));
    }
    // Fetch price-only for any tickers where OHLCV failed
    const remaining = uniqueTickers.filter(t => !taData[t]);
    for (const ticker of remaining) {
      prices[ticker] = await getPrice(ticker, ALPHA);
      if (remaining.length > 1) await new Promise(r => setTimeout(r, 250));
    }
  } else if (ALPHA && uniqueTickers.length > 0) {
    // No TA engine: just fetch prices for all
    for (const ticker of uniqueTickers) {
      prices[ticker] = await getPrice(ticker, ALPHA);
      if (uniqueTickers.length > 1) await new Promise(r => setTimeout(r, 250));
    }
  }

  // Enrich open trades with live data + TA
  const positions = openTrades.map(t => {
    const ta = taData[t.ticker];
    const currentPrice = ta?.price || prices[t.ticker] || null;
    const livePnlPct = currentPrice && t.entryPrice
      ? +((currentPrice - t.entryPrice) / t.entryPrice * 100).toFixed(2)
      : null;
    const daysHeld = t.dateOpened
      ? Math.floor((Date.now() - new Date(t.dateOpened).getTime()) / 86400000)
      : 0;

    // Derive recommendation
    let recommendation = 'HOLD';
    let urgency = 'ok';
    if (currentPrice && t.stopLoss && currentPrice <= t.stopLoss * 1.02) {
      recommendation = 'EXIT_NOW'; urgency = 'urgent';
    } else if (currentPrice && t.tp1 && currentPrice >= t.tp1) {
      recommendation = 'TAKE_PROFIT'; urgency = 'watch';
    } else if (daysHeld >= 8) {
      recommendation = 'TIGHTEN_STOP'; urgency = 'watch';
    }

    // Extract key TA indicators for the dashboard
    const indicators = ta ? {
      rsi2: ta.rsi2,
      rsi14: ta.rsi14,
      macd: ta.macd ? { histogram: ta.macd.histogram, crossover: ta.macd.crossover } : null,
      bollingerPctB: ta.bollingerBands?.pctB,
      atr: ta.atr ? { value: ta.atr.atr, pct: ta.atr.atrPct } : null,
      zScore: ta.zScore?.zScore,
      zInterpretation: ta.zScore?.interpretation,
      obv: ta.obv ? { trend: ta.obv.trend, divergence: ta.obv.divergence } : null,
      stochastic: ta.stochastic ? { k: ta.stochastic.k, signal: ta.stochastic.signal } : null,
      volumeRatio: ta.volume?.ratio,
      emaAlignment: ta.emaAlignment?.alignment,
      fibSupport: ta.fibonacci?.nearestSupport?.price,
      fibResistance: ta.fibonacci?.nearestResistance?.price,
      signals: ta._summary || [],
    } : null;

    // ALERT if we can't get a price for an active holding
    const priceAlert = !currentPrice ? {
      level: 'critical',
      message: `⚠️ PRICE UNAVAILABLE for ${t.ticker} — cannot calculate P&L, stop-loss, or take-profit. Check Alpha Vantage API or ticker symbol.`,
    } : null;

    return {
      ...t,
      currentPrice,
      livePnlPct,
      daysHeld,
      recommendation: !currentPrice ? 'CHECK_PRICE' : recommendation,
      urgency: !currentPrice ? 'urgent' : urgency,
      indicators,
      priceAlert,
    };
  });

  // Calculate portfolio stats from closed trades
  const winners = closedTrades.filter(t => t.pnlPct > 0);
  const losers = closedTrades.filter(t => t.pnlPct != null && t.pnlPct <= 0);
  const totalClosed = closedTrades.filter(t => t.pnlPct != null);
  const stats = {
    totalTrades: totalClosed.length,
    openCount: positions.length,
    winRate: totalClosed.length ? Math.round(winners.length / totalClosed.length * 100) : 0,
    avgWin: winners.length ? +(winners.reduce((s, t) => s + t.pnlPct, 0) / winners.length).toFixed(2) : 0,
    avgLoss: losers.length ? +(losers.reduce((s, t) => s + t.pnlPct, 0) / losers.length).toFixed(2) : 0,
    totalPnl: +totalClosed.reduce((s, t) => s + (t.pnlPct || 0), 0).toFixed(2),
    rulesCompliance: closedTrades.length
      ? Math.round(closedTrades.filter(t => t.rulesFollowed).length / closedTrades.length * 100)
      : 100,
    bestTrade: winners.sort((a, b) => b.pnlPct - a.pnlPct)[0] || null,
    worstTrade: losers.sort((a, b) => a.pnlPct - b.pnlPct)[0] || null,
  };

  // Enrich wallet with live portfolio value
  const livePortfolioValue = positions.reduce((sum, p) => {
    const h = wallet.holdings[p.ticker];
    if (h && p.currentPrice) return sum + (h.shares * p.currentPrice);
    if (h) return sum + h.totalCost; // fallback to cost basis
    return sum;
  }, 0);

  const walletSummary = {
    ...wallet,
    livePortfolioValue: +livePortfolioValue.toFixed(2),
    totalLiveValue: +(wallet.cashBalance + livePortfolioValue).toFixed(2),
    unrealizedPnl: +(livePortfolioValue - wallet.totalInvested).toFixed(2),
    unrealizedPnlPct: wallet.totalInvested > 0
      ? +((livePortfolioValue - wallet.totalInvested) / wallet.totalInvested * 100).toFixed(2)
      : 0,
  };

  // Compute signal source weights from closed trade history
  let sourceWeights = null;
  let portfolioMetrics = null;
  if (computeSourceWeights && closedTrades.length > 0) {
    try { sourceWeights = computeSourceWeights(closedTrades); } catch {}
  }
  if (computePortfolioMetrics && closedTrades.length > 0) {
    try { portfolioMetrics = computePortfolioMetrics(closedTrades); } catch {}
  }

  // Run diagnostics on closed + open trades
  let diagnostics = null;
  if (runDiagnostics && closedTrades.length > 0) {
    try { diagnostics = runDiagnostics(closedTrades, openTrades.map(formatTrade)); } catch {}
  }

  res.json({
    positions,
    closedTrades,
    stats,
    wallet: walletSummary,
    sourceWeights,
    portfolioMetrics,
    diagnostics,
    pricesAvailable: Object.keys(prices).length > 0,
    ts: new Date().toISOString(),
  });
};
