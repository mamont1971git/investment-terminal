/**
 * Technical Analysis Indicators Library
 * All functions expect arrays of OHLCV objects sorted oldest → newest:
 *   { date, open, high, low, close, volume }
 */

// ─── Moving Averages ───────────────────────────────────────────────────────

function SMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return +(slice.reduce((s, v) => s + v, 0) / period).toFixed(4);
}

function EMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return +ema.toFixed(4);
}

function allEMAs(closes) {
  return {
    ema9: EMA(closes, 9),
    ema20: EMA(closes, 20),
    ema50: EMA(closes, 50),
    ema200: EMA(closes, 200),
  };
}

function allSMAs(closes) {
  return {
    sma20: SMA(closes, 20),
    sma50: SMA(closes, 50),
    sma200: SMA(closes, 200),
  };
}

// ─── RSI ────────────────────────────────────────────────────────────────────

function RSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return +(100 - 100 / (1 + rs)).toFixed(2);
}

// ─── MACD ───────────────────────────────────────────────────────────────────

function MACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  // compute EMA series
  function emaSeries(data, period) {
    const k = 2 / (period + 1);
    const result = [];
    let ema = data.slice(0, period).reduce((s, v) => s + v, 0) / period;
    for (let i = 0; i < period; i++) result.push(null);
    result[period - 1] = ema;
    for (let i = period; i < data.length; i++) {
      ema = data[i] * k + ema * (1 - k);
      result.push(ema);
    }
    return result;
  }
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const macdLine = [];
  for (let i = 0; i < closes.length; i++) {
    if (emaFast[i] != null && emaSlow[i] != null) macdLine.push(emaFast[i] - emaSlow[i]);
    else macdLine.push(null);
  }
  const validMacd = macdLine.filter(v => v != null);
  if (validMacd.length < signal) return null;
  const signalLine = emaSeries(validMacd, signal);
  const macd = validMacd[validMacd.length - 1];
  const sig = signalLine[signalLine.length - 1];
  const histogram = macd - sig;

  // Detect crossover: look at last 2 valid MACD values vs signal
  let crossover = 'none';
  if (validMacd.length >= 2 && signalLine.length >= 2) {
    const prevMacd = validMacd[validMacd.length - 2];
    const prevSig = signalLine[signalLine.length - 2];
    if (prevSig != null) {
      if (prevMacd <= prevSig && macd > sig) crossover = 'bullish';
      if (prevMacd >= prevSig && macd < sig) crossover = 'bearish';
    }
  }

  return {
    macd: +macd.toFixed(4),
    signal: +sig.toFixed(4),
    histogram: +histogram.toFixed(4),
    crossover,
  };
}

// ─── Bollinger Bands ────────────────────────────────────────────────────────

function BollingerBands(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((s, v) => s + v, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  const price = closes[closes.length - 1];
  const upper = mean + mult * std;
  const lower = mean - mult * std;
  return {
    upper: +upper.toFixed(4),
    middle: +mean.toFixed(4),
    lower: +lower.toFixed(4),
    bandwidth: +((upper - lower) / mean * 100).toFixed(2),
    pctB: std > 0 ? +((price - lower) / (upper - lower)).toFixed(4) : 0.5, // 0=at lower, 1=at upper
  };
}

// ─── ATR (Average True Range) ───────────────────────────────────────────────

function ATR(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    );
    trs.push(tr);
  }
  if (trs.length < period) return null;
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  const price = bars[bars.length - 1].close;
  return {
    atr: +atr.toFixed(4),
    atrPct: +((atr / price) * 100).toFixed(2), // ATR as % of price
    stopDistance: +(atr * 2).toFixed(2),  // 2× ATR stop suggestion
    trailingStop: +(price - atr * 3).toFixed(2), // 3× ATR trailing for TP3
  };
}

// ─── OBV (On-Balance Volume) ────────────────────────────────────────────────

function OBV(bars) {
  if (bars.length < 20) return null;
  let obv = 0;
  const obvSeries = [0];
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].close > bars[i - 1].close) obv += bars[i].volume;
    else if (bars[i].close < bars[i - 1].close) obv -= bars[i].volume;
    obvSeries.push(obv);
  }
  // OBV trend: compare last 5-day OBV avg vs previous 5-day
  const recent5 = obvSeries.slice(-5);
  const prev5 = obvSeries.slice(-10, -5);
  const recentAvg = recent5.reduce((s, v) => s + v, 0) / recent5.length;
  const prevAvg = prev5.length ? prev5.reduce((s, v) => s + v, 0) / prev5.length : recentAvg;
  let trend = 'flat';
  if (recentAvg > prevAvg * 1.05) trend = 'rising';
  else if (recentAvg < prevAvg * 0.95) trend = 'falling';

  // Price-OBV divergence: price rising but OBV falling = bearish divergence
  const priceUp = bars[bars.length - 1].close > bars[bars.length - 6]?.close;
  const obvUp = recentAvg > prevAvg;
  let divergence = 'none';
  if (priceUp && !obvUp) divergence = 'bearish'; // price up, volume not confirming
  if (!priceUp && obvUp) divergence = 'bullish'; // price down, but accumulation

  return {
    obv: Math.round(obv),
    trend,
    divergence,
  };
}

