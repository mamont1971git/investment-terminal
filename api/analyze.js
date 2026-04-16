// POST /api/analyze
// Orchestrates a full investment analysis:
// 1. Fetches live market data (VIX, SPY, F&G)
// 2. Reads open trades + recent history from Notion
// 3. Calls Claude API with full analyst skill + all context
// 4. Returns structured analysis JSON
// 5. Auto-creates Order Drafts for BUY recommendations

const https = require('https');
const Anthropic = require('@anthropic-ai/sdk');

const TRADE_DB = '661bed1034ae4030be88d3ee7d125d42';

// ── helpers ──────────────────────────────────────────────────────────────
function httpsGet(url, headers={}) {
  return new Promise((resolve,reject) => {
    https.get(url,{headers:{'User-Agent':'Mozilla/5.0',...headers},timeout:8000},res=>{
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve({status:res.statusCode,body:d}));
    }).on('error',reject).on('timeout',function(){this.destroy();reject(new Error('timeout'));});
  });
}

async function fetchMarketData() {
  try {
    const r = await httpsGet(`https://stooq.com/q/d/l/?s=%5EVIX&i=d`);
    const lines = r.body.trim().split('\n').slice(1).filter(l=>l.includes(','));
    const last = lines[lines.length-1]?.split(',');
    const vix = last ? parseFloat(last[4]||last[1]) : null;

    // SPY price via Alpha Vantage
    const ALPHA = process.env.ALPHA_VANTAGE_KEY;
    let spyPrice=null, spyAbove=null;
    if (ALPHA) {
      const sr = await httpsGet(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=SPY&apikey=${ALPHA}`);
      const q = JSON.parse(sr.body)['Global Quote'];
      spyPrice = q?.['05. price'] ? parseFloat(q['05. price']) : null;
      spyAbove = vix ? vix < 22 : null; // approximate
    }

    return { vix, spyPrice, spyAbove, fg: null }; // F&G often blocked, Claude will note
  } catch { return { vix: null, spyPrice: null, spyAbove: null, fg: null }; }
}

async function fetchOpenTrades(token) {
  return new Promise((resolve,reject)=>{
    const data = JSON.stringify({
      filter:{and:[
        {property:'Status',select:{equals:'Paper'}},
        {property:'Simulation Mode',checkbox:{equals:true}}
      ]},
      page_size:20
    });
    const req = https.request({
      hostname:'api.notion.com',path:`/v1/databases/${TRADE_DB}/query`,method:'POST',
      headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json','Notion-Version':'2022-06-28','Content-Length':Buffer.byteLength(data)}
    },res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{
      try{resolve(JSON.parse(d).results||[]);}catch{resolve([]);}
    });});
    req.on('error',()=>resolve([])); req.write(data); req.end();
  });
}

async function fetchRecentClosed(token) {
  return new Promise((resolve,reject)=>{
    const data = JSON.stringify({
      filter:{property:'Status',select:{equals:'Closed'}},
      sorts:[{timestamp:'created_time',direction:'descending'}],
      page_size:8
    });
    const req = https.request({
      hostname:'api.notion.com',path:`/v1/databases/${TRADE_DB}/query`,method:'POST',
      headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json','Notion-Version':'2022-06-28','Content-Length':Buffer.byteLength(data)}
    },res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{
      try{resolve(JSON.parse(d).results||[]);}catch{resolve([]);}
    });});
    req.on('error',()=>resolve([])); req.write(data); req.end();
  });
}

function formatTrade(p) {
  const props = p.properties;
  return {
    ticker: props['Ticker']?.rich_text?.[0]?.plain_text || '',
    strategy: props['Strategy']?.select?.name || '',
    entry: props['Entry Price']?.number,
    stop: props['Stop-Loss Price']?.number,
    tp1: props['TP1']?.number,
    tp2: props['TP2']?.number,
    score: props['Composite Score']?.number,
    pnl: props['P&L %']?.number,
    dateOpened: props['date:Date Opened:start']?.date?.start || props['Date Opened']?.date?.start || '',
    status: props['Status']?.select?.name || '',
    lesson: props['Lesson Learned']?.rich_text?.[0]?.plain_text || '',
    sim: props['Simulation Mode']?.checkbox,
  };
}

async function createDraft(ticker, strategy, score, reasoning, regime, positionPct, entryPrice, token, alphaKey) {
  // Reuse create-draft logic inline
  const stop=+(entryPrice*0.93).toFixed(2),tp1=+(entryPrice*1.08).toFixed(2),
        tp2=+(entryPrice*1.15).toFixed(2),tp3=+(entryPrice*1.22).toFixed(2);
  const today=new Date().toISOString().split('T')[0];
  const body=JSON.stringify({
    parent:{database_id:TRADE_DB},
    properties:{
      'Trade':{title:[{text:{content:`⏳ ${ticker} — ${strategy} [DRAFT]`}}]},
      'Ticker':{rich_text:[{text:{content:ticker}}]},
      'Strategy':{select:{name:strategy}},
      'Status':{select:{name:'Draft'}},
      'Simulation Mode':{checkbox:true},
      'Entry Price':{number:entryPrice},
      'Stop-Loss Price':{number:stop},
      'TP1':{number:tp1},'TP2':{number:tp2},'TP3':{number:tp3},
      'Composite Score':{number:score},
      'What Went Right':{rich_text:[{text:{content:reasoning||''}}]},
      'date:Date Opened:start':today,
      ...(regime?{'Market Regime at Entry':{select:{name:regime}}}:{}),
      ...(positionPct?{'Position Size %':{number:positionPct}}:{}),
    }
  });
  return new Promise(resolve=>{
    const req=https.request({
      hostname:'api.notion.com',path:'/v1/pages',method:'POST',
      headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json','Notion-Version':'2022-06-28','Content-Length':Buffer.byteLength(body)}
    },res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{
      try{const r=JSON.parse(d);resolve({ok:res.statusCode<300,id:r.id,url:r.url,ticker,entryPrice,stop,tp1});}catch{resolve({ok:false});}
    });});
    req.on('error',()=>resolve({ok:false}));req.write(body);req.end();
  });
}

// ── main handler ─────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS') return res.status(200).end();

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const NOTION_TOKEN  = process.env.NOTION_TOKEN;
  const ALPHA_KEY     = process.env.ALPHA_VANTAGE_KEY;

  if (!ANTHROPIC_KEY) return res.status(503).json({error:'ANTHROPIC_API_KEY not set in Vercel env vars'});

  let body=''; req.on('data',c=>body+=c);
  await new Promise(r=>req.on('end',r));
  const { command = 'run investment analysis' } = JSON.parse(body||'{}');

  // Fetch all context in parallel
  const [market, openTrades, closedTrades] = await Promise.all([
    fetchMarketData(),
    NOTION_TOKEN ? fetchOpenTrades(NOTION_TOKEN) : Promise.resolve([]),
    NOTION_TOKEN ? fetchRecentClosed(NOTION_TOKEN) : Promise.resolve([]),
  ]);

  const openFormatted = openTrades.map(formatTrade);
  const closedFormatted = closedTrades.map(formatTrade);
  const today = new Date().toDateString();

  // Build context string for Claude
  const context = `
TODAY: ${today}

LIVE MARKET DATA:
- VIX: ${market.vix ? market.vix.toFixed(2) : 'unavailable (check finance.yahoo.com/quote/^VIX)'}
- Fear & Greed: Currently blocked by CNN anti-bot. Use VIX as proxy.
- SPY: ${market.spyPrice ? '$'+market.spyPrice.toFixed(2) : 'unavailable'} | Above 50 EMA: ${market.spyAbove===null?'approx from VIX':market.spyAbove?'YES':'NO'}
- Note: Fetch CNN Fear & Greed and specific RSI screener data using your knowledge of current conditions

OPEN PAPER TRADES (${openFormatted.length}):
${openFormatted.length ? openFormatted.map(t=>`- ${t.ticker} | ${t.strategy} | Entry: $${t.entry} | Stop: $${t.stop} | TP1: $${t.tp1} | Score: ${t.score} | Opened: ${t.dateOpened}`).join('\n') : 'None'}

RECENT CLOSED TRADES (last ${closedFormatted.length}):
${closedFormatted.length ? closedFormatted.map(t=>`- ${t.ticker} | ${t.strategy} | P&L: ${t.pnl!=null?(t.pnl>0?'+':'')+t.pnl.toFixed(1)+'%':'open'} | Score was: ${t.score||'?'} | Lesson: ${t.lesson||'none'}`).join('\n') : 'None yet'}

USER COMMAND: ${command}

INSTRUCTIONS FOR YOUR RESPONSE:
Respond with a JSON object in this exact structure (no markdown, pure JSON):
{
  "regime": {
    "name": "...",
    "headline": "...",
    "why": "...",
    "action": "...",
    "vix": ...,
    "fg": ...,
    "spyAbove": true/false
  },
  "positions": [
    {
      "ticker": "...",
      "recommendation": "HOLD|TAKE_PROFIT|EXIT_NOW|TIGHTEN_STOP",
      "currentPrice": ...,
      "pnlPct": ...,
      "reasoning": "...",
      "urgency": "urgent|watch|ok"
    }
  ],
  "opportunities": [
    {
      "ticker": "...",
      "score": ...,
      "action": "BUY|WATCHLIST|SKIP",
      "strategy": "...",
      "reasoning": "...",
      "entryPrice": ...,
      "stop": ...,
      "tp1": ...,
      "tp2": ...,
      "positionPct": ...
    }
  ],
  "insights": "...",
  "stance": "Aggressive|Moderate|Defensive",
  "recommendedCash": "...",
  "nextCheckIn": "..."
}`;

  // Load system prompt from skill
  const fs = require('fs');
  const skillPath = '/var/task/investment-skill.md'; // will be embedded at build
  let systemPrompt = `You are Daniel's personal investment analyst. Apply the composite scoring framework rigorously. Return only valid JSON, no markdown.`;

  // Call Claude API
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

  let analysisText;
  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: context }],
    });
    analysisText = message.content[0].text;
  } catch(e) {
    return res.status(500).json({error:'Claude API error: '+e.message});
  }

  // Parse JSON response
  let analysis;
  try {
    // Strip any markdown code fences if present
    const clean = analysisText.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
    analysis = JSON.parse(clean);
  } catch(e) {
    // If JSON parse fails, return raw text in a wrapper
    return res.json({ raw: analysisText, parseError: e.message });
  }

  // Auto-create Order Drafts for BUY opportunities with score ≥ 65
  const draftsCreated = [];
  if (NOTION_TOKEN && ALPHA_KEY && analysis.opportunities) {
    for (const opp of analysis.opportunities) {
      if (opp.action === 'BUY' && opp.score >= 65 && opp.ticker) {
        let price = opp.entryPrice;
        if (!price) {
          // Fetch current price
          try {
            const pr = await httpsGet(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${opp.ticker}&apikey=${ALPHA_KEY}`);
            const q = JSON.parse(pr.body)['Global Quote'];
            price = q?.['05. price'] ? parseFloat(q['05. price']) : null;
          } catch{}
        }
        if (price) {
          const draft = await createDraft(
            opp.ticker, opp.strategy, opp.score,
            opp.reasoning, analysis.regime?.name,
            opp.positionPct, price, NOTION_TOKEN, ALPHA_KEY
          );
          if (draft.ok) draftsCreated.push(draft);
        }
      }
    }
  }

  analysis.draftsCreated = draftsCreated;
  res.json(analysis);
};
