// GET /api/source-health — independently tests all signal data sources
// Returns health status for each source with latency, record counts, and error details
// Also logs failures to Notion Error Log for trend tracking
const https = require('https');

function httpsGet(url, headers = {}, maxRedirects = 3) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const doRequest = (reqUrl, redirectsLeft) => {
      https.get(reqUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', ...headers },
        timeout: 8000,
      }, res => {
        // Follow 301/302/307/308 redirects
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
          const loc = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, reqUrl).href;
          res.resume(); // drain response
          return doRequest(loc, redirectsLeft - 1);
        }
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve({ status: res.statusCode, body: d, latencyMs: Date.now() - start }));
      }).on('error', e => reject({ message: e.message, latencyMs: Date.now() - start }))
        .on('timeout', function () { this.destroy(); reject({ message: 'timeout', latencyMs: Date.now() - start }); });
    };
    doRequest(url, maxRedirects);
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
    // Finviz — test one screen (multiple selector fallbacks)
    checkSource('Finviz Screener', 'https://finviz.com/screener.ashx?v=111&f=cap_midover,sh_relvol_o1.5&ft=4&o=-relativevolume', (html) => {
      // Try multiple selectors — Finviz changes class names periodically
      const primary = (html.match(/screener-link-primary/g) || []).length;
      const tickers = (html.match(/screener-link-primary"[^>]*>[A-Z]{1,5}<\/a>/g) || []).length;
      const rows = (html.match(/styled-row/g) || []).length;
      const tableRows = (html.match(/<tr[^>]*class="[^"]*screener[^"]*"[^>]*>/g) || []).length;
      const anyTicker = (html.match(/>([A-Z]{1,5})<\/a>/g) || []).length;
      const count = primary || tickers || rows || tableRows || (anyTicker > 5 ? anyTicker : 0);
      return { count };
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
      const jsData = html.includes('var data') || html.includes('var tableData') || html.includes('"Representative"');
      const hasTd = (html.match(/<td[^>]*>/g) || []).length;
      const hasData = jsData || rows > 3 || hasTd > 10;
      return { count: hasData ? Math.max(rows - 1, hasTd > 10 ? Math.floor(hasTd/4) : 0) : 0 };
    }),

    // Quiver — Insider Trading (multiple detection patterns)
    checkSource('Quiver: Insider', 'https://www.quiverquant.com/insidertrading/', (html) => {
      const rows = (html.match(/<tr[^>]*>/g) || []).length;
      const jsData = html.includes('var data') || html.includes('var tableData') || html.includes('"Ticker"');
      const tickers = (html.match(/[A-Z]{1,5}/g) || []).filter(t => ['AAPL','MSFT','GOOG','TSLA','NVDA','AMZN','META'].includes(t)).length;
      const hasTd = (html.match(/<td[^>]*>/g) || []).length;
      const hasData = jsData || rows > 3 || tickers > 2 || hasTd > 10;
      return { count: hasData ? Math.max(rows - 1, hasTd > 10 ? Math.floor(hasTd/4) : 0, tickers) : 0 };
    }),

    // Quiver — Government Contracts (try both URL variants)
    checkSource('Quiver: Gov Contracts', 'https://www.quiverquant.com/governmentcontracts', (html) => {
      const rows = (html.match(/<tr[^>]*>/g) || []).length;
      const jsData = html.includes('var data') || html.includes('var tableData') || html.includes('"Agency"');
      const hasTd = (html.match(/<td[^>]*>/g) || []).length;
      const hasData = jsData || rows > 3 || hasTd > 10;
      return { count: hasData ? Math.max(rows - 1, hasTd > 10 ? Math.floor(hasTd/4) : 0) : 0 };
    }),

    // Quiver — Lobbying
    checkSource('Quiver: Lobbying', 'https://www.quiverquant.com/lobbying/', (html) => {
      const rows = (html.match(/<tr[^>]*>/g) || []).length;
      const jsData = html.includes('var data') || html.includes('var tableData') || html.includes('"Issue"');
      const hasTd = (html.match(/<td[^>]*>/g) || []).length;
      const hasData = jsData || rows > 3 || hasTd > 10;
      return { count: hasData ? Math.max(rows - 1, hasTd > 10 ? Math.floor(hasTd/4) : 0) : 0 };
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

  // Log to Notion — structured health snapshot (fire-and-forget)
  const TOKEN = process.env.NOTION_TOKEN;
  if (TOKEN) {
    const ERROR_LOG_DB = '9e459182b763489bbed331506762bd11';
    const now = new Date().toISOString();

    // Build a single structured snapshot of all sources
    const sourcesSummary = checks.map(s =>
      `${s.status === 'ok' ? '✓' : s.status === 'degraded' ? '⚠' : '✗'} ${s.source}: ${s.status} (${s.latencyMs}ms, ${s.records}rec)${s.error ? ' — ' + s.error : ''}`
    ).join('\n');

    const body = JSON.stringify({
      parent: { database_id: ERROR_LOG_DB },
      properties: {
        'Error': { title: [{ text: { content: `HEALTH_SNAPSHOT: ${overallStatus} — ${healthy}ok/${degraded}warn/${failed}fail`.slice(0, 100) } }] },
        'Type': { select: { name: 'HEALTH_SNAPSHOT' } },
        'Source': { select: { name: 'source-health.js' } },
        'Message': { rich_text: [{ text: { content: sourcesSummary.slice(0, 2000) } }] },
        'Resolved': { checkbox: overallStatus === 'healthy' },
        'Timestamp': { date: { start: now } },
      },
    });

    const req = https.request({
      hostname: 'api.notion.com', path: '/v1/pages', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28', 'Content-Length': Buffer.byteLength(body) },
    }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => {}); });
    req.on('error', () => {}); req.write(body); req.end();
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
