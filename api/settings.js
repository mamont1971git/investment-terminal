// GET  /api/settings — read all settings from Notion
// POST /api/settings — update one or more settings in Notion
const https = require('https');

const SETTINGS_DB = '8ea13a18e8464014976ab364e9d9daae';

function notionPost(path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.notion.com', path, method: path.includes('/query') ? 'POST' : 'PATCH',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
        'Content-Length': Buffer.byteLength(data),
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function notionQuery(token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ page_size: 50 });
    const req = https.request({
      hostname: 'api.notion.com',
      path: `/v1/databases/${SETTINGS_DB}/query`,
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
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { reject(new Error('Invalid JSON from Notion')); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function parseSettings(results) {
  const settings = {};
  const pageIds = {}; // key → notion page ID (for updates)
  for (const p of results) {
    const key = p.properties['Setting']?.title?.[0]?.plain_text;
    const rawValue = p.properties['Value']?.rich_text?.[0]?.plain_text || '';
    const type = p.properties['Type']?.select?.name || 'string';
    if (!key) continue;

    let value;
    if (type === 'number') value = Number(rawValue) || 0;
    else if (type === 'boolean') value = rawValue === 'true';
    else if (type === 'json') {
      try { value = JSON.parse(rawValue || '{}'); } catch { value = {}; }
    }
    else value = rawValue;

    settings[key] = value;
    pageIds[key] = p.id;
  }
  return { settings, pageIds };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const TOKEN = process.env.NOTION_TOKEN;
  if (!TOKEN) return res.status(503).json({ error: 'NOTION_TOKEN not set' });

  try {
    // GET — return all settings as flat object
    if (req.method === 'GET') {
      const result = await notionQuery(TOKEN);
      const { settings } = parseSettings(result.results || []);
      return res.json(settings);
    }

    // POST — update one or more settings
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      await new Promise(r => req.on('end', r));
      const updates = JSON.parse(body || '{}');

      // Fetch current to get page IDs
      const result = await notionQuery(TOKEN);
      const { settings, pageIds } = parseSettings(result.results || []);

      const updated = {};
      for (const [key, value] of Object.entries(updates)) {
        const pageId = pageIds[key];
        if (!pageId) continue; // unknown setting — skip

        const strValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
        await notionPost(`/v1/pages/${pageId}`, {
          properties: {
            'Value': { rich_text: [{ text: { content: strValue.slice(0, 2000) } }] },
          },
        }, TOKEN);
        updated[key] = value;
      }

      return res.json({ ok: true, updated });
    }

    return res.status(405).json({ error: 'GET or POST only' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
