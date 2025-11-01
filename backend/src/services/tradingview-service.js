"use strict";

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const DEFAULT_SYMBOL =
  (process.env.TRADINGVIEW_SYMBOL && process.env.TRADINGVIEW_SYMBOL.trim()) ||
  "OANDA:XAUUSD";
const DEFAULT_TIMEFRAME =
  (process.env.TRADINGVIEW_INTERVAL &&
    process.env.TRADINGVIEW_INTERVAL.trim()) ||
  "1h";
const TRADINGVIEW_USERNAME = (process.env.TRADINGVIEW_USERNAME || "").trim();
const TRADINGVIEW_PASSWORD = (process.env.TRADINGVIEW_PASSWORD || "").trim();
const TRADINGVIEW_LAYOUT_ID = (process.env.TRADINGVIEW_LAYOUT_ID || "").trim();
const DEFAULT_FETCH_RANGE =
  Number.parseInt(process.env.TRADINGVIEW_FETCH_RANGE || "120", 10) || 120;
const DEFAULT_SMA_PERIOD =
  Number.parseInt(process.env.TRADINGVIEW_SMA_LENGTH || "9", 10) || 9;
const DEFAULT_RECENT_COUNT =
  Number.parseInt(process.env.TRADINGVIEW_RECENT_COUNT || "10", 10) || 10;

function toNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function computeSMA(candles, period) {
  if (!Number.isFinite(period) || period <= 0) {
    return candles.map(() => null);
  }
  return candles.map((_, index) => {
    if (index < period) {
      return null;
    }
    const window = candles.slice(index - period, index);
    if (window.some((item) => !Number.isFinite(item.close))) {
      return null;
    }
    const sum = window.reduce((acc, item) => acc + item.close, 0);
    return sum / period;
  });
}

function normalizeChartTimeframe(tf) {
  if (!tf) return "60";
  const lower = String(tf).trim().toLowerCase();
  if (lower === "d" || lower === "1d" || lower === "day") return "D";
  if (lower === "w" || lower === "1w" || lower === "week") return "W";
  if (lower === "m" || lower === "1m" || lower === "month") return "M";
  if (lower.endsWith("h")) {
    const value = Number.parseInt(lower, 10);
    return Number.isFinite(value) && value > 0 ? String(value * 60) : "60";
  }
  if (lower.endsWith("min")) {
    const value = Number.parseInt(lower, 10);
    return Number.isFinite(value) && value > 0 ? String(value) : "1";
  }
  if (lower.endsWith("m")) {
    const value = Number.parseInt(lower, 10);
    return Number.isFinite(value) && value > 0 ? String(value) : "1";
  }
  if (/^[0-9]+$/.test(lower)) {
    return lower;
  }
  return "60";
}

function formatTvTimestamp(value) {
  if (value === null || value === undefined) {
    return value;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return value;
  }
  const ms = numeric < 1e12 ? numeric * 1000 : numeric;
  try {
    return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
  } catch (err) {
    return value;
  }
}

async function resolveTradingViewSymbol(lib, rawSymbol) {
  if (!rawSymbol) {
    throw new Error("Missing TradingView symbol");
  }

  const trimmed = rawSymbol.trim();
  const searchFns = [];

  if (typeof lib.searchMarketV3 === "function") {
    searchFns.push(lib.searchMarketV3.bind(lib));
  }
  if (typeof lib.searchMarket === "function") {
    searchFns.push(lib.searchMarket.bind(lib));
  }

  if (!searchFns.length) {
    return trimmed;
  }

  const queries = [trimmed];
  const symbolOnly = trimmed.includes(":")
    ? trimmed.split(":").slice(1).join(":").trim()
    : trimmed;
  if (symbolOnly && symbolOnly !== trimmed) {
    queries.push(symbolOnly);
  }

  for (const query of queries) {
    for (const search of searchFns) {
      try {
        const results = await search(query);
        if (!Array.isArray(results) || !results.length) {
          continue;
        }

        const exact = results.find((item) => item && item.id === trimmed);
        if (exact) {
          return exact.id;
        }

        const partial = results.find(
          (item) =>
            item &&
            typeof item.id === "string" &&
            (item.id === query || item.id.includes(symbolOnly))
        );
        if (partial && partial.id) {
          return partial.id;
        }
      } catch (_) {
        // ignore search failures and continue
      }
    }
  }

  return trimmed;
}

