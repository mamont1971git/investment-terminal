// GET /api/get-positions
// Returns all open paper trades from Notion with live price + P&L
// Also returns closed trades for portfolio stats
const https = require('https');
let computeAll;
try { computeAll = require('./_lib/indicators').computeAll; } catch { computeAll = null; }

const TRADE_DB = '661bed1034ae4030be88d3ee7d125d42';

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
    https.get(
      `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${ticker}&outputsize=compact&apikey=${apiKey}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 },
      res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(d);
            if (json['Note'] || json['Information']) { resolve(null); return; }
            const ts = json['Time Series (Daily)'];
            if (!ts) { resolve(null); return; }
            resolve(Object.entries(ts).map(([date, v]) => ({
              date, open: parseFloat(v['1. open']), high: parseFloat(v['2. high']),
              low: parseFloat(v['3. low']), close: parseFloat(v['4. close']),
              volume: parseInt(v['5. volume']),
            })).reverse());
          } catch { resolve(null); }
        });
      }
    ).on('error', () => resolve(null)).on('timeout', function() { this.destroy(); resolve(null); });
  });
}

async function getPrice(ticker, apiKey) {
  return new Promise(resolve => {
    https.get(
      `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${ticker}&apikey=${apiKey}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 },
      res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const q = JSON.parse(d)['Global Quote'];
            resolve(q?.['05. price'] ? parseFloat(q['05. price']) : null);
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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  const TOKEN = process.env.NOTION_TOKEN;
  const ALPHA = process.env.ALPHA_VANTAGE_KEY;
  if (!TOKEN) return res.status(503).json({ error: 'NOTION_TOKEN not set' });

  // Fetch open paper trades + recent closed in parallel
  const [openResult, closedResult] = await Promise.all([
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
  ]);

  const openTrades = (openResult.results || []).map(formatTrade);
  const closedTrades = (closedResult.results || []).map(formatTrade);

  // Fetch live prices for open trades (respect Alpha Vantage rate limit)
  const uniqueTickers = [...new Set(openTrades.map(t => t.ticker).filter(Boolean))];
  const prices = {};

  // Fetch OHLCV for TA indicators (first 3 get full TA, rest get price-only)
  const taData = {};
  if (ALPHA && computeAll && uniqueTickers.length > 0) {
    for (const ticker of uniqueTickers.slice(0, 3)) {
      try {
        const bars = await fetchOHLCV(ticker, ALPHA);
        if (bars && bars.length >= 30) taData[ticker] = computeAll(bars);
      } catch {}
      if (uniqueTickers.length > 1) await new Promise(r => setTimeout(r, 400));
    }
    // Fetch price-only for remaining tickers that didn't get OHLCV
    const remaining = uniqueTickers.filter(t => !taData[t]);
    for (const ticker of remaining.slice(0, 5)) {
      prices[ticker] = await getPrice(ticker, ALPHA);
      if (remaining.length > 1) await new Promise(r => setTimeout(r, 300));
    }
  } else if (ALPHA && uniqueTickers.length > 0) {
    // No TA engine: just fetch prices for all
    for (const ticker of uniqueTickers.slice(0, 8)) {
      prices[ticker] = await getPrice(ticker, ALPHA);
      if (uniqueTickers.length > 1) await new Promise(r => setTimeout(r, 300));
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

  res.json({
    positions,
    closedTrades,
    stats,
    pricesAvailable: Object.keys(prices).length > 0,
    ts: new Date().toISOString(),
  });
};
