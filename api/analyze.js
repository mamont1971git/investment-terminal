// POST /api/analyze
// Orchestrates a full investment analysis:
// 1. Fetches live market data (VIX, SPY, F&G)
// 2. Reads open trades + recent history from Notion
// 3. Calls Claude API with full analyst skill + all context
// 4. Returns structured analysis JSON
// 5. Auto-creates Order Drafts for BUY recommendations

const https = require('https');
const Anthropic = require('@anthropic-ai/sdk');
const { computeAll } = require('./_lib/indicators');

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

// ── Technical Analysis: fetch OHLCV + compute indicators ────────────────
function fetchOHLCV(ticker, apiKey) {
  return new Promise(resolve => {
    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${ticker}&outputsize=compact&apikey=${apiKey}`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(d);
          if (json['Note'] || json['Information']) { resolve(null); return; }
          const ts = json['Time Series (Daily)'];
          if (!ts) { resolve(null); return; }
          const bars = Object.entries(ts).map(([date, v]) => ({
            date, open: parseFloat(v['1. open']), high: parseFloat(v['2. high']),
            low: parseFloat(v['3. low']), close: parseFloat(v['4. close']),
            volume: parseInt(v['5. volume']),
          })).reverse();
          resolve(bars);
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null)).on('timeout', function () { this.destroy(); resolve(null); });
  });
}

async function fetchTechnicalData(tickers, apiKey) {
  const results = {};
  for (const ticker of tickers.slice(0, 5)) { // max 5 to conserve API calls
    const bars = await fetchOHLCV(ticker, apiKey);
    if (bars && bars.length >= 30) {
      results[ticker] = computeAll(bars);
    }
    // Rate limit delay
    if (tickers.length > 1) await new Promise(r => setTimeout(r, 400));
  }
  return results;
}

function formatTA(ta) {
  if (!ta || ta.error) return 'Insufficient data';
  const lines = [];
  lines.push(`  Price: $${ta.price}`);
  if (ta.rsi2 != null) lines.push(`  RSI(2): ${ta.rsi2}`);
  if (ta.rsi14 != null) lines.push(`  RSI(14): ${ta.rsi14}`);
  if (ta.macd) lines.push(`  MACD: ${ta.macd.macd} | Signal: ${ta.macd.signal} | Histogram: ${ta.macd.histogram} | Crossover: ${ta.macd.crossover}`);
  if (ta.stochastic) lines.push(`  Stochastic: %K=${ta.stochastic.k} %D=${ta.stochastic.d} (${ta.stochastic.signal})`);
  if (ta.williamsR) lines.push(`  Williams %R: ${ta.williamsR.value} (${ta.williamsR.signal})`);
  if (ta.cci) lines.push(`  CCI(20): ${ta.cci.value} (${ta.cci.signal})`);
  if (ta.bollingerBands) lines.push(`  Bollinger: Upper=$${ta.bollingerBands.upper} Mid=$${ta.bollingerBands.middle} Lower=$${ta.bollingerBands.lower} | %B=${ta.bollingerBands.pctB} | BW=${ta.bollingerBands.bandwidth}%`);
  if (ta.atr) lines.push(`  ATR(14): $${ta.atr.atr} (${ta.atr.atrPct}% of price) | 2×ATR Stop: $${ta.atr.stopDistance} | 3×ATR Trail: $${ta.atr.trailingStop}`);
  if (ta.zScore) lines.push(`  Z-Score(20): ${ta.zScore.zScore} (${ta.zScore.interpretation})`);
  if (ta.obv) lines.push(`  OBV Trend: ${ta.obv.trend} | Divergence: ${ta.obv.divergence}`);
  if (ta.volume) lines.push(`  Volume: ${ta.volume.ratio}× avg (${ta.volume.signal})`);
  if (ta.emaAlignment) {
    const e = ta.emaAlignment;
    lines.push(`  EMAs: 9=${e.ema9} 20=${e.ema20} 50=${e.ema50} 200=${e.ema200} | Alignment: ${e.alignment} | Cross: ${e.cross} | vs200: ${e.priceVsEma200Pct}%`);
    lines.push(`  SMAs: 20=${e.sma20} 50=${e.sma50} 200=${e.sma200}`);
  }
  if (ta.fibonacci) {
    const f = ta.fibonacci;
    lines.push(`  Fibonacci (${f.trend}): Swing H=$${f.swingHigh} L=$${f.swingLow}`);
    if (f.nearestSupport) lines.push(`    Nearest Support: $${f.nearestSupport.price} (${f.nearestSupport.fib} retracement)`);
    if (f.nearestResistance) lines.push(`    Nearest Resistance: $${f.nearestResistance.price} (${f.nearestResistance.fib} retracement)`);
  }
  if (ta.onePercentRule) {
    const r = ta.onePercentRule;
    lines.push(`  1% Rule: Max risk $${r.maxRiskDollars} → ${r.maxShares} shares ($${r.positionValue} = ${r.positionPct}% of portfolio)`);
  }
  if (ta._summary?.length) lines.push(`  KEY SIGNALS: ${ta._summary.join(' | ')}`);
  return lines.join('\n');
}

async function createDraft(ticker, strategy, score, reasoning, regime, positionPct, entryPrice, token, alphaKey, signalAttribution) {
  // Reuse create-draft logic inline
  const stop=+(entryPrice*0.93).toFixed(2),tp1=+(entryPrice*1.08).toFixed(2),
        tp2=+(entryPrice*1.15).toFixed(2),tp3=+(entryPrice*1.22).toFixed(2);
  const today=new Date().toISOString().split('T')[0];
  const REGIME_MAP={'MEAN REVERSION ZONE':'Mean Reversion Zone','BREAKOUT ZONE':'Breakout Zone','CAUTION ZONE':'Caution Zone','EXTREME FEAR':'Caution Zone'};
  const regimeName=regime?(REGIME_MAP[regime.toUpperCase()]||regime):null;
  const props={
    'Trade':{title:[{text:{content:`⏳ ${ticker} — ${strategy} [DRAFT]`}}]},
    'Ticker':{rich_text:[{text:{content:ticker}}]},
    'Strategy':{select:{name:strategy}},
    'Status':{select:{name:'Draft'}},
    'Simulation Mode':{checkbox:true},
    'Entry Price':{number:entryPrice},
    'Stop-Loss Price':{number:stop},
    'TP1':{number:tp1},'TP2':{number:tp2},'TP3':{number:tp3},
    'Composite Score':{number:score},
    'What Went Right':{rich_text:[{text:{content:(reasoning||'').slice(0,2000)}}]},
    'Date Opened':{date:{start:today}},
  };
  if(regimeName)props['Market Regime at Entry']={select:{name:regimeName}};
  if(positionPct)props['Position Size %']={number:positionPct};
  // Store signal attribution
  if(signalAttribution&&signalAttribution.length){
    props['Signal Sources']={multi_select:signalAttribution.map(s=>({name:s.source}))};
    props['Signal Attribution']={rich_text:[{text:{content:JSON.stringify(signalAttribution).slice(0,2000)}}]};
  }
  const body=JSON.stringify({parent:{database_id:TRADE_DB},properties:props});
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

  // Fetch technical analysis for open positions + SPY
  const openTickers = openFormatted.map(t => t.ticker).filter(Boolean);
  const taTickers = ['SPY', ...openTickers].slice(0, 5);
  let taData = {};
  if (ALPHA_KEY) {
    try { taData = await fetchTechnicalData(taTickers, ALPHA_KEY); } catch {}
  }

  // Build TA context block
  let taContext = '';
  if (Object.keys(taData).length > 0) {
    taContext = '\n\nCOMPUTED TECHNICAL INDICATORS (from real OHLCV data — use these, do NOT estimate):\n';
    for (const [ticker, ta] of Object.entries(taData)) {
      taContext += `\n${ticker}:\n${formatTA(ta)}\n`;
    }
  }

  // Build context string for Claude
  const context = `
TODAY: ${today}

LIVE MARKET DATA:
- VIX: ${market.vix ? market.vix.toFixed(2) : 'unavailable (check finance.yahoo.com/quote/^VIX)'}
- Fear & Greed: Currently blocked by CNN anti-bot. Use VIX as proxy.
- SPY: ${market.spyPrice ? '$'+market.spyPrice.toFixed(2) : 'unavailable'} | Above 50 EMA: ${taData.SPY?.emaAlignment ? (taData.SPY.emaAlignment.above50?'YES':'NO') + ' (computed: price $'+taData.SPY.price+' vs EMA50 $'+taData.SPY.emaAlignment.ema50+')' : market.spyAbove===null?'approx from VIX':market.spyAbove?'YES':'NO'}
${taContext}

OPEN PAPER TRADES (${openFormatted.length}):
${openFormatted.length ? openFormatted.map(t=>`- ${t.ticker} | ${t.strategy} | Entry: $${t.entry} | Stop: $${t.stop} | TP1: $${t.tp1} | Score: ${t.score} | Opened: ${t.dateOpened}`).join('\n') : 'None'}

RECENT CLOSED TRADES (last ${closedFormatted.length}):
${closedFormatted.length ? closedFormatted.map(t=>`- ${t.ticker} | ${t.strategy} | P&L: ${t.pnl!=null?(t.pnl>0?'+':'')+t.pnl.toFixed(1)+'%':'open'} | Score was: ${t.score||'?'} | Lesson: ${t.lesson||'none'}`).join('\n') : 'None yet'}

USER COMMAND: ${command}

INSTRUCTIONS FOR YOUR RESPONSE:
Respond with a JSON object in this exact structure (no markdown, pure JSON):
{
  "regime": {
    "name": "MEAN REVERSION ZONE|BREAKOUT ZONE|CAUTION ZONE|EXTREME FEAR",
    "headline": "one-line summary",
    "why": "2-3 sentences explaining current conditions",
    "action": "specific recommended action",
    "vix": number,
    "fg": number_or_null,
    "spyAbove": true/false
  },
  "positions": [
    {
      "ticker": "XXXX",
      "recommendation": "HOLD|TAKE_PROFIT|EXIT_NOW|TIGHTEN_STOP",
      "currentPrice": number_or_null,
      "pnlPct": number_or_null,
      "reasoning": "2-3 sentences: why this action, what changed, what to watch",
      "urgency": "urgent|watch|ok",
      "signalAttribution": [
        {
          "source": "Technical Analysis|Capitol Trades|Finviz Screener|CNN Fear & Greed|World Monitor|Earnings Calendar|Insider Activity|Sector Momentum",
          "weight": number_0_to_100,
          "signal": "what this source specifically says now (1 sentence)",
          "verdict": "BULLISH|BEARISH|NEUTRAL"
        }
      ]
    }
  ],
  "opportunities": [
    {
      "ticker": "XXXX",
      "score": number_0_to_100,
      "action": "BUY|WATCHLIST",
      "strategy": "Mean Reversion|Breakout Momentum|Earnings Catalyst",
      "reasoning": "3-4 sentences explaining the setup and why now",
      "entryPrice": number,
      "stop": number,
      "tp1": number,
      "tp2": number,
      "positionPct": number,
      "waitingFor": "only for WATCHLIST — what needs to improve",
      "signalAttribution": [
        {
          "source": "Technical Analysis|Capitol Trades|Finviz Screener|CNN Fear & Greed|World Monitor|Earnings Calendar|Insider Activity|Sector Momentum",
          "weight": number_0_to_100,
          "signal": "what this source specifically said (1 sentence)",
          "verdict": "BULLISH|BEARISH|NEUTRAL"
        }
      ]
    }
  ],
  "insights": "1-2 key portfolio observations from trade history",
  "stance": "Aggressive|Moderate|Defensive",
  "recommendedCash": "XX%",
  "nextCheckIn": "time/date"
}

CRITICAL RULES:
- For "full analysis" or "run investment analysis": ONLY return BUY (score≥65) and WATCHLIST (score 50-64) in opportunities. Do NOT include SKIP entries — they waste space. Focus on actionable items only.
- For "score" commands on a specific ticker: include the full verdict even if SKIP.
- For "portfolio review": focus entirely on positions array with detailed actions. Opportunities array can be empty.
- Every BUY must have stop, tp1, tp2, positionPct. Do NOT include entryPrice — the system will fetch the live price automatically. If you don't know the current price, still recommend the trade; the system handles pricing.
- Every position must have a specific recommendation and reasoning. Never say "monitor" — say exactly what to do.
- Be specific with price levels and percentages. The user needs exact numbers to act on.
- USE THE COMPUTED TECHNICAL INDICATORS above — they are calculated from real OHLCV data. Refer to specific RSI, MACD, Bollinger, Z-Score, Fibonacci, OBV, volume ratio values in your reasoning.
- Apply the 1% Rule: never risk more than 1% of portfolio ($1,000 on $100k) on any single trade. Use the computed 1% rule max shares as a guide.
- Reference Fibonacci support/resistance levels for entry/exit targets when available.
- If OBV shows bearish divergence (price up but volume not confirming), flag it as a warning.
- Z-Score below -2 is a strong mean reversion signal; above +2 is overbought warning.
- In your reasoning for each position/opportunity, cite at least 2-3 specific indicator values.

SIGNAL ATTRIBUTION RULES:
- Every position and opportunity MUST include a "signalAttribution" array with ALL 6 core sources.
- Each entry has: source (exact name from list), weight (0-100, all weights must sum to 100), signal (1 sentence what this source specifically says for THIS ticker), verdict (BULLISH/BEARISH/NEUTRAL/NO_DATA).
- ALWAYS include ALL of these 6 sources for every ticker:
  1. "Technical Analysis" — cite specific RSI, MACD, Z-Score, Bollinger, OBV values from computed data above
  2. "CNN Fear & Greed" — current market sentiment from VIX/F&G. If VIX data available, use it as proxy
  3. "Capitol Trades" — any known congressional trading activity for this ticker. If none known, say "No recent congressional trades detected" with verdict NO_DATA and weight 0
  4. "Finviz Screener" — whether this ticker appears in oversold/breakout screeners based on its current technicals. Infer from the computed indicators whether it would show up
  5. "Earnings Calendar" — proximity to next earnings, whether it's a catalyst or risk. If unknown, estimate from typical schedule
  6. "Sector Momentum" — how this ticker's sector is performing (tech, gold, healthcare, etc.)
- Optionally add "World Monitor" (geopolitical risk) or "Insider Activity" if relevant
- Sources with NO_DATA get weight 0. Remaining weights must sum to 100.
- The signal field should explain HOW this source affected the analysis — not just state a fact but connect it to the recommendation.`;


  // Load system prompt from skill
  const fs = require('fs');
  const skillPath = '/var/task/investment-skill.md'; // will be embedded at build
  let systemPrompt = `You are Daniel's personal investment analyst. Apply the composite scoring framework rigorously. Return only valid JSON, no markdown.

You have access to COMPUTED technical indicators (RSI, MACD, Bollinger Bands, ATR, OBV, Z-Score, Stochastic, Williams %R, CCI, Fibonacci retracement, SMA/EMA alignment) calculated from real OHLCV price data. ALWAYS reference these computed values in your analysis — do not estimate or guess indicator values when real data is provided.

Scoring framework additions:
- Z-Score < -2: +3pts to Technical Setup (statistically extreme oversold)
- Z-Score > +2: -3pts (overbought warning)
- OBV bullish divergence (price down, volume accumulating): +3pts
- OBV bearish divergence (price up, volume dropping): -3pts
- Stochastic bullish cross in oversold zone: +2pts
- Stochastic bearish cross in overbought zone: -2pts
- Fibonacci: if price is at 0.618 or 0.786 retracement support: +2pts
- Bollinger %B < 0.05 (at lower band): +2pts for mean reversion
- 1% Rule: if computed position size exceeds 5% of portfolio, cap at 5%
- ATR-based stops: prefer 2×ATR stop over fixed 7% when ATR data available`;

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
        // ALWAYS fetch live price — never trust Claude's price suggestion
        let price = null;
        try {
          const pr = await httpsGet(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${opp.ticker}&apikey=${ALPHA_KEY}`);
          const q = JSON.parse(pr.body)['Global Quote'];
          price = q?.['05. price'] ? parseFloat(q['05. price']) : null;
        } catch{}

        // No live price = skip this ticker entirely
        if (!price) {
          opp.reasoning = `⚠️ SKIPPED DRAFT: Could not fetch live price for ${opp.ticker}. Draft not created. | ${opp.reasoning}`;
          continue;
        }

        {
          const draft = await createDraft(
            opp.ticker, opp.strategy, opp.score,
            opp.reasoning, analysis.regime?.name,
            opp.positionPct, price, NOTION_TOKEN, ALPHA_KEY,
            opp.signalAttribution
          );
          if (draft.ok) draftsCreated.push(draft);
        }
      }
    }
  }

  analysis.draftsCreated = draftsCreated;
  res.json(analysis);
};