async function waitForClientReady(client) {
  if (client.isLogged) {
    return;
  }
  await new Promise((resolve, reject) => {
    const timeoutMs = Number.parseInt(
      process.env.TRADINGVIEW_LOGIN_TIMEOUT_MS || "15000",
      10
    );
    const timeout = setTimeout(() => {
      reject(new Error("TradingView client login timed out"));
    }, timeoutMs);

    client.onLogged(() => {
      clearTimeout(timeout);
      resolve();
    });

    client.onError((msg) => {
      clearTimeout(timeout);
      const errorMessage = Array.isArray(msg)
        ? msg.map((part) => String(part)).join(" ")
        : String(msg);
      reject(new Error(errorMessage));
    });
  });
}

async function waitForChartData(chart, options) {
  const desiredRange = Math.max(Number.parseInt(options.range, 10) || 120, 20);
  const sessionMode = (options.sessionMode || "").toLowerCase();

  return new Promise((resolve, reject) => {
    let finished = false;
    const timeoutMs = Number.parseInt(
      process.env.TRADINGVIEW_DATA_TIMEOUT_MS || "20000",
      10
    );
    const timeout = setTimeout(() => {
      if (!finished) {
        finished = true;
        reject(new Error("Timed out waiting for chart data"));
      }
    }, timeoutMs);

    chart.onError((...args) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      const message = args.map((part) => String(part)).join(" ");
      reject(new Error(message || "Chart session error"));
    });

    chart.onUpdate(() => {
      if (finished) return;
      const periods = chart.periods;
      if (Array.isArray(periods) && periods.length >= desiredRange) {
        finished = true;
        clearTimeout(timeout);
        resolve(periods.slice(0, desiredRange));
      }
    });

    try {
      chart.setMarket(options.symbol, {
        timeframe: options.timeframe,
        range: desiredRange,
        session:
          sessionMode === "extended" || sessionMode === "regular"
            ? sessionMode
            : undefined,
      });
    } catch (err) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      reject(err);
    }
  });
}

async function fetchTradingViewPeriods(lib, options) {
  const {
    symbol,
    timeframe,
    range = DEFAULT_FETCH_RANGE,
    verbose = false,
    guest = false,
    allowGuestFallback = true,
  } = options;

  let usingGuest = guest;
  let credentials = null;

  if (!usingGuest) {
    try {
      credentials = await lib.loginUser(
        TRADINGVIEW_USERNAME,
        TRADINGVIEW_PASSWORD,
        true
      );
      if (verbose) {
        console.log(
          `Authenticated TradingView user ${credentials.username} (#${credentials.id})`
        );
      }
    } catch (err) {
      if (allowGuestFallback) {
        usingGuest = true;
        console.warn(
          `TradingView login failed (${
            err && err.message ? err.message : err
          }). Falling back to guest mode.`
        );
      } else {
        throw new Error(`TradingView login failed: ${err.message || err}`);
      }
    }
  }

  if (!usingGuest && TRADINGVIEW_LAYOUT_ID) {
    try {
      await lib.getChartToken(TRADINGVIEW_LAYOUT_ID, {
        id: credentials.id,
        session: credentials.session,
        signature: credentials.signature,
      });
      if (verbose) {
        console.log(`Verified access to layout ${TRADINGVIEW_LAYOUT_ID}`);
      }
    } catch (err) {
      if (verbose) {
        console.warn(
          "getChartToken failed (continuing without layout token):",
          err && err.message ? err.message : err
        );
      }
    }
  } else if (!usingGuest && verbose) {
    console.warn(
      "TRADINGVIEW_LAYOUT_ID is not set; continuing without layout verification."
    );
  }

  if (usingGuest && verbose) {
    console.log("Proceeding with guest TradingView session.");
  }

  const clientOptions = {
    server: (process.env.TRADINGVIEW_SERVER || "data").trim() || "data",
  };

  if (!usingGuest && credentials) {
    clientOptions.token = credentials.session;
    clientOptions.signature = credentials.signature;
  }

  if ((process.env.TRADINGVIEW_DEBUG || "").trim() === "1") {
    clientOptions.DEBUG = true;
  }

  const Client = lib.Client;
  const client = new Client(clientOptions);
  let chart;

  try {
    await waitForClientReady(client);

    chart = new client.Session.Chart();

    const timezonePref = (process.env.TRADINGVIEW_TIMEZONE || "Etc/UTC").trim();
    if (timezonePref) {
      chart.setTimezone(timezonePref);
    }

    const resolvedSymbol = await resolveTradingViewSymbol(lib, symbol);
    const normalizedTF = normalizeChartTimeframe(timeframe);

    if (verbose) {
      console.log(
        `Using resolved symbol ${resolvedSymbol} with timeframe ${normalizedTF}`
      );
    }

    const desiredRange = Math.max(Number.parseInt(range, 10) || 120, 20);
    const rawPeriods = await waitForChartData(chart, {
      symbol: resolvedSymbol,
      timeframe: normalizedTF,
      range: desiredRange,
      sessionMode: (process.env.TRADINGVIEW_SESSION_MODE || "").trim(),
    });

    const normalized = rawPeriods
      .slice()
      .reverse()
      .map((p) => ({
        time: formatTvTimestamp(p.time),
        open: p.open,
        high: p.max,
        low: p.min,
        close: p.close,
        volume: p.volume,
      }));

    return {
      periods: normalized,
      usingGuest,
      resolvedSymbol,
      timeframe: normalizedTF,
      requestedRange: desiredRange,
    };
  } finally {
    if (chart && typeof chart.delete === "function") {
      try {
        chart.delete();
      } catch (_) {
        // noop
      }
    }

    try {
      await client.end();
    } catch (_) {
      // noop
    }
  }
}

