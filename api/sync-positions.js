// POST /api/sync-positions
// Normalizes all open paper trades to current schema standards.
// Idempotent — safe to run after every deploy or feature change.
// Cost: ~1 Notion read + 1 PATCH per trade needing updates. Zero external API calls.

const https = require('https');
const TRADE_DB = '661bed1034ae4030be88d3ee7d125d42';

// ── Current schema standards ────────────────────────────────────────────
// Update these whenever we change the expected format:
const CURRENT_SCHEMA_VERSION = 2; // bump when schema changes

function buildExpectedTitle(ticker, strategy) {
  return `🧪 ${ticker} — ${strategy} [SIM]`;
}

function buildExpectedProps(trade) {
  const fixes = {};
  const ticker = trade.ticker;
  const strategy = trade.strategy || 'Paper';

  // 1. Title format: must be "🧪 TICKER — Strategy [SIM]"
  const expectedTitle = buildExpectedTitle(ticker, strategy);
  if (trade.title !== expectedTitle) {
    fixes['Trade'] = { title: [{ text: { content: expectedTitle } }] };
  }

  // 2. Status must be "Paper" for active sim trades
  if (trade.status !== 'Paper') {
    fixes['Status'] = { select: { name: 'Paper' } };
  }

  // 3. Simulation Mode must be true
  if (!trade.simMode) {
    fixes['Simulation Mode'] = { checkbox: true };
  }

  // 4. Rules Followed should be true
  if (!trade.rulesFollowed) {
    fixes['Rules Followed'] = { checkbox: true };
  }

  // 5. Ensure TP levels exist (recalc from entry if missing)
  if (trade.entry && !trade.tp1) {
    fixes['TP1'] = { number: +(trade.entry * 1.08).toFixed(2) };
  }
  if (trade.entry && !trade.tp2) {
    fixes['TP2'] = { number: +(trade.entry * 1.15).toFixed(2) };
  }
  if (trade.entry && !trade.tp3) {
    fixes['TP3'] = { number: +(trade.entry * 1.22).toFixed(2) };
  }

  // 6. Ensure stop-loss exists (default 7% below entry)
  if (trade.entry && !trade.stop) {
    fixes['Stop-Loss Price'] = { number: +(trade.entry * 0.93).toFixed(2) };
  }

  return fixes;
}

// ── Notion helpers ──────────────────────────────────────────────────────
function notionQuery(dbId, filter, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ filter, page_size: 100 });
    const req = https.request({
      hostname: 'api.notion.com', path: `/v1/databases/${dbId}/query`, method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28', 'Content-Length': Buffer.byteLength(data),
      },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d).results || []); } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([])); req.write(data); req.end();
  });
}

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
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: 500 }); }
      });
    });
    req.on('error', () => resolve({ status: 500 })); req.write(data); req.end();
  });
}

function extractTrade(page) {
  const p = page.properties;
  return {
    id: page.id,
    title: p['Trade']?.title?.[0]?.plain_text || '',
    ticker: p['Ticker']?.rich_text?.[0]?.plain_text || '',
    strategy: p['Strategy']?.select?.name || '',
    status: p['Status']?.select?.name || '',
    simMode: p['Simulation Mode']?.checkbox || false,
    rulesFollowed: p['Rules Followed']?.checkbox || false,
    entry: p['Entry Price']?.number || null,
    stop: p['Stop-Loss Price']?.number || null,
    tp1: p['TP1']?.number || null,
    tp2: p['TP2']?.number || null,
    tp3: p['TP3']?.number || null,
    score: p['Composite Score']?.number || null,
    signalAttribution: p['Signal Attribution']?.rich_text?.[0]?.plain_text || '',
    dateOpened: p['Date Opened']?.date?.start || '',
  };
}

// ── Main handler ────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const TOKEN = process.env.NOTION_TOKEN;
  if (!TOKEN) return res.status(503).json({ error: 'NOTION_TOKEN not set' });

  // Fetch ALL trades that should be active: Paper + Simulation Mode
  // Also fetch trades with wrong status that might need fixing
  const [paperTrades, openTrades, draftTrades] = await Promise.all([
    notionQuery(TRADE_DB, {
      and: [
        { property: 'Status', select: { equals: 'Paper' } },
        { property: 'Simulation Mode', checkbox: { equals: true } },
      ],
    }, TOKEN),
    notionQuery(TRADE_DB, {
      and: [
        { property: 'Status', select: { equals: 'Open' } },
        { property: 'Simulation Mode', checkbox: { equals: false } },
      ],
    }, TOKEN),
    notionQuery(TRADE_DB, {
      property: 'Status', select: { equals: 'Draft' },
    }, TOKEN),
  ]);

  const allTrades = [...paperTrades, ...openTrades];
  const synced = [];
  const skipped = [];
  const errors = [];

  for (const page of allTrades) {
    const trade = extractTrade(page);
    if (!trade.ticker) { skipped.push({ id: trade.id, reason: 'No ticker' }); continue; }

    const fixes = buildExpectedProps(trade);

    if (Object.keys(fixes).length === 0) {
      skipped.push({ ticker: trade.ticker, reason: 'Already up to date' });
      continue;
    }

    try {
      const result = await notionPatch(trade.id, fixes, TOKEN);
      if (result.status < 300) {
        synced.push({
          ticker: trade.ticker,
          fixes: Object.keys(fixes),
          before: { title: trade.title, status: trade.status, simMode: trade.simMode },
        });
      } else {
        errors.push({ ticker: trade.ticker, error: result.body?.message || 'Unknown' });
      }
    } catch (e) {
      errors.push({ ticker: trade.ticker, error: e.message });
    }

    // Small delay to respect Notion rate limits (3 req/sec)
    await new Promise(r => setTimeout(r, 350));
  }

  res.json({
    ok: true,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    total: allTrades.length,
    synced: synced.length,
    skipped: skipped.length,
    errors: errors.length,
    drafts: draftTrades.length,
    details: { synced, skipped, errors },
  });
};
