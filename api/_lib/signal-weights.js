// Signal Source Performance Tracking
// Implements Multiplicative Weights Update (MWU) algorithm
// Computes source reliability weights from closed trade history
//
// Algorithm: each source starts at weight 1.0
// After each trade resolves:
//   - Sources attributed to WINNING trades: weight *= (1 + eta * weight_contribution)
//   - Sources attributed to LOSING trades: weight *= (1 - eta * weight_contribution)
// Where eta is the learning rate (0.1 = moderate, 0.2 = aggressive)
// weight_contribution is the normalized attribution weight for that source in that trade

const SOURCES = [
  'Technical Analysis',
  'CNN Fear & Greed',
  'Capitol Trades',
  'Finviz Screener',
  'Earnings Calendar',
  'Sector Momentum',
  'World Monitor',
  'Quiver Quantitative',
];

const DEFAULT_ETA = 0.15; // learning rate
const MIN_WEIGHT = 0.1;   // floor — never zero out a source completely

function computeSourceWeights(closedTrades, eta = DEFAULT_ETA) {
  // Initialize all sources at equal weight
  const weights = {};
  for (const s of SOURCES) weights[s] = 1.0;

  // Track per-source stats
  const stats = {};
  for (const s of SOURCES) stats[s] = { wins: 0, losses: 0, totalTrades: 0, totalWeight: 0, avgWeight: 0 };

  // Process trades chronologically
  const trades = [...closedTrades]
    .filter(t => t.pnlPct != null && t.signalAttribution && t.signalAttribution.length > 0)
    .sort((a, b) => (a.dateClosed || '').localeCompare(b.dateClosed || ''));

  for (const trade of trades) {
    const isWin = trade.pnlPct > 0;
    const attribution = trade.signalAttribution;

    // Parse attribution — handle both array and JSON string formats
    let sources = [];
    if (typeof attribution === 'string') {
      try { sources = JSON.parse(attribution); } catch { continue; }
    } else if (Array.isArray(attribution)) {
      sources = attribution;
    }
    if (!sources.length) continue;

    // Normalize weights to sum to 1
    const totalAttrWeight = sources.reduce((s, a) => s + (a.weight || 0), 0);
    if (totalAttrWeight === 0) continue;

    for (const attr of sources) {
      const name = attr.source;
      if (!weights[name]) { weights[name] = 1.0; stats[name] = { wins: 0, losses: 0, totalTrades: 0, totalWeight: 0, avgWeight: 0 }; }
      const contribution = (attr.weight || 0) / totalAttrWeight;

      if (contribution === 0) continue; // NO_DATA source, skip

      stats[name].totalTrades++;
      stats[name].totalWeight += attr.weight || 0;

      if (isWin) {
        stats[name].wins++;
        weights[name] *= (1 + eta * contribution);
      } else {
        stats[name].losses++;
        weights[name] *= (1 - eta * contribution);
      }

      // Floor
      if (weights[name] < MIN_WEIGHT) weights[name] = MIN_WEIGHT;
    }
  }

  // Normalize weights to sum to 100
  const totalWeight = Object.values(weights).reduce((s, w) => s + w, 0);
  const normalized = {};
  for (const [s, w] of Object.entries(weights)) {
    normalized[s] = +(w / totalWeight * 100).toFixed(1);
  }

  // Compute average attribution weight per source
  for (const s of Object.keys(stats)) {
    stats[s].avgWeight = stats[s].totalTrades > 0
      ? +(stats[s].totalWeight / stats[s].totalTrades).toFixed(1)
      : 0;
  }

  // Rank sources
  const ranked = Object.entries(normalized)
    .sort((a, b) => b[1] - a[1])
    .map(([source, weight], i) => ({
      rank: i + 1,
      source,
      weight,
      rawWeight: +weights[source].toFixed(3),
      winRate: stats[source].totalTrades > 0
        ? Math.round(stats[source].wins / stats[source].totalTrades * 100)
        : null,
      wins: stats[source].wins,
      losses: stats[source].losses,
      totalTrades: stats[source].totalTrades,
      avgAttrWeight: stats[source].avgWeight,
      confidence: stats[source].totalTrades >= 10 ? 'high' :
                  stats[source].totalTrades >= 5 ? 'medium' :
                  stats[source].totalTrades >= 1 ? 'low' : 'no_data',
    }));

  return {
    ranked,
    tradesAnalyzed: trades.length,
    eta,
    topSource: ranked[0]?.source || null,
    weakestSource: ranked[ranked.length - 1]?.source || null,
  };
}

// Portfolio performance metrics
function computePortfolioMetrics(closedTrades) {
  const trades = closedTrades.filter(t => t.pnlPct != null);
  if (!trades.length) return null;

  const pnls = trades.map(t => t.pnlPct);
  const cumulative = [];
  let running = 0;
  for (const p of pnls) { running += p; cumulative.push(running); }

  // Max drawdown
  let peak = -Infinity, maxDD = 0;
  for (const c of cumulative) {
    if (c > peak) peak = c;
    const dd = peak - c;
    if (dd > maxDD) maxDD = dd;
  }

  // Win/loss streaks
  let currentStreak = 0, maxWinStreak = 0, maxLossStreak = 0;
  for (const p of pnls) {
    if (p > 0) {
      currentStreak = currentStreak > 0 ? currentStreak + 1 : 1;
      if (currentStreak > maxWinStreak) maxWinStreak = currentStreak;
    } else {
      currentStreak = currentStreak < 0 ? currentStreak - 1 : -1;
      if (Math.abs(currentStreak) > maxLossStreak) maxLossStreak = Math.abs(currentStreak);
    }
  }

  // Average win vs loss
  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p <= 0);
  const avgWin = wins.length ? wins.reduce((s, p) => s + p, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, p) => s + p, 0) / losses.length : 0;

  // Profit factor
  const grossProfit = wins.reduce((s, p) => s + p, 0);
  const grossLoss = Math.abs(losses.reduce((s, p) => s + p, 0));
  const profitFactor = grossLoss > 0 ? +(grossProfit / grossLoss).toFixed(2) : Infinity;

  // Expectancy per trade
  const expectancy = +(pnls.reduce((s, p) => s + p, 0) / pnls.length).toFixed(2);

  return {
    totalTrades: trades.length,
    winRate: Math.round(wins.length / trades.length * 100),
    avgWin: +avgWin.toFixed(2),
    avgLoss: +avgLoss.toFixed(2),
    profitFactor,
    expectancy,
    totalReturn: +running.toFixed(2),
    maxDrawdown: +maxDD.toFixed(2),
    maxWinStreak,
    maxLossStreak,
    riskRewardRatio: avgLoss !== 0 ? +Math.abs(avgWin / avgLoss).toFixed(2) : null,
  };
}

module.exports = { computeSourceWeights, computePortfolioMetrics, SOURCES };
