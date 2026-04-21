// POST /api/close-position
// Closes a paper trade in Notion: sets exit price, P&L, close reason, date
// Used by dashboard Take Profit / Exit / Tighten Stop actions
const https = require('https');

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
    res.json({
      ok: true,
      closed: {
        ticker, action, closeReason, status,
        exitPrice: currentPrice, entryPrice: entry,
        pnlPct, daysHeld, date: today,
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
