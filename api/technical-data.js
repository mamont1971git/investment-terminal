/**
 * GET/POST /api/technical-data
 * Fetches OHLCV from Alpha Vantage, computes all technical indicators,
 * caches results in Notion. Returns cached data if fresh (same trading day).
 *
 * Query: ?tickers=AAPL,MSFT,NVDA  (or POST body: {tickers:["AAPL","MSFT"]})
 * Optional: ?force=1  to bypass cache
 *
 * Cache DB in Notion: "TA Cache" — auto-created on first use.
 * Retention: data refreshed once per trading day. Tickers not queried in 30 days are pruned.
 */

const https = require('https');
const { computeAll } = require('./lib/indicators');

// ─── Notion helpers ─────────────────────────────────────────────────────────

const NOTION_VERSION = '2022-06-28';

// We store the cache DB ID in env var NOTION_TA_CACHE_DB
// If not set, we create it under the main investment page

function notionRequest(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const opts = {
      hostname: 'api.notion.com', path, method,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Notion-Version': NOTION_VERSION,
      },
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { resolve({ error: 'parse_failed', raw: d }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function getOrCreateCacheDB(token) {
  // Check env var first
  const envDbId = process.env.NOTION_TA_CACHE_DB;
  if (envDbId) return envDbId;

  // Try to find existing "TA Cache" database by searching
  const search = await notionRequest('POST', '/v1/search', {
    query: 'TA Cache', filter: { value: 'database', property: 'object' },
  }, token);

  const existing = (search.results || []).find(r =>
    r.title?.[0]?.plain_text === 'TA Cache'
  );
  if (existing) return existing.id;

  // Create under the investment system page
  const parentPage = process.env.NOTION_INVESTMENT_PAGE || '343c4ce18c4c80d1b83fdc12f5b573d4';
  const db = await notionRequest('POST', '/v1/databases', {
    parent: { type: 'page_id', page_id: parentPage },
    title: [{ type: 'text', text: { content: 'TA Cache' } }],
    properties: {
      'Ticker':       { title: {} },
      'Last Updated': { date: {} },
      'Indicators':   { rich_text: {} },
      'Signals':      { rich_text: {} },
      'Price':        { number: { format: 'dollar' } },
      'RSI2':         { number: { format: 'number' } },
      'RSI14':        { number: { format: 'number' } },
    },
  }, token);

  if (db.id) return db.id;
  return null;
}

async function getCachedTicker(dbId, ticker, token) {
  const query = await notionRequest('POST', `/v1/databases/${dbId}/query`, {
    filter: { property: 'Ticker', title: { equals: ticker } },
    page_size: 1,
  }, token);
  if (!query.results?.length) return null;
  const page = query.results[0];
  const lastUpdated = page.properties['Last Updated']?.date?.start;
  if (!lastUpdated) return null;

  // Check if cache is from today (same trading day)
  const now = new Date();
  const cacheDate = new Date(lastUpdated);
  const today = now.toISOString().slice(0, 10);
  const cacheDay = cacheDate.toISOString().slice(0, 10);

  // If market hasn't opened yet today (before 9:30 ET), yesterday's data is fine
  const etHour = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' })).getHours();
  const isPreMarket = etHour < 10; // rough check

  if (cacheDay === today || (isPreMarket && daysBetween(cacheDate, now) <= 1)) {
    // Parse cached indicators
    try {
      const indicatorsJson = page.properties['Indicators']?.rich_text?.[0]?.plain_text;
      const signalsJson = page.properties['Signals']?.rich_text?.[0]?.plain_text;
      return {
        pageId: page.id,
        fresh: true,
        indicators: indicatorsJson ? JSON.parse(indicatorsJson) : null,
        signals: signalsJson ? JSON.parse(signalsJson) : null,
        cachedAt: lastUpdated,
      };
    } catch { return null; }
  }
  return { pageId: page.id, fresh: false };
}

function daysBetween(d1, d2) {
  return Math.abs(Math.floor((d2 - d1) / 86400000));
}

async function updateCache(dbId, ticker, indicators, token, existingPageId) {
  const indicatorsStr = JSON.stringify(indicators);
  const signalsStr = JSON.stringify(indicators._summary || []);

  // Notion rich_text limit is 2000 chars — compress if needed
  const trimmedIndicators = indicatorsStr.length > 1950
    ? JSON.stringify(compressIndicators(indicators))
    : indicatorsStr;

  const props = {
    'Ticker':       { title: [{ text: { content: ticker } }] },
    'Last Updated': { date: { start: new Date().toISOString() } },
    'Indicators':   { rich_text: [{ text: { content: trimmedIndicators.slice(0, 2000) } }] },
    'Signals':      { rich_text: [{ text: { content: signalsStr.slice(0, 2000) } }] },
    'Price':        { number: indicators.price || 0 },
    'RSI2':         { number: indicators.rsi2 || 0 },
    'RSI14':        { number: indicators.rsi14 || 0 },
  };

  if (existingPageId) {
    // Update existing page
    return notionRequest('PATCH', `/v1/pages/${existingPageId}`, { properties: props }, token);
  } else {
    // Create new page
    return notionRequest('POST', '/v1/pages', {
      parent: { database_id: dbId },
      properties: props,
    }, token);
  }
}

function compressIndicators(ind) {
  // Keep only the most important fields for cache
  return {
    price: ind.price, date: ind.date,
    rsi2: ind.rsi2, rsi14: ind.rsi14,
    macd: ind.macd ? { macd: ind.macd.macd, signal: ind.macd.signal, histogram: ind.macd.histogram, crossover: ind.macd.crossover } : null,
    bb: ind.bollingerBands ? { upper: ind.bollingerBands.upper, lower: ind.bollingerBands.lower, pctB: ind.bollingerBands.pctB } : null,
    atr: ind.atr ? { atr: ind.atr.atr, atrPct: ind.atr.atrPct } : null,
    stoch: ind.stochastic ? { k: ind.stochastic.k, d: ind.stochastic.d, signal: ind.stochastic.signal } : null,
    zScore: ind.zScore ? { zScore: ind.zScore.zScore, interpretation: ind.zScore.interpretation } : null,
    obv: ind.obv ? { trend: ind.obv.trend, divergence: ind.obv.divergence } : null,
    vol: ind.volume ? { ratio: ind.volume.ratio, signal: ind.volume.signal } : null,
    ema: ind.emaAlignment ? { alignment: ind.emaAlignment.alignment, cross: ind.emaAlignment.cross, above200: ind.emaAlignment.above200 } : null,
    fib: ind.fibonacci ? { nearestSupport: ind.fibonacci.nearestSupport, nearestResistance: ind.fibonacci.nearestResistance, trend: ind.fibonacci.trend } : null,
    onePercent: ind.onePercentRule,
    _summary: ind._summary,
  };
}

// ─── Alpha Vantage OHLCV fetch ──────────────────────────────────────────────

function fetchOHLCV(ticker, apiKey) {
  return new Promise(resolve => {
    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${ticker}&outputsize=compact&apikey=${apiKey}`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(d);
          if (json['Note'] || json['Information']) {
            resolve({ error: 'rate_limited', message: json['Note'] || json['Information'] });
            return;
          }
          const ts = json['Time Series (Daily)'];
          if (!ts) { resolve({ error: 'no_data' }); return; }
          const bars = Object.entries(ts)
            .map(([date, v]) => ({
              date,
              open: parseFloat(v['1. open']),
              high: parseFloat(v['2. high']),
              low: parseFloat(v['3. low']),
              close: parseFloat(v['4. close']),
              volume: parseInt(v['5. volume']),
            }))
            .reverse(); // oldest first
          resolve({ bars });
        } catch (e) { resolve({ error: 'parse_failed', message: e.message }); }
      });
    }).on('error', e => resolve({ error: 'network', message: e.message }))
      .on('timeout', function () { this.destroy(); resolve({ error: 'timeout' }); });
  });
}

// ─── Prune old cache entries (>30 days) ─────────────────────────────────────

async function pruneOldCache(dbId, token) {
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  const old = await notionRequest('POST', `/v1/databases/${dbId}/query`, {
    filter: {
      property: 'Last Updated',
      date: { before: cutoff },
    },
    page_size: 10,
  }, token);
  for (const page of (old.results || [])) {
    await notionRequest('PATCH', `/v1/pages/${page.id}`, { archived: true }, token);
  }
  return (old.results || []).length;
}

// ─── Main handler ───────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const TOKEN = process.env.NOTION_TOKEN;
  const ALPHA = process.env.ALPHA_VANTAGE_KEY;
  if (!TOKEN) return res.status(503).json({ error: 'NOTION_TOKEN not set' });
  if (!ALPHA) return res.status(503).json({ error: 'ALPHA_VANTAGE_KEY not set' });

  // Parse tickers from query or body
  let tickers = [];
  let force = false;
  let portfolioValue = 100000;

  if (req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    await new Promise(r => req.on('end', r));
    const parsed = JSON.parse(body || '{}');
    tickers = parsed.tickers || [];
    force = parsed.force || false;
    if (parsed.portfolioValue) portfolioValue = parsed.portfolioValue;
  } else {
    const url = new URL(req.url, `http://${req.headers.host}`);
    tickers = (url.searchParams.get('tickers') || '').split(',').filter(Boolean);
    force = url.searchParams.get('force') === '1';
  }

  if (!tickers.length) return res.json({ error: 'No tickers specified', usage: '?tickers=AAPL,MSFT' });
  tickers = tickers.slice(0, 8).map(t => t.trim().toUpperCase()); // max 8 tickers

  // Get or create cache DB
  const dbId = await getOrCreateCacheDB(TOKEN);
  if (!dbId) return res.status(500).json({ error: 'Could not access TA Cache database' });

  const results = {};
  let apiCalls = 0;
  let cacheHits = 0;

  for (const ticker of tickers) {
    // Check cache first
    if (!force) {
      const cached = await getCachedTicker(dbId, ticker, TOKEN);
      if (cached?.fresh && cached.indicators) {
        results[ticker] = { ...cached.indicators, _cached: true, _cachedAt: cached.cachedAt };
        cacheHits++;
        continue;
      }
      // Stale or missing — need to fetch
      var existingPageId = cached?.pageId || null;
    }

    // Fetch OHLCV from Alpha Vantage
    const ohlcv = await fetchOHLCV(ticker, ALPHA);
    apiCalls++;

    if (ohlcv.error) {
      results[ticker] = { error: ohlcv.error, message: ohlcv.message };
      continue;
    }

    // Compute all indicators
    const indicators = computeAll(ohlcv.bars, portfolioValue);
    results[ticker] = { ...indicators, _cached: false, _computedAt: new Date().toISOString() };

    // Update cache in Notion (don't await — fire and forget for speed)
    updateCache(dbId, ticker, indicators, TOKEN, existingPageId).catch(() => {});

    // Small delay between API calls to respect rate limits
    if (apiCalls < tickers.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // Prune old cache entries occasionally (1 in 10 requests)
  if (Math.random() < 0.1) {
    pruneOldCache(dbId, TOKEN).catch(() => {});
  }

  res.json({
    tickers: results,
    meta: {
      apiCalls,
      cacheHits,
      cacheDb: dbId,
      ts: new Date().toISOString(),
    },
  });
};