function evaluateMatches(candle) {
  const valid =
    Number.isFinite(candle.sma) &&
    Number.isFinite(candle.open) &&
    Number.isFinite(candle.close) &&
    Number.isFinite(candle.high) &&
    Number.isFinite(candle.low);

  if (!valid) {
    return {
      greenAbove: false,
      redBelow: false,
    };
  }

  const greenAbove = candle.close > candle.open && candle.low > candle.sma;
  const redBelow = candle.close < candle.open && candle.high < candle.sma;

  return { greenAbove, redBelow };
}

async function fetchTradingViewAnalysis(options = {}) {
  const {
    symbol = DEFAULT_SYMBOL,
    timeframe = DEFAULT_TIMEFRAME,
    range = DEFAULT_FETCH_RANGE,
    smaPeriod = DEFAULT_SMA_PERIOD,
    recentCount = DEFAULT_RECENT_COUNT,
    guest = false,
    allowGuestFallback = true,
    verbose = false,
  } = options;

  let lib;
  try {
    lib = require("@mathieuc/tradingview");
  } catch (err) {
    throw new Error(
      "Missing dependency '@mathieuc/tradingview'. Install it in backend folder (npm i @mathieuc/tradingview)."
    );
  }

  const {
    periods,
    usingGuest,
    resolvedSymbol,
    timeframe: normalizedTF,
  } = await fetchTradingViewPeriods(lib, {
    symbol,
    timeframe,
    range,
    guest,
    allowGuestFallback,
    verbose,
  });

  if (!Array.isArray(periods) || !periods.length) {
    throw new Error("No bars returned from TradingView");
  }

  const candles = periods.map((bar, index) => ({
    index,
    number: index + 1,
    timestamp: bar.time || bar.datetime || bar.date || null,
    open: toNumber(bar.open),
    high: toNumber(bar.high),
    low: toNumber(bar.low),
    close: toNumber(bar.close),
    volume: toNumber(bar.volume),
  }));

  const smaSeries = computeSMA(candles, smaPeriod);
  candles.forEach((candle, idx) => {
    candle.sma = smaSeries[idx];
  });

  const recent = candles.slice(-Math.max(recentCount, 1));
  const latest = recent[recent.length - 1];
  const hasSMA = latest && Number.isFinite(latest.sma);
  const startIdx = hasSMA ? candles.length - 1 - smaPeriod : -1;
  const closesUsed =
    hasSMA && startIdx >= 0
      ? candles.slice(startIdx, candles.length - 1).map((c) => ({
          timestamp: c.timestamp,
          close: c.close,
        }))
      : [];

  const recentCandles = recent.map((candle) => {
    const matches = evaluateMatches(candle);
    return {
      index: candle.index,
      number: candle.number,
      timestamp: candle.timestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      sma: candle.sma,
      forming: candle === latest,
      matches,
    };
  });

  const matches = {
    greenAbove: recentCandles.filter((c) => c.matches.greenAbove),
    redBelow: recentCandles.filter((c) => c.matches.redBelow),
  };

  const previousCompleted =
    recentCandles.length >= 2 ? recentCandles[recentCandles.length - 2] : null;

  return {
    symbol,
    requestedSymbol: symbol,
    resolvedSymbol,
    timeframe,
    normalizedTimeframe: normalizedTF,
    totalBarsFetched: candles.length,
    smaPeriod,
    recentCount: recentCandles.length,
    candles: recentCandles,
    closes: closesUsed,
    sma: hasSMA ? latest.sma : null,
    matches,
    previousCompleted: previousCompleted
      ? {
          candle: previousCompleted,
          matches: previousCompleted.matches,
          formingReference: recentCandles[recentCandles.length - 1] || null,
        }
      : null,
    meta: {
      usingGuest,
      fetchRange: range,
    },
  };
}

module.exports = {
  fetchTradingViewAnalysis,
};