// ─── Z-Score ────────────────────────────────────────────────────────────────

function ZScore(closes, period = 20) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((s, v) => s + v, 0) / period;
  const std = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  if (std === 0) return { zScore: 0, interpretation: 'no variance' };
  const z = (closes[closes.length - 1] - mean) / std;
  let interpretation = 'normal';
  if (z < -2) interpretation = 'extremely oversold';
  else if (z < -1) interpretation = 'oversold';
  else if (z > 2) interpretation = 'extremely overbought';
  else if (z > 1) interpretation = 'overbought';
  return {
    zScore: +z.toFixed(3),
    mean: +mean.toFixed(2),
    stdDev: +std.toFixed(4),
    interpretation,
  };
}

// ─── Stochastic Oscillator ──────────────────────────────────────────────────

function Stochastic(bars, kPeriod = 14, dPeriod = 3) {
  if (bars.length < kPeriod + dPeriod) return null;
  const kValues = [];
  for (let i = kPeriod - 1; i < bars.length; i++) {
    const slice = bars.slice(i - kPeriod + 1, i + 1);
    const high = Math.max(...slice.map(b => b.high));
    const low = Math.min(...slice.map(b => b.low));
    const k = high === low ? 50 : ((bars[i].close - low) / (high - low)) * 100;
    kValues.push(k);
  }
  // %D = SMA of %K
  const d = kValues.length >= dPeriod
    ? kValues.slice(-dPeriod).reduce((s, v) => s + v, 0) / dPeriod
    : kValues[kValues.length - 1];
  const k = kValues[kValues.length - 1];
  let signal = 'neutral';
  if (k < 20 && d < 20) signal = 'oversold';
  else if (k > 80 && d > 80) signal = 'overbought';
  // Crossover
  if (kValues.length >= 2) {
    const prevK = kValues[kValues.length - 2];
    if (prevK <= d && k > d && k < 30) signal = 'bullish_cross';
    if (prevK >= d && k < d && k > 70) signal = 'bearish_cross';
  }
  return { k: +k.toFixed(2), d: +d.toFixed(2), signal };
}

// ─── Williams %R ────────────────────────────────────────────────────────────

function WilliamsR(bars, period = 14) {
  if (bars.length < period) return null;
  const slice = bars.slice(-period);
  const high = Math.max(...slice.map(b => b.high));
  const low = Math.min(...slice.map(b => b.low));
  if (high === low) return { value: -50, signal: 'neutral' };
  const r = ((high - bars[bars.length - 1].close) / (high - low)) * -100;
  let signal = 'neutral';
  if (r < -80) signal = 'oversold';
  else if (r > -20) signal = 'overbought';
  return { value: +r.toFixed(2), signal };
}

// ─── CCI (Commodity Channel Index) ──────────────────────────────────────────

function CCI(bars, period = 20) {
  if (bars.length < period) return null;
  const typicals = bars.map(b => (b.high + b.low + b.close) / 3);
  const slice = typicals.slice(-period);
  const mean = slice.reduce((s, v) => s + v, 0) / period;
  const meanDev = slice.reduce((s, v) => s + Math.abs(v - mean), 0) / period;
  if (meanDev === 0) return { value: 0, signal: 'neutral' };
  const cci = (typicals[typicals.length - 1] - mean) / (0.015 * meanDev);
  let signal = 'neutral';
  if (cci < -100) signal = 'oversold';
  else if (cci > 100) signal = 'overbought';
  return { value: +cci.toFixed(2), signal };
}

// ─── Fibonacci Retracement Levels ───────────────────────────────────────────

