const https = require('https');

const TRADE_DB = '661bed1034ae4030be88d3ee7d125d42';
const NOTION_VERSION = '2022-06-28';

function notionReq(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.notion.com', path, method,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Notion-Version': NOTION_VERSION,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function tradeToNotion(t) {
  const props = {
    'Trade':    { title: [{ text: { content: `${t.ticker} — ${t.strategy} (${t.status})` } }] },
    'Ticker':   { rich_text: [{ text: { content: t.ticker || '' } }] },
    'Strategy': { select: { name: t.strategy || 'Mean Reversion' } },
    'Status':   { select: { name: t.status || 'Open' } },
    'Rules Followed': { checkbox: t.rulesFollowed !== false },
  };
  if (t.score)         props['Composite Score']   = { number: Number(t.score) };
  if (t.entryPrice)    props['Entry Price']        = { number: Number(t.entryPrice) };
  if (t.stopLoss)      props['Stop-Loss Price']    = { number: Number(t.stopLoss) };
  if (t.exitPrice)     props['Exit Price']         = { number: Number(t.exitPrice) };
  if (t.pnlPct != null) props['P&L %']            = { number: Number(t.pnlPct) };
  if (t.positionPct)   props['Position Size %']   = { number: Number(t.positionPct) };
  if (t.dateOpened)    props['date:Date Opened:start'] = t.dateOpened;
  if (t.dateClosed)    props['date:Date Closed:start'] = t.dateClosed;
  if (t.right)         props['What Went Right']   = { rich_text: [{ text: { content: t.right.slice(0,500) } }] };
  if (t.wrong)         props['What Went Wrong']   = { rich_text: [{ text: { content: t.wrong.slice(0,500) } }] };
  if (t.lesson)        props['Lesson Learned']    = { rich_text: [{ text: { content: t.lesson.slice(0,500) } }] };
  return props;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  if (!NOTION_TOKEN) return res.status(503).json({ error: 'NOTION_TOKEN not set' });

  let body = '';
  req.on('data', c => body += c);
  await new Promise(r => req.on('end', r));

  let trade;
  try { trade = JSON.parse(body); } catch(e) { return res.status(400).json({ error: 'Invalid JSON' }); }

  try {
    const r = await notionReq('POST', '/v1/pages', {
      parent: { database_id: TRADE_DB },
      properties: tradeToNotion(trade),
    }, NOTION_TOKEN);
    res.json({ ok: r.status < 300, notionId: r.body.id, url: r.body.url });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};
