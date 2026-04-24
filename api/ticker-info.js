// GET /api/ticker-info?symbols=AAPL,MSFT,GLD
// Returns company profiles — checks Notion Ticker Dictionary first, then Finnhub.
// New tickers discovered via Finnhub are saved back to Notion for cross-device persistence.
const https = require('https');

const NOTION_DB_ID = 'f6d25cd6dccf4ea79c6a25bcb792e7c2';
const memCache = {}; // { TICKER: { data, ts } } — warm-instance cache
const MEM_TTL = 60 * 60 * 1000; // 1 hour in-memory (Notion is the durable store)

// ── Notion helpers ──────────────────────────────────────────────────

function notionRequest(method, path, body) {
  const token = process.env.NOTION_TOKEN;
  if (!token) return Promise.resolve(null);
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.notion.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 6000,
    }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', function () { this.destroy(); resolve(null); });
    if (payload) req.write(payload);
    req.end();
  });
}

function notionText(prop) {
  if (!prop) return '';
  if (prop.title) return (prop.title[0]?.plain_text || '').trim();
  if (prop.rich_text) return (prop.rich_text[0]?.plain_text || '').trim();
  if (prop.url !== undefined) return prop.url || '';
  return '';
}

async function fetchFromNotion(tickers) {
  // Query Notion for all matching tickers (batch via OR filter)
  if (!tickers.length) return {};
  const filter = tickers.length === 1
    ? { property: 'Ticker', title: { equals: tickers[0] } }
    : { or: tickers.map(t => ({ property: 'Ticker', title: { equals: t } })) };

  const resp = await notionRequest('POST', `/v1/databases/${NOTION_DB_ID}/query`, {
    filter,
    page_size: 100,
  });

  const results = {};
  if (resp && resp.results) {
    for (const page of resp.results) {
      const p = page.properties;
      const ticker = notionText(p['Ticker']);
      if (!ticker) continue;
      results[ticker] = {
        ticker,
        name: notionText(p['Name']) || ticker,
        industry: notionText(p['Industry']) || '—',
        country: notionText(p['Country']) || '—',
        exchange: notionText(p['Exchange']) || '—',
        marketCap: notionText(p['Market Cap']) || '—',
        ipo: notionText(p['IPO']) || '—',
        url: notionText(p['Website']) || '',
        logo: notionText(p['Logo']) || '',
      };
    }
  }
  return results;
}

async function saveToNotion(profiles) {
  // Save new ticker profiles to Notion (fire-and-forget, parallel)
  const promises = profiles.map(p => {
    const now = new Date().toISOString().split('T')[0];
    return notionRequest('POST', '/v1/pages', {
      parent: { database_id: NOTION_DB_ID },
      properties: {
        'Ticker': { title: [{ text: { content: p.ticker } }] },
        'Name': { rich_text: [{ text: { content: (p.name || '').slice(0, 200) } }] },
        'Industry': { rich_text: [{ text: { content: (p.industry || '').slice(0, 200) } }] },
        'Country': { rich_text: [{ text: { content: (p.country || '').slice(0, 100) } }] },
        'Exchange': { rich_text: [{ text: { content: (p.exchange || '').slice(0, 100) } }] },
        'Market Cap': { rich_text: [{ text: { content: (p.marketCap || '').slice(0, 50) } }] },
        'IPO': { rich_text: [{ text: { content: (p.ipo || '').slice(0, 20) } }] },
        'Website': p.url ? { url: p.url } : { url: null },
        'Logo': p.logo ? { url: p.logo } : { url: null },
        'Last Updated': { date: { start: now } },
      },
    });
  });
  await Promise.all(promises);
}

// ── Finnhub helper ──────────────────────────────────────────────────

function fetchFromFinnhub(ticker, apiKey) {
  return new Promise(resolve => {
    const url = `https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${apiKey}`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 4000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(d);
          if (p.name) {
            resolve({
              ticker: p.ticker || ticker,
              name: p.name,
              industry: p.finnhubIndustry || '—',
              country: p.country || '—',
              exchange: p.exchange || '—',
              marketCap: p.marketCapitalization ? `$${(p.marketCapitalization / 1000).toFixed(1)}B` : '—',
              ipo: p.ipo || '—',
              url: p.weburl || '',
              logo: p.logo || '',
            });
          } else {
            resolve({ ticker, name: ticker, industry: 'ETF / Unknown', country: '—', exchange: '—', marketCap: '—', ipo: '—', url: '', logo: '' });
          }
        } catch { resolve({ ticker, name: ticker, industry: 'Unknown', country: '—', exchange: '—', marketCap: '—' }); }
      });
    }).on('error', () => resolve({ ticker, name: ticker, industry: 'Unknown' }))
      .on('timeout', function () { this.destroy(); resolve({ ticker, name: ticker, industry: 'Unknown' }); });
  });
}

// ── Main handler ────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=3600');

  const symbols = (req.query.symbols || '').toUpperCase().split(',').filter(Boolean).slice(0, 30);
  if (!symbols.length) return res.json({});

  const now = Date.now();
  const results = {};
  const notMemCached = [];

  // 1. Check in-memory cache
  for (const s of symbols) {
    if (memCache[s] && now - memCache[s].ts < MEM_TTL) {
      results[s] = memCache[s].data;
    } else {
      notMemCached.push(s);
    }
  }

  if (!notMemCached.length) return res.json(results);

  // 2. Check Notion
  const notionResults = await fetchFromNotion(notMemCached);
  const notInNotion = [];
  for (const s of notMemCached) {
    if (notionResults[s]) {
      results[s] = notionResults[s];
      memCache[s] = { data: notionResults[s], ts: now };
    } else {
      notInNotion.push(s);
    }
  }

  if (!notInNotion.length) return res.json(results);

  // 3. Fetch from Finnhub (only truly unknown tickers)
  const apiKey = process.env.FINNHUB_KEY;
  if (!apiKey) {
    // No Finnhub key — return what we have + stubs
    for (const s of notInNotion) {
      results[s] = { ticker: s, name: s, industry: 'Unknown', country: '—', exchange: '—', marketCap: '—' };
    }
    return res.json(results);
  }

  const newProfiles = [];
  for (let i = 0; i < notInNotion.length; i += 4) {
    const batch = notInNotion.slice(i, i + 4);
    const profiles = await Promise.all(batch.map(t => fetchFromFinnhub(t, apiKey)));
    for (const p of profiles) {
      results[p.ticker] = p;
      memCache[p.ticker] = { data: p, ts: now };
      newProfiles.push(p);
    }
  }

  // 4. Save new discoveries to Notion (fire-and-forget)
  if (newProfiles.length) {
    saveToNotion(newProfiles).catch(() => {});
  }

  res.json(results);
};
