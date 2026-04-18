// Diagnostic Analysis Engine (Layer 2)
// Cross-dimensional analysis of closed trades to find patterns,
// weaknesses, and improvement opportunities.
//
// Dimensions analyzed:
// 1. Regime-specific performance
// 2. Strategy performance
// 3. Stop-loss tightness (% stopped out that recovered)
// 4. Signal source combination correlations
// 5. Entry timing decay
// 6. Position sizing efficiency
// 7. Sector concentration

function runDiagnostics(closedTrades, openTrades = []) {
  const trades = closedTrades.filter(t => t.pnlPct != null);
  if (!trades.length) return { error: 'No closed trades to analyze', findings: [] };

  const findings = [];
  const wins = trades.filter(t => t.pnlPct > 0);
  const losses = trades.filter(t => t.pnlPct <= 0);
  const winRate = trades.length ? Math.round(wins.length / trades.length * 100) : 0;

  // ── 1. Regime-specific performance ──────────────────────────────────
  const byRegime = {};
  for (const t of trades) {
    const regime = t.regime || t.marketRegime || 'Unknown';
    if (!byRegime[regime]) byRegime[regime] = { wins: 0, losses: 0, trades: [], totalPnl: 0 };
    byRegime[regime].trades.push(t);
    byRegime[regime].totalPnl += t.pnlPct;
    if (t.pnlPct > 0) byRegime[regime].wins++;
    else byRegime[regime].losses++;
  }

  for (const [regime, data] of Object.entries(byRegime)) {
    const regimeWR = data.trades.length ? Math.round(data.wins / data.trades.length * 100) : 0;
    if (data.trades.length >= 3 && regimeWR < 40) {
      findings.push({
        category: 'regime',
        severity: regimeWR === 0 ? 'critical' : 'high',
        finding: `${regime}: ${regimeWR}% win rate (${data.wins}W/${data.losses}L)`,
        detail: `Poor performance in ${regime}. Total P&L: ${data.totalPnl.toFixed(1)}%. Consider requiring higher score threshold or avoiding this regime entirely.`,
        evidence: data.trades.map(t => `${t.ticker}: ${t.pnlPct > 0 ? '+' : ''}${t.pnlPct.toFixed(1)}%`).join(', '),
        suggestion: {
          category: 'regime',
          paramBefore: 'Draft threshold: 65 in all regimes',
          paramAfter: `Draft threshold: ${regimeWR === 0 ? 85 : 80} in ${regime}`,
          suggestedMinScore: regimeWR === 0 ? 85 : 80,
          regimeSpecific: regime,
          priority: regimeWR === 0 ? 'Critical' : 'High',
        },
      });
    }
    if (data.trades.length >= 3 && regimeWR >= 70) {
      findings.push({
        category: 'regime',
        severity: 'positive',
        finding: `${regime}: ${regimeWR}% win rate (${data.wins}W/${data.losses}L) — strong`,
        detail: `This regime is working well. Consider increasing position sizes here.`,
        evidence: data.trades.map(t => `${t.ticker}: ${t.pnlPct > 0 ? '+' : ''}${t.pnlPct.toFixed(1)}%`).join(', '),
        suggestion: null,
      });
    }
  }

  // ── 2. Strategy performance ─────────────────────────────────────────
  const byStrategy = {};
  for (const t of trades) {
    const strat = t.strategy || 'Unknown';
    if (!byStrategy[strat]) byStrategy[strat] = { wins: 0, losses: 0, trades: [], totalPnl: 0 };
    byStrategy[strat].trades.push(t);
    byStrategy[strat].totalPnl += t.pnlPct;
    if (t.pnlPct > 0) byStrategy[strat].wins++;
    else byStrategy[strat].losses++;
  }

  for (const [strat, data] of Object.entries(byStrategy)) {
    const stratWR = data.trades.length ? Math.round(data.wins / data.trades.length * 100) : 0;
    if (data.trades.length >= 3 && stratWR < 40) {
      findings.push({
        category: 'strategy',
        severity: 'high',
        finding: `${strat} strategy: ${stratWR}% win rate (${data.wins}W/${data.losses}L)`,
        detail: `Strategy underperforming. Avg P&L: ${(data.totalPnl / data.trades.length).toFixed(1)}%. Consider deprioritizing or tightening entry criteria.`,
        evidence: data.trades.map(t => `${t.ticker}: ${t.pnlPct > 0 ? '+' : ''}${t.pnlPct.toFixed(1)}%`).join(', '),
        suggestion: {
          category: 'strategy',
          paramBefore: `${strat}: standard scoring`,
          paramAfter: `${strat}: require score >= 75 (was 65) or deprioritize in prompt`,
          priority: 'High',
        },
      });
    }
  }

  // ── 3. Stop-loss analysis ───────────────────────────────────────────
  const stoppedOut = trades.filter(t =>
    t.closeReason === 'Stopped Out' || t.status === 'Stopped Out'
  );
  if (stoppedOut.length >= 2) {
    // Check average loss on stopped-out trades
    const avgStopLoss = stoppedOut.reduce((s, t) => s + Math.abs(t.pnlPct), 0) / stoppedOut.length;
    const stopRatio = trades.length ? Math.round(stoppedOut.length / trades.length * 100) : 0;

    if (stopRatio > 40) {
      findings.push({
        category: 'stop-loss',
        severity: 'high',
        finding: `${stopRatio}% of trades stopped out (${stoppedOut.length}/${trades.length})`,
        detail: `Stops may be too tight. Average stop-loss: -${avgStopLoss.toFixed(1)}%. Consider widening ATR multiplier.`,
        evidence: stoppedOut.map(t => `${t.ticker}: ${t.pnlPct.toFixed(1)}% (${t.daysHeld || '?'} days)`).join(', '),
        suggestion: {
          category: 'stop-loss',
          paramBefore: 'ATR multiplier: 2x, fixed stop: 7%',
          paramAfter: 'ATR multiplier: 2.5x, minimum stop distance: 8%',
          priority: 'High',
        },
      });
    }

    // Check if stopped-out trades had quick reversals (held < 3 days)
    const quickStops = stoppedOut.filter(t => t.daysHeld && t.daysHeld <= 2);
    if (quickStops.length >= 2 && quickStops.length / stoppedOut.length > 0.5) {
      findings.push({
        category: 'stop-loss',
        severity: 'medium',
        finding: `${quickStops.length}/${stoppedOut.length} stops hit within 2 days — possible whipsaw`,
        detail: `Over half of stopped-out trades were hit very quickly, suggesting stops are catching normal volatility rather than genuine reversals.`,
        evidence: quickStops.map(t => `${t.ticker}: stopped day ${t.daysHeld}`).join(', '),
        suggestion: {
          category: 'stop-loss',
          paramBefore: 'Stop active immediately',
          paramAfter: 'Consider 1-day grace period or wider initial stop that tightens after day 2',
          priority: 'Medium',
        },
      });
    }
  }

  // ── 4. Signal source combination analysis ───────────────────────────
  const comboCounts = {}; // "TA+WM" -> { wins, losses }
  for (const t of trades) {
    let sources = t.signalAttribution;
    if (typeof sources === 'string') {
      try { sources = JSON.parse(sources); } catch { continue; }
    }
    if (!Array.isArray(sources)) continue;

    const bullish = sources
      .filter(s => s.verdict === 'BULLISH' && s.weight > 10)
      .map(s => s.source)
      .sort();

    if (bullish.length >= 2) {
      // Track pairwise combinations
      for (let i = 0; i < bullish.length; i++) {
        for (let j = i + 1; j < bullish.length; j++) {
          const key = `${bullish[i]} + ${bullish[j]}`;
          if (!comboCounts[key]) comboCounts[key] = { wins: 0, losses: 0 };
          if (t.pnlPct > 0) comboCounts[key].wins++;
          else comboCounts[key].losses++;
        }
      }
    }
  }

  const combos = Object.entries(comboCounts)
    .filter(([, d]) => d.wins + d.losses >= 3)
    .map(([combo, d]) => ({
      combo,
      total: d.wins + d.losses,
      winRate: Math.round(d.wins / (d.wins + d.losses) * 100),
      ...d,
    }))
    .sort((a, b) => b.winRate - a.winRate);

  if (combos.length > 0) {
    const best = combos[0];
    const worst = combos[combos.length - 1];

    if (best.winRate >= 70) {
      findings.push({
        category: 'signal-weights',
        severity: 'positive',
        finding: `Best combo: ${best.combo} → ${best.winRate}% win rate (${best.wins}W/${best.losses}L)`,
        detail: `When these two sources agree on BULLISH, trades tend to win. Consider requiring both for BUY recommendations.`,
        evidence: `${best.total} trades with this combination`,
        suggestion: {
          category: 'signal-weights',
          paramBefore: 'No source consensus requirement',
          paramAfter: `Require ${best.combo} consensus for BUY (${best.winRate}% historical win rate)`,
          priority: 'Medium',
        },
      });
    }

    if (worst.winRate < 35 && worst.total >= 3) {
      findings.push({
        category: 'signal-weights',
        severity: 'medium',
        finding: `Weak combo: ${worst.combo} → ${worst.winRate}% win rate (${worst.wins}W/${worst.losses}L)`,
        detail: `This source combination has poor predictive power. Consider reducing weight when these are the primary signals.`,
        evidence: `${worst.total} trades with this combination`,
        suggestion: {
          category: 'signal-weights',
          paramBefore: 'Equal treatment of all source combinations',
          paramAfter: `Flag ${worst.combo} disagreement as risk factor (-5 to composite score)`,
          priority: 'Low',
        },
      });
    }
  }

  // ── 5. Position sizing efficiency ───────────────────────────────────
  const largeTrades = trades.filter(t => t.positionPct && t.positionPct > 5);
  const smallTrades = trades.filter(t => t.positionPct && t.positionPct <= 5);

  if (largeTrades.length >= 2 && smallTrades.length >= 2) {
    const largeWR = Math.round(largeTrades.filter(t => t.pnlPct > 0).length / largeTrades.length * 100);
    const smallWR = Math.round(smallTrades.filter(t => t.pnlPct > 0).length / smallTrades.length * 100);

    if (largeWR < smallWR - 15) {
      findings.push({
        category: 'position-sizing',
        severity: 'medium',
        finding: `Large positions (>5%): ${largeWR}% WR vs Small (≤5%): ${smallWR}% WR`,
        detail: `Larger positions are underperforming. This suggests overconfidence on sizing or that conviction doesn't correlate with outcomes.`,
        evidence: `Large: ${largeTrades.length} trades, Small: ${smallTrades.length} trades`,
        suggestion: {
          category: 'position-sizing',
          paramBefore: 'Max position: 8%',
          paramAfter: 'Cap at 5% until large-position win rate improves',
          priority: 'Medium',
        },
      });
    }
  }

  // ── 6. Sector concentration ─────────────────────────────────────────
  const sectorGuess = (ticker) => {
    const techTickers = ['AAPL','MSFT','GOOGL','GOOG','META','NVDA','AMD','AMZN','TSLA','CRM','ORCL','ADBE','INTC','AVGO','QCOM'];
    const goldTickers = ['GLD','GDX','GDXJ','NEM','GOLD','AEM','FNV'];
    const defTickers = ['NOC','LMT','RTX','GD','BA','HII'];
    if (techTickers.includes(ticker)) return 'Tech';
    if (goldTickers.includes(ticker)) return 'Gold/Materials';
    if (defTickers.includes(ticker)) return 'Defense';
    return 'Other';
  };

  const openSectors = {};
  for (const t of openTrades) {
    const sector = sectorGuess(t.ticker || '');
    openSectors[sector] = (openSectors[sector] || 0) + 1;
  }

  const totalOpen = openTrades.length;
  for (const [sector, count] of Object.entries(openSectors)) {
    if (totalOpen >= 4 && count / totalOpen > 0.5) {
      findings.push({
        category: 'diversification',
        severity: 'medium',
        finding: `${Math.round(count / totalOpen * 100)}% of open positions in ${sector} (${count}/${totalOpen})`,
        detail: `Heavy sector concentration increases correlated risk. A sector-wide downturn would hit multiple positions simultaneously.`,
        evidence: openTrades.filter(t => sectorGuess(t.ticker || '') === sector).map(t => t.ticker).join(', '),
        suggestion: {
          category: 'diversification',
          paramBefore: 'No sector limit',
          paramAfter: `Max 40% of positions in any single sector. Currently ${sector} at ${Math.round(count / totalOpen * 100)}%`,
          priority: 'Medium',
        },
      });
    }
  }

  // ── 7. Days held analysis ───────────────────────────────────────────
  const withDays = trades.filter(t => t.daysHeld != null);
  if (withDays.length >= 5) {
    const shortTrades = withDays.filter(t => t.daysHeld <= 3);
    const medTrades = withDays.filter(t => t.daysHeld > 3 && t.daysHeld <= 10);
    const longTrades = withDays.filter(t => t.daysHeld > 10);

    const groups = [
      { label: '1-3 days', trades: shortTrades },
      { label: '4-10 days', trades: medTrades },
      { label: '10+ days', trades: longTrades },
    ].filter(g => g.trades.length >= 2);

    const bestGroup = groups.reduce((best, g) => {
      const wr = g.trades.length ? g.trades.filter(t => t.pnlPct > 0).length / g.trades.length : 0;
      return wr > (best.wr || 0) ? { ...g, wr } : best;
    }, {});

    if (bestGroup.label && bestGroup.wr > 0.6) {
      findings.push({
        category: 'strategy',
        severity: 'info',
        finding: `Best hold period: ${bestGroup.label} (${Math.round(bestGroup.wr * 100)}% WR, ${bestGroup.trades.length} trades)`,
        detail: `Trades held ${bestGroup.label} perform best. Consider adjusting time stops to match.`,
        evidence: bestGroup.trades.map(t => `${t.ticker}: ${t.daysHeld}d → ${t.pnlPct > 0 ? '+' : ''}${t.pnlPct.toFixed(1)}%`).join(', '),
        suggestion: null,
      });
    }
  }

  // ── 8. Score calibration ────────────────────────────────────────────
  const withScore = trades.filter(t => t.score != null);
  if (withScore.length >= 5) {
    const highScore = withScore.filter(t => t.score >= 75);
    const midScore = withScore.filter(t => t.score >= 60 && t.score < 75);
    const lowScore = withScore.filter(t => t.score < 60);

    if (midScore.length >= 3) {
      const midWR = Math.round(midScore.filter(t => t.pnlPct > 0).length / midScore.length * 100);
      if (midWR < 40) {
        findings.push({
          category: 'scoring',
          severity: 'high',
          finding: `Score 60-74 band: ${midWR}% win rate (${midScore.length} trades) — scores not calibrated`,
          detail: `Mid-range scores are losing money. The scoring model may be inflating scores. Consider raising the draft threshold.`,
          evidence: midScore.map(t => `${t.ticker}(${t.score}): ${t.pnlPct > 0 ? '+' : ''}${t.pnlPct.toFixed(1)}%`).join(', '),
          suggestion: {
            category: 'scoring',
            paramBefore: 'Draft threshold: score >= 65',
            paramAfter: 'Draft threshold: score >= 75 (mid-range scores are unreliable)',
            suggestedMinScore: 75,
            priority: 'High',
          },
        });
      }
    }

    if (highScore.length >= 3) {
      const highWR = Math.round(highScore.filter(t => t.pnlPct > 0).length / highScore.length * 100);
      if (highWR < 50) {
        findings.push({
          category: 'scoring',
          severity: 'critical',
          finding: `Even high scores (75+) only win ${highWR}% — scoring model is broken`,
          detail: `High-conviction scores aren't predicting outcomes. The entire scoring framework may need recalibration.`,
          evidence: highScore.map(t => `${t.ticker}(${t.score}): ${t.pnlPct > 0 ? '+' : ''}${t.pnlPct.toFixed(1)}%`).join(', '),
          suggestion: {
            category: 'scoring',
            paramBefore: 'Current composite scoring weights',
            paramAfter: 'Recalibrate scoring: increase weight of Technical Setup, reduce Fundamental (based on actual outcomes)',
            suggestedMinScore: 80,
            priority: 'Critical',
          },
        });
      }
    }
  }

  // Sort findings: critical first, then high, medium, positive, info
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4, positive: 5 };
  findings.sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9));

  return {
    summary: {
      totalTrades: trades.length,
      winRate,
      wins: wins.length,
      losses: losses.length,
      avgWinPct: wins.length ? +(wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length).toFixed(2) : 0,
      avgLossPct: losses.length ? +(losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length).toFixed(2) : 0,
      byRegime,
      byStrategy,
      signalCombos: combos.slice(0, 5),
    },
    findings,
    suggestions: findings.filter(f => f.suggestion).map(f => f.suggestion),
    criticalCount: findings.filter(f => f.severity === 'critical').length,
    highCount: findings.filter(f => f.severity === 'high').length,
    positiveCount: findings.filter(f => f.severity === 'positive').length,
  };
}

module.exports = { runDiagnostics };