function FibonacciRetracement(bars, lookback = 60) {
  if (bars.length < lookback) return null;
  const slice = bars.slice(-lookback);
  // Find swing high and swing low
  let swingHigh = -Infinity, swingLow = Infinity;
  let highIdx = 0, lowIdx = 0;
  for (let i = 0; i < slice.length; i++) {
    if (slice[i].high > swingHigh) { swingHigh = slice[i].high; highIdx = i; }
    if (slice[i].low < swingLow) { swingLow = slice[i].low; lowIdx = i; }
  }
  const range = swingHigh - swingLow;
  if (range === 0) return null;
  const currentPrice = bars[bars.length - 1].close;

  // Determine direction: if high came after low, it's an uptrend (retrace down)
  const uptrend = highIdx > lowIdx;
  const levels = {};
  const fibs = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

  if (uptrend) {
    // Retracement from high: levels below the high
    for (const f of fibs) {
      levels[f.toString()] = +(swingHigh - range * f).toFixed(2);
    }
  } else {
    // Retracement from low: levels above the low
    for (const f of fibs) {
      levels[f.toString()] = +(swingLow + range * f).toFixed(2);
    }
  }

  // Find nearest support/resistance
  const levelValues = Object.entries(levels);
  let nearestSupport = null, nearestResistance = null;
  for (const [fib, price] of levelValues) {
    if (price < currentPrice && (!nearestSupport || price > nearestSupport.price)) {
      nearestSupport = { fib, price };
    }
    if (price > currentPrice && (!nearestResistance || price < nearestResistance.price)) {
      nearestResistance = { fib, price };
    }
  }

  return {
    swingHigh: +swingHigh.toFixed(2),
    swingLow: +swingLow.toFixed(2),
    trend: uptrend ? 'uptrend' : 'downtrend',
    levels,
    nearestSupport,
    nearestResistance,
    currentPrice: +currentPrice.toFixed(2),
  };
}

// ─── Volume Analysis ────────────────────────────────────────────────────────

function VolumeAnalysis(bars) {
  if (bars.length < 21) return null;
  const volumes = bars.map(b => b.volume);
  const avg20 = volumes.slice(-21, -1).reduce((s, v) => s + v, 0) / 20;
  const current = volumes[volumes.length - 1];
  const ratio = avg20 > 0 ? +(current / avg20).toFixed(2) : 0;
  let signal = 'normal';
  if (ratio >= 2) signal = 'strong_surge';
  else if (ratio >= 1.5) signal = 'elevated';
  else if (ratio <= 0.5) signal = 'very_low';
  else if (ratio <= 0.7) signal = 'below_avg';
  return {
    current: Math.round(current),
    avg20: Math.round(avg20),
    ratio,
    signal,
  };
}

// ─── 1% Rule Calculator ────────────────────────────────────────────────────

function OnePercentRule(currentPrice, stopPrice, portfolioValue = 100000) {
  if (!currentPrice || !stopPrice) return null;
  const riskPerShare = Math.abs(currentPrice - stopPrice);
  if (riskPerShare === 0) return null;
  const maxRisk = portfolioValue * 0.01; // 1% of portfolio
  const maxShares = Math.floor(maxRisk / riskPerShare);
  const positionValue = maxShares * currentPrice;
  const positionPct = +((positionValue / portfolioValue) * 100).toFixed(2);
  return {
    maxRiskDollars: +maxRisk.toFixed(0),
    riskPerShare: +riskPerShare.toFixed(2),
    maxShares,
    positionValue: +positionValue.toFixed(0),
    positionPct,
    portfolioValue,
  };
}

// ─── EMA Alignment Score ────────────────────────────────────────────────────

function EMAAlignment(closes) {
  const emas = allEMAs(closes);
  const smas = allSMAs(closes);
  const price = closes[closes.length - 1];
  if (!emas.ema20 || !emas.ema50 || !emas.ema200) return null;

  // Bullish alignment: price > EMA9 > EMA20 > EMA50 > EMA200
  const bullishStack = price > emas.ema9 && emas.ema9 > emas.ema20 &&
                       emas.ema20 > emas.ema50 && emas.ema50 > emas.ema200;
  const bearishStack = price < emas.ema9 && emas.ema9 < emas.ema20 &&
                       emas.ema20 < emas.ema50 && emas.ema50 < emas.ema200;
  const above200 = price > emas.ema200;
  const above50 = price > emas.ema50;

  // Golden/Death cross: 50 EMA vs 200 EMA
  let cross = 'none';
  if (emas.ema50 > emas.ema200) cross = 'golden';
  else if (emas.ema50 < emas.ema200) cross = 'death';

  let alignment = 'mixed';
  if (bullishStack) alignment = 'fully_bullish';
  else if (bearishStack) alignment = 'fully_bearish';
  else if (above200 && above50) alignment = 'bullish';
  else if (!above200 && !above50) alignment = 'bearish';

  return {
    ...emas,
    ...smas,
    alignment,
    cross,
    above200,
    above50,
    priceVsEma200Pct: +((price - emas.ema200) / emas.ema200 * 100).toFixed(2),
  };
}

