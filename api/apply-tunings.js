// POST /api/apply-tunings — Apply approved tunings to Settings DB
// Reads Tuning Log rows where Status=Approved and Date Applied is empty,
// extracts minScore from Parameter After, writes to Settings DB,
// verifies the write, then marks Applied or Reverted.
const https = require('https');

const TUNING_DB = 'c326714ad2b748878e94c473760c97e3';
const SETTINGS_DB = '8ea13a18e8464014976ab364e9d9daae';

function notionRequest(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.notion.com', path, method,
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

// Find the Settings DB page ID for a given setting key
async function findSettingPageId(token, settingKey) {
  const result = await notionRequest('POST', `/v1/databases/${SETTINGS_DB}/query`, {
    filter: { property: 'Setting', title: { equals: settingKey } },
    page_size: 1,
  }, token);
  const pages = result.body?.results || [];
  if (pages.length === 0) return null;
  return {
    pageId: pages[0].id,
    currentValue: pages[0].properties?.['Value']?.rich_text?.[0]?.plain_text || '',
  };
}

// Write a setting value to Settings DB
async function writeSetting(token, pageId, value) {
  return notionRequest('PATCH', `/v1/pages/${pageId}`, {
    properties: {
      'Value': { rich_text: [{ text: { content: String(value) } }] },
    },
  }, token);
}

// Read back a setting to verify the write
async function readSetting(token, pageId) {
  const result = await notionRequest('GET', `/v1/pages/${pageId}`, {}, token);
  // GET doesn't need a body but we pass empty object
  return result.body?.properties?.['Value']?.rich_text?.[0]?.plain_text || null;
}

// Mark a tuning row as Applied or Reverted
async function markTuning(token, pageId, status) {
  const props = {
    'Status': { select: { name: status } },
  };
  if (status === 'Applied') {
    props['Date Applied'] = { date: { start: new Date().toISOString().split('T')[0] } };
  }
  return notionRequest('PATCH', `/v1/pages/${pageId}`, { properties: props }, token);
}

// Extract minScore from Parameter After text
// Matches patterns like: "score >= 76", "minScore: 76", "threshold: 76", "minimum score 76"
function extractMinScore(paramAfter) {
  if (!paramAfter) return null;
  const patterns = [
    /(?:score|threshold|minScore|minimum\s*score)\s*(?:>=|:|=|→|to)\s*(\d+)/i,
    /(\d+)\s*(?:minimum|threshold)/i,
    /(?:raise|increase|set|change).*?(\d+)/i,
  ];
  for (const p of patterns) {
    const m = paramAfter.match(p);
    if (m) {
      const val = Number(m[1]);
      if (val >= 50 && val <= 100) return val; // sanity bounds
    }
  }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const TOKEN = process.env.NOTION_TOKEN;
  if (!TOKEN) return res.status(503).json({ error: 'NOTION_TOKEN not set' });

  try {
    // Step 1: Fetch approved tunings that haven't been applied yet
    const queryResult = await notionRequest('POST', `/v1/databases/${TUNING_DB}/query`, {
      filter: {
        and: [
          { property: 'Status', select: { equals: 'Approved' } },
          { property: 'Date Applied', date: { is_empty: true } },
        ],
      },
      sorts: [{ property: 'Date Proposed', direction: 'ascending' }],
      page_size: 20,
    }, TOKEN);

    const pages = queryResult.body?.results || [];
    if (pages.length === 0) {
      return res.json({ ok: true, applied: 0, results: [], message: 'No pending approved tunings' });
    }

    const results = [];

    for (const page of pages) {
      const props = page.properties;
      const pageId = page.id;
      const category = props['Category']?.select?.name || '';
      const recommendation = props['Recommendation']?.title?.[0]?.plain_text || '';
      const paramBefore = props['Parameter Before']?.rich_text?.[0]?.plain_text || '';
      const paramAfter = props['Parameter After']?.rich_text?.[0]?.plain_text || '';

      const entry = { pageId, category, recommendation, paramBefore, paramAfter, status: 'skipped' };

      // Only process scoring/regime tunings that affect minScore
      if (category !== 'scoring' && category !== 'regime') {
        entry.reason = `Category "${category}" — no automated apply logic yet`;
        results.push(entry);
        continue;
      }

      // Extract the target minScore
      const newMinScore = extractMinScore(paramAfter);
      if (newMinScore === null) {
        entry.reason = 'Could not extract numeric minScore from Parameter After';
        results.push(entry);
        continue;
      }

      // Find the minScore setting in Settings DB
      const setting = await findSettingPageId(TOKEN, 'minScore');
      if (!setting) {
        entry.status = 'error';
        entry.reason = 'minScore setting not found in Settings DB';
        results.push(entry);
        continue;
      }

      const previousValue = setting.currentValue;
      entry.previousValue = previousValue;
      entry.newValue = String(newMinScore);

      // Write the new value
      const writeResult = await writeSetting(TOKEN, setting.pageId, newMinScore);
      if (writeResult.status !== 200) {
        entry.status = 'reverted';
        entry.reason = `Write failed with status ${writeResult.status}`;
        await markTuning(TOKEN, pageId, 'Reverted');
        results.push(entry);
        continue;
      }

      // Verify the write by reading back
      // Small delay to let Notion propagate
      await new Promise(r => setTimeout(r, 500));

      // Read back via GET /v1/pages/{id} — need to handle that GET doesn't use a body
      const verifyResult = await notionRequest('POST', `/v1/databases/${SETTINGS_DB}/query`, {
        filter: { property: 'Setting', title: { equals: 'minScore' } },
        page_size: 1,
      }, TOKEN);
      const verifyPages = verifyResult.body?.results || [];
      const readBackValue = verifyPages[0]?.properties?.['Value']?.rich_text?.[0]?.plain_text || '';

      if (String(readBackValue) === String(newMinScore)) {
        // Verification passed — mark as Applied
        entry.status = 'applied';
        entry.verified = true;
        await markTuning(TOKEN, pageId, 'Applied');
      } else {
        // Verification failed — revert to previous value and mark as Reverted
        entry.status = 'reverted';
        entry.reason = `Verification failed: expected ${newMinScore}, got ${readBackValue}`;
        entry.verified = false;
        // Try to restore previous value
        try { await writeSetting(TOKEN, setting.pageId, previousValue); } catch {}
        await markTuning(TOKEN, pageId, 'Reverted');
      }

      results.push(entry);
    }

    const appliedCount = results.filter(r => r.status === 'applied').length;
    const revertedCount = results.filter(r => r.status === 'reverted').length;
    const skippedCount = results.filter(r => r.status === 'skipped').length;

    return res.json({
      ok: true,
      applied: appliedCount,
      reverted: revertedCount,
      skipped: skippedCount,
      total: pages.length,
      results,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack?.split('\n').slice(0, 3) });
  }
};
