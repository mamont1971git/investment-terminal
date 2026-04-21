const https = require('https');

const ERROR_LOG_DB = '9e459182b763489bbed331506762bd11';

function notionPost(path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.notion.com',
      path,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
        'Content-Length': Buffer.byteLength(data),
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  if (!NOTION_TOKEN) return res.status(503).json({ error: 'NOTION_TOKEN not configured in Vercel env vars' });

  let body = '';
  req.on('data', c => body += c);
  await new Promise(r => req.on('end', r));

  let errors;
  try { errors = JSON.parse(body); }
  catch(e) { return res.status(400).json({ error: 'Invalid JSON' }); }

  if (!Array.isArray(errors)) errors = [errors];

  const results = [];
  for (const err of errors.slice(0, 20)) { // max 20 per call
    try {
      const r = await notionPost('/v1/pages', {
        parent: { database_id: ERROR_LOG_DB },
        properties: {
          'Error':     { title: [{ text: { content: String(err.type || 'ERROR') + ': ' + String(err.message || '').slice(0, 80) } }] },
          'Type':      { select: { name: err.type || 'OTHER' } },
          'Source':    { select: { name: 'Dashboard' } },
          'Message':   { rich_text: [{ text: { content: String(err.message || '').slice(0, 500) } }] },
          'Context':   { rich_text: [{ text: { content: String(err.context || '').slice(0, 500) } }] },
          'Protocol':  { rich_text: [{ text: { content: String(err.protocol || '') } }] },
          'Resolved':  { checkbox: false },
          'Timestamp': { date: { start: new Date(err.ts || Date.now()).toISOString() } },
        },
      }, NOTION_TOKEN);
      results.push({ ok: r.status < 300, status: r.status });
    } catch(e) {
      results.push({ ok: false, error: e.message });
    }
  }

  res.json({ logged: results.filter(r => r.ok).length, total: errors.length });
};
