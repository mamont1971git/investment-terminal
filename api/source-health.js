// GET /api/source-health — independently tests all signal data sources
// Returns health status for each source with latency, record counts, and error details
// Also logs failures to Notion Error Log for trend tracking
const https = require('https');

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', ...headers },
      timeout: 8000,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d, latencyMs: Date.now() - start }));
    }).on('error', e => reject({ message: e.message, latencyMs: Date.now() - start }))
      .on('timeout', function () { this.destroy(); reject({ message: 'timeout', latencyMs: Date.now() - start }); });
  });
}

async function checkSource(name, url, parseCheck) {
  const result = { source: name, status: 'unknown', latencyMs: 0, records: 0, error: null, checkedAt: new Date().toISOString() };
  try {
    const r = await httpsGet(url, { Accept: 'text/html' });
    result.latencyMs = r.latencyMs;
    if (r.status !== 200) {
      result.status = 'error';
      result.error = `HTTP ${r.status}`;
      return result;
    }
    const parsed = parseCheck(r.body);
    result.records = parsed.count;
    if (parsed.count > 0) {
      result.status = 'ok';
    } else if (r.body.length > 500) {
      result.status = 'degraded';
      result.error = 'HTML received but 0 records parsed — page structure may have changed';
    } else {
      result.status = 'error';
      result.error = 'Empty or minimal response';
    }
  } catch (e) {
    result.status = 'error';
    result.error = e.message || 'fetch failed';
    result.latencyMs = e.latencyMs || 0;
  }
  return result;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  const checks = await Promise.all([
    // Finviz — test one screen
    checkSource('Finviz Screener', 'https://finviz.com/screener.ashx?v=111&f=cap_midover,sh_relvol_o1.5&ft=4&o=-relativevolume', (html) => {
      const matches = html.match(/screener-link-primary/g) || [];
      return { count: matches.length };
    }),

    // Capitol Trades
    checkSource('Capitol Trades', 'https://www.capitoltrades.com/trades', (html) => {
      const rows = html.match(/q-tr/g) || [];
      const tickers = html.match(/issuer-ticker/g) || [];
      return { count: Math.max(rows.length, tickers.length) };
    }),

    // World Monitor
    checkSource('World Monitor', 'https://worldmonitor.app', (html) => {
      const hasData = html.includes('macro') || html.includes('signal') || html.includes('fear') || html.includes('greed');
      return { count: hasData ? 1 : 0 };
    }),

    // Quiver — Congressional Trading
    checkSource('Quiver: Congress', 'https://www.quiverquant.com/congresstrading/', (html) => {
      const rows = (html.match(/<tr[^>]*>/g) || []).length;
      const hasTicker = (html.match(/[A-Z]{1,5}/g) || []).length;
      const hasData = html.includes('var data') || rows > 3;
      return { count: hasData ? Math.max(rows - 1, hasTicker > 10 ? 1 : 0) : 0 };
    }),

    // Quiver — Insider Trading
    checkSource('Quiver: Insider', 'https://www.quiverquant.com/insidertrading/', (html) => {
      const rows = (html.match(/<tr[^>]*>/g) || []).length;
      const hasData = html.includes('var data') || rows > 3;
      return { count: hasData ? Math.max(rows - 1, 0) : 0 };
    }),

    // Quiver — Government Contracts
    checkSource('Quiver: Gov Contracts', 'https://www.quiverquant.com/governmentcontracts/', (html) => {
      const rows = (html.match(/<tr[^>]*>/g) || []).length;
      const hasData = html.includes('var data') || rows > 3;
      return { count: hasData ? Math.max(rows - 1, 0) : 0 };
    }),

    // Quiver — Lobbying
    checkSource('Quiver: Lobbying', 'https://www.quiverquant.com/lobbying/', (html) => {
      const rows = (html.match(/<tr[^>]*>/g) || []).length;
      const hasData = html.includes('var data') || rows > 3;
      return { count: hasData ? Math.max(rows - 1, 0) : 0 };
    }),

    // Finnhub — SPY quote
    checkSource('Finnhub (SPY)', `https://finnhub.io/api/v1/quote?symbol=SPY&token=${process.env.FINNHUB_KEY || 'missing'}`, (html) => {
      try {
        const d = JSON.parse(html);
        return { count: d.c > 0 ? 1 : 0 };
      } catch { return { count: 0 }; }
    }),

    // CNN Fear & Greed (via World Monitor — same endpoint)
    checkSource('Fear & Greed', 'https://worldmonitor.app', (html) => {
      const hasFG = html.includes('fear') && html.includes('greed');
      return { count: hasFG ? 1 : 0 };
    }),
  ]);

  // Aggregate health
  const healthy = checks.filter(c => c.status === 'ok').length;
  const degraded = checks.filter(c => c.status === 'degraded').length;
  const failed = checks.filter(c => c.status === 'error').length;
  const avgLatency = Math.round(checks.reduce((s, c) => s + c.latencyMs, 0) / checks.length);
  const overallStatus = failed >= 3 ? 'critical' : failed > 0 ? 'degraded' : 'healthy';

  // Log failures to Notion Error Log (fire-and-forget)
  const TOKEN = process.env.NOTION_TOKEN;
  const failedSources = checks.filter(c => c.status !== 'ok');
  if (failedSources.length > 0 && TOKEN) {
    const ERROR_LOG_DB = '9e459182b763489bbed331506762bd11';
    const now = new Date().toISOString();
    Promise.all(failedSources.map(s => {
      const body = JSON.stringify({
        parent: { database_id: ERROR_LOG_DB },
        properties: {
          'Error': { title: [{ text: { content: `HEALTH_CHECK: ${s.source} — ${s.status}`.slice(0, 100) } }] },
          'Type': { select: { name: 'HEALTH_CHECK' } },
          'Source': { select: { name: 'source-health.js' } },
          'Message': { rich_text: [{ text: { content: `${s.error || s.status} (${s.latencyMs}ms, ${s.records} records)`.slice(0, 500) } }] },
          'Resolved': { checkbox: false },
          'Timestamp': { date: { start: now } },
        },
      });
      return new Promise(resolve => {
        const r = https.request({
          hostname: 'api.notion.com', path: '/v1/pages', method: 'POST',
          headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json',
            'Notion-Version': '2022-06-28', 'Content-Length': Buffer.byteLength(body) },
        }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve()); });
        r.on('error', () => resolve()); r.write(body); r.end();
      });
    })).catch(() => {});
  }

  res.json({
    overallStatus,
    healthy, degraded, failed,
    total: checks.length,
    avgLatencyMs: avgLatency,
    checkedAt: new Date().toISOString(),
    sources: checks,
  });
};