// ─── Master: compute ALL indicators for a ticker ────────────────────────────

function computeAll(bars, portfolioValue = 100000) {
  if (!bars || bars.length < 30) return { error: 'Insufficient data (need ≥30 bars)' };

  const closes = bars.map(b => b.close);
  const price = closes[closes.length - 1];
  const atrData = ATR(bars);
  const stopPrice = atrData ? +(price - atrData.atr * 2).toFixed(2) : +(price * 0.93).toFixed(2);

  return {
    price,
    date: bars[bars.length - 1].date,
    // Moving averages + alignment
    emaAlignment: EMAAlignment(closes),
    // Oscillators
    rsi2: RSI(closes, 2),
    rsi14: RSI(closes, 14),
    macd: MACD(closes),
    stochastic: Stochastic(bars),
    williamsR: WilliamsR(bars),
    cci: CCI(bars),
    // Volatility
    bollingerBands: BollingerBands(closes),
    atr: atrData,
    zScore: ZScore(closes),
    // Volume
    obv: OBV(bars),
    volume: VolumeAnalysis(bars),
    // Structure
    fibonacci: FibonacciRetracement(bars),
    // Risk
    onePercentRule: OnePercentRule(price, stopPrice, portfolioValue),
    // Summary score hints (for Claude to weigh)
    _summary: buildSummary(closes, bars, price),
  };
}

function buildSummary(closes, bars, price) {
  const rsi2 = RSI(closes, 2);
  const rsi14 = RSI(closes, 14);
  const macd = MACD(closes);
  const bb = BollingerBands(closes);
  const stoch = Stochastic(bars);
  const zs = ZScore(closes);
  const vol = VolumeAnalysis(bars);
  const obv = OBV(bars);
  const ema = EMAAlignment(closes);

  const signals = [];
  // RSI signals
  if (rsi2 != null && rsi2 < 5) signals.push('RSI(2) deeply oversold (' + rsi2 + ') — strong MR signal');
  else if (rsi2 != null && rsi2 < 10) signals.push('RSI(2) oversold (' + rsi2 + ') — MR candidate');
  else if (rsi2 != null && rsi2 > 95) signals.push('RSI(2) deeply overbought (' + rsi2 + ') — reversal risk');
  if (rsi14 != null && rsi14 < 30) signals.push('RSI(14) oversold territory');
  if (rsi14 != null && rsi14 > 70) signals.push('RSI(14) overbought territory');
  // MACD
  if (macd?.crossover === 'bullish') signals.push('MACD bullish crossover — momentum turning up');
  if (macd?.crossover === 'bearish') signals.push('MACD bearish crossover — momentum turning down');
  // Bollinger
  if (bb?.pctB != null && bb.pctB < 0.05) signals.push('Price at lower Bollinger Band — potential bounce');
  if (bb?.pctB != null && bb.pctB > 0.95) signals.push('Price at upper Bollinger Band — potential resistance');
  // Z-Score
  if (zs?.zScore < -2) signals.push('Z-Score ' + zs.zScore + ' — statistically extreme oversold');
  if (zs?.zScore > 2) signals.push('Z-Score ' + zs.zScore + ' — statistically extreme overbought');
  // Volume
  if (vol?.ratio >= 2) signals.push('Volume surge ' + vol.ratio + '× average — strong conviction');
  if (obv?.divergence === 'bullish') signals.push('Bullish OBV divergence — accumulation despite price drop');
  if (obv?.divergence === 'bearish') signals.push('Bearish OBV divergence — distribution despite price rise');
  // Stochastic
  if (stoch?.signal === 'bullish_cross') signals.push('Stochastic bullish crossover in oversold zone');
  if (stoch?.signal === 'bearish_cross') signals.push('Stochastic bearish crossover in overbought zone');
  // EMA
  if (ema?.alignment === 'fully_bullish') signals.push('EMAs fully stacked bullish — strong trend');
  if (ema?.alignment === 'fully_bearish') signals.push('EMAs fully stacked bearish — strong downtrend');
  if (ema?.cross === 'golden') signals.push('Golden cross (50 EMA > 200 EMA) — long-term bullish');
  if (ema?.cross === 'death') signals.push('Death cross (50 EMA < 200 EMA) — long-term bearish');

  return signals;
}

module.exports = {
  SMA, EMA, allEMAs, allSMAs,
  RSI, MACD, BollingerBands, ATR, OBV,
  ZScore, Stochastic, WilliamsR, CCI,
  FibonacciRetracement, VolumeAnalysis,
  OnePercentRule, EMAAlignment,
  computeAll,
};
