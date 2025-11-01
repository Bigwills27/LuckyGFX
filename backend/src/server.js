"use strict";

const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

// Add this at the top with other requires
const auth = require("basic-auth");

const {
  buildFriendlyWhatsAppMessage,
  sendWhatsAppMessage,
} = require("./services/whatsapp-service");

const { fetchTradingViewAnalysis } = require("./services/tradingview-service");

// Add this middleware function
function requireAuth(req, res, next) {
  if (req.method === "OPTIONS") {
    return next();
  }

  const user = auth(req);
  const USERNAME = process.env.APP_USERNAME || "admin";
  const PASSWORD = process.env.APP_PASSWORD || "admin";

  if (!user || user.name !== USERNAME || user.pass !== PASSWORD) {
    res.set("WWW-Authenticate", 'Basic realm="Signal Alert"');
    return res.status(401).json({ success: false, error: "Access denied" });
  }

  req.authenticatedUser = user.name;
  next();
}

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const PORT = Number.parseInt(process.env.SERVER_PORT || "3000", 10);
const TWELVEDATA_API_KEY = (process.env.TWELVEDATA_API_KEY || "").trim();
const TWELVEDATA_ENABLED = TWELVEDATA_API_KEY.length > 0;
const TWELVEDATA_BASE_URL = (
  (process.env.TWELVEDATA_BASE_URL && process.env.TWELVEDATA_BASE_URL.trim()) ||
  "https://api.twelvedata.com"
).replace(/\/$/, "");
const TWELVEDATA_TIME_SERIES_ENDPOINT =
  (process.env.TWELVEDATA_TIME_SERIES_ENDPOINT &&
    process.env.TWELVEDATA_TIME_SERIES_ENDPOINT.trim()) ||
  "/time_series";
const TWELVEDATA_DEFAULT_INTERVAL =
  (process.env.TWELVEDATA_DEFAULT_INTERVAL &&
    process.env.TWELVEDATA_DEFAULT_INTERVAL.trim()) ||
  "1h";
const TWELVEDATA_TIMEZONE = (process.env.TWELVEDATA_TIMEZONE || "").trim();
const TWELVEDATA_ORDER =
  (process.env.TWELVEDATA_ORDER || "desc").toLowerCase() === "asc"
    ? "asc"
    : "desc";
const parsedOutputSize = Number.parseInt(
  process.env.TWELVEDATA_MAX_OUTPUTSIZE || "5000",
  10
);
const TWELVEDATA_MAX_OUTPUTSIZE =
  Number.isFinite(parsedOutputSize) && parsedOutputSize > 0
    ? parsedOutputSize
    : 5000;
const POLL_LOOKBACK_HOURS = Number.parseInt(
  process.env.POLL_LOOKBACK_HOURS || "24",
  10
);
const POLL_INTERVAL_MS = Number.parseInt(
  process.env.POLL_INTERVAL_MS || String(5 * 60 * 1000),
  10
);
const CHART_CACHE_TTL_MS = Number.parseInt(
  process.env.CHART_CACHE_TTL_MS || String(5 * 60 * 1000),
  10
);

const DEFAULT_TV_SYMBOL =
  (process.env.TRADINGVIEW_SYMBOL && process.env.TRADINGVIEW_SYMBOL.trim()) ||
  "OANDA:XAUUSD";
const DEFAULT_TV_INTERVAL =
  (process.env.TRADINGVIEW_INTERVAL &&
    process.env.TRADINGVIEW_INTERVAL.trim()) ||
  "1h";
const DEFAULT_TV_FETCH_RANGE =
  Number.parseInt(process.env.TRADINGVIEW_FETCH_RANGE || "120", 10) || 120;
const DEFAULT_TV_SMA_PERIOD =
  Number.parseInt(process.env.TRADINGVIEW_SMA_LENGTH || "9", 10) || 9;
const DEFAULT_TV_RECENT_COUNT =
  Number.parseInt(process.env.TRADINGVIEW_RECENT_COUNT || "10", 10) || 10;

const corsEnvValue = process.env.CORS_ALLOWED_ORIGINS || "*";
const CORS_ALLOWED_ORIGINS = corsEnvValue
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowAllOrigins = CORS_ALLOWED_ORIGINS.includes("*");

const SYMBOLS = {
  XAUUSD: {
    providerSymbol: "XAU/USD",
    label: "Gold / XAUUSD",
    interval: "1h",
  },
  USDJPY: {
    providerSymbol: "USD/JPY",
    label: "USDJPY",
    interval: "1h",
  },
  US30: {
    providerSymbol: "DJI",
    label: "US30 / Dow Jones",
    interval: "1h",
  },
};

const app = express();

const corsOptions = allowAllOrigins
  ? {
      origin: true,
      credentials: true,
      allowedHeaders: ["Content-Type", "Authorization"],
      methods: ["GET", "POST", "OPTIONS"],
    }
  : {
      origin(origin, callback) {
        if (!origin || CORS_ALLOWED_ORIGINS.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error("Not allowed by CORS"));
        }
      },
      credentials: true,
      allowedHeaders: ["Content-Type", "Authorization"],
      methods: ["GET", "POST", "OPTIONS"],
    };

app.use(cors(corsOptions));
app.use(express.json());
app.options("*", cors(corsOptions));

const logsDir = path.resolve(__dirname, "../logs");
fs.mkdirSync(logsDir, { recursive: true });
const LOG_FILE = path.join(logsDir, "charts.log");

const chartCache = new Map();

function writeLog(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  fs.appendFile(LOG_FILE, line, (err) => {
    if (err) {
      console.error("Failed to write log entry", err);
    }
  });
}

function getIntervalMinutes(interval) {
  if (typeof interval !== "string" || !interval.trim()) {
    return 60;
  }

  const normalized = interval.trim().toLowerCase();
  const match = normalized.match(/^(\d+)(min|h|day|week|month)$/);
  if (!match) {
    return 60;
  }

  const value = Number.parseInt(match[1], 10);
  if (!Number.isFinite(value) || value <= 0) {
    return 60;
  }

  switch (match[2]) {
    case "min":
      return value;
    case "h":
      return value * 60;
    case "day":
      return value * 1440;
    case "week":
      return value * 10080;
    case "month":
      return value * 43200;
    default:
      return 60;
  }
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBooleanFlag(value, defaultValue = false) {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function parseSymbolList(input) {
  if (!input) {
    return [];
  }
  return String(input)
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const CALLMEBOT_PHONE = (process.env.CALLMEBOT_PHONE || "").trim();
const CALLMEBOT_API_KEY = (process.env.CALLMEBOT_API_KEY || "").trim();
const WHATSAPP_ALERT_SYMBOLS = (() => {
  const combined = [
    ...parseSymbolList(process.env.WHATSAPP_ALERT_SYMBOLS),
    ...parseSymbolList(process.env.WHATSAPP_ALERT_SYMBOL),
  ];
  const unique = Array.from(new Set(combined));
  if (unique.length) {
    return unique;
  }
  return DEFAULT_TV_SYMBOL ? [DEFAULT_TV_SYMBOL] : [];
})();
const PRIMARY_WHATSAPP_SYMBOL = WHATSAPP_ALERT_SYMBOLS[0] || DEFAULT_TV_SYMBOL;
const WHATSAPP_ALERT_TIMEFRAME =
  (process.env.WHATSAPP_ALERT_TIMEFRAME &&
    process.env.WHATSAPP_ALERT_TIMEFRAME.trim()) ||
  DEFAULT_TV_INTERVAL;
const WHATSAPP_POLL_INTERVAL_MS = parsePositiveInt(
  process.env.WHATSAPP_POLL_INTERVAL_MS,
  60 * 60 * 1000
);
const WHATSAPP_RETRY_INTERVAL_MS = parsePositiveInt(
  process.env.WHATSAPP_RETRY_INTERVAL_MS,
  5 * 60 * 1000
);
const WHATSAPP_MAX_RETRIES = Math.max(
  1,
  parsePositiveInt(process.env.WHATSAPP_MAX_RETRIES, 3)
);
const WHATSAPP_ALERT_ENABLED = parseBooleanFlag(
  process.env.WHATSAPP_ALERT_ENABLED,
  Boolean(CALLMEBOT_PHONE && CALLMEBOT_API_KEY)
);

function buildTradingViewOptions(req) {
  const symbol = (req.query.symbol || DEFAULT_TV_SYMBOL).trim();
  const timeframe = (req.query.timeframe || DEFAULT_TV_INTERVAL).trim();
  const range = parsePositiveInt(req.query.range, DEFAULT_TV_FETCH_RANGE);
  const smaPeriod = parsePositiveInt(
    req.query.sma ?? req.query.smaPeriod,
    DEFAULT_TV_SMA_PERIOD
  );
  const recentCount = parsePositiveInt(
    req.query.count ?? req.query.limit,
    DEFAULT_TV_RECENT_COUNT
  );
  const forceGuest = parseBooleanFlag(req.query.guest, false);
  const allowGuestFallback = !parseBooleanFlag(req.query.noFallback, false);

  return {
    symbol,
    timeframe,
    range,
    smaPeriod,
    recentCount,
    guest: forceGuest,
    allowGuestFallback,
    verbose: parseBooleanFlag(req.query.verbose, false),
  };
}

const DEFAULT_ALERT_RECENT_COUNT = Math.max(DEFAULT_TV_RECENT_COUNT, 10);

async function prepareWhatsAppAlert(overrides = {}) {
  const targetSymbol =
    (overrides.symbol && String(overrides.symbol).trim()) ||
    PRIMARY_WHATSAPP_SYMBOL;
  if (!targetSymbol) {
    throw new Error("No symbol provided for WhatsApp alert");
  }

  const analysis = await fetchTradingViewAnalysis({
    symbol: targetSymbol,
    timeframe:
      overrides.timeframe || WHATSAPP_ALERT_TIMEFRAME || DEFAULT_TV_INTERVAL,
    range: overrides.range || DEFAULT_TV_FETCH_RANGE,
    smaPeriod: overrides.smaPeriod || DEFAULT_TV_SMA_PERIOD,
    recentCount: overrides.recentCount || DEFAULT_ALERT_RECENT_COUNT,
    guest: parseBooleanFlag(overrides.guest, false),
    allowGuestFallback: overrides.allowGuestFallback !== false,
    verbose: false,
  });

  const candles = Array.isArray(analysis.candles) ? analysis.candles : [];
  const formingCandle = candles[candles.length - 1] || null;
  const previousInfo = analysis.previousCompleted || null;
  const previousCandle = previousInfo
    ? { ...previousInfo.candle, matches: previousInfo.matches }
    : null;

  const matches = previousCandle?.matches || {};
  const isVerified = Boolean(matches.greenAbove || matches.redBelow);

  const message = isVerified
    ? buildFriendlyWhatsAppMessage({
        symbol: analysis.symbol,
        timeframe: analysis.timeframe,
        previousCandle,
        formingCandle,
      })
    : "";

  return {
    analysis,
    message,
    formingCandle,
    previousCandle,
    isVerified,
  };
}

function startWhatsAppAlerts() {
  if (!WHATSAPP_ALERT_ENABLED) {
    console.log(
      "WhatsApp alerts disabled. Set WHATSAPP_ALERT_ENABLED=1 to turn them on."
    );
    return;
  }

  if (!CALLMEBOT_PHONE || !CALLMEBOT_API_KEY) {
    console.warn(
      "WhatsApp alerts disabled: missing CALLMEBOT_PHONE or CALLMEBOT_API_KEY."
    );
    return;
  }

  if (!WHATSAPP_ALERT_SYMBOLS.length) {
    console.warn(
      "WhatsApp alerts disabled: no TradingView symbols configured."
    );
    return;
  }

  const lastAlertTimestamp = new Map();

  const pollSymbol = async (symbol) => {
    const key = symbol.toUpperCase();
    const { analysis, message, previousCandle, isVerified } =
      await prepareWhatsAppAlert({ symbol });

    const prevTimestamp = previousCandle?.timestamp || null;
    const trimmedMessage = message && message.trim();

    if (!prevTimestamp || !isVerified || !trimmedMessage) {
      return { symbol, verified: false, sent: false };
    }

    if (lastAlertTimestamp.get(key) === prevTimestamp) {
      return { symbol, verified: true, sent: false };
    }

    await sendWhatsAppMessage({
      phone: CALLMEBOT_PHONE,
      apiKey: CALLMEBOT_API_KEY,
      text: trimmedMessage,
    });

    lastAlertTimestamp.set(key, prevTimestamp);
    writeLog(
      `WhatsApp alert sent for ${analysis.symbol} ${analysis.timeframe} (${prevTimestamp}).`
    );

    return { symbol, verified: true, sent: true };
  };

  const pollAll = async () => {
    const results = await Promise.all(
      WHATSAPP_ALERT_SYMBOLS.map(async (symbol) => {
        try {
          return await pollSymbol(symbol);
        } catch (error) {
          writeLog(`WhatsApp alert error for ${symbol}: ${error.message}`);
          return { symbol, error, verified: false, sent: false };
        }
      })
    );

    const hadErrors = results.some((entry) => entry?.error);
    const anyVerified = results.some((entry) => entry?.verified);
    const anySent = results.some((entry) => entry?.sent);

    return {
      hadErrors,
      anyVerified,
      anySent,
    };
  };

  const baseIntervalMs = Math.max(WHATSAPP_POLL_INTERVAL_MS, 60 * 60 * 1000);
  const retryIntervalMs = Math.max(WHATSAPP_RETRY_INTERVAL_MS, 60 * 1000);

  let consecutiveFailures = 0;
  let timeoutId = null;

  writeLog(
    `WhatsApp alerts armed for ${WHATSAPP_ALERT_SYMBOLS.join(
      ", "
    )}. Base interval: ${baseIntervalMs}ms. Retry interval: ${retryIntervalMs}ms (max ${WHATSAPP_MAX_RETRIES} retries).`
  );

  const scheduleNext = (delay) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(async () => {
      try {
        const { hadErrors } = await pollAll();
        if (hadErrors) {
          consecutiveFailures += 1;
          if (consecutiveFailures > WHATSAPP_MAX_RETRIES) {
            writeLog(
              "WhatsApp poll reached max retry attempts. Scheduling next run at the normal interval."
            );
            consecutiveFailures = 0;
            scheduleNext(baseIntervalMs);
            return;
          }

          const retryDelay = retryIntervalMs * consecutiveFailures;
          writeLog(
            `WhatsApp poll encountered errors. Retrying in ${retryDelay}ms (attempt ${consecutiveFailures}/${WHATSAPP_MAX_RETRIES}).`
          );
          scheduleNext(retryDelay);
        } else {
          consecutiveFailures = 0;
          scheduleNext(baseIntervalMs);
        }
      } catch (error) {
        consecutiveFailures += 1;
        if (consecutiveFailures > WHATSAPP_MAX_RETRIES) {
          writeLog(
            `WhatsApp alert error: ${error.message}. Max retries reached; scheduling next run at the normal interval.`
          );
          consecutiveFailures = 0;
          scheduleNext(baseIntervalMs);
          return;
        }

        const retryDelay = retryIntervalMs * consecutiveFailures;
        writeLog(
          `WhatsApp alert error: ${error.message}. Retrying in ${retryDelay}ms (attempt ${consecutiveFailures}/${WHATSAPP_MAX_RETRIES}).`
        );
        scheduleNext(retryDelay);
      }
    }, delay);
  };

  scheduleNext(0);
}

function buildTimeSeriesUrl({ symbol, interval, outputsize }) {
  const base = TWELVEDATA_BASE_URL.replace(/\/$/, "");
  const endpointPath = TWELVEDATA_TIME_SERIES_ENDPOINT.replace(/^\//, "");
  const url = new URL(`${endpointPath}`, `${base}/`);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("outputsize", String(outputsize));
  url.searchParams.set("apikey", TWELVEDATA_API_KEY);
  url.searchParams.set("format", "JSON");
  if (TWELVEDATA_TIMEZONE) {
    url.searchParams.set("timezone", TWELVEDATA_TIMEZONE);
  }
  if (TWELVEDATA_ORDER) {
    url.searchParams.set("order", TWELVEDATA_ORDER);
  }
  return url.toString();
}

async function requestCandles({ pair, hours }) {
  if (!TWELVEDATA_ENABLED) {
    const error = new Error("Twelve Data integration is disabled");
    error.statusCode = 503;
    throw error;
  }

  const symbolMeta = SYMBOLS[pair];
  if (!symbolMeta) {
    const error = new Error(`Unsupported symbol: ${pair}`);
    error.statusCode = 400;
    throw error;
  }

  const interval = symbolMeta.interval || TWELVEDATA_DEFAULT_INTERVAL;
  const intervalMinutes = Math.max(getIntervalMinutes(interval), 1);
  const requestedHours = Number.isFinite(hours) && hours > 0 ? hours : 24;
  const pointsNeeded = Math.max(
    Math.ceil((requestedHours * 60) / intervalMinutes),
    1
  );
  const outputsize = Math.min(pointsNeeded, TWELVEDATA_MAX_OUTPUTSIZE);

  const requestUrl = buildTimeSeriesUrl({
    symbol: symbolMeta.providerSymbol,
    interval,
    outputsize,
  });

  const startedAt = Date.now();
  const response = await fetch(requestUrl);
  const rawText = await response.text();
  if (!response.ok) {
    const error = new Error(
      `Twelve Data responded with ${response.status}: ${rawText}`
    );
    error.statusCode = response.status;
    throw error;
  }

  let payload;
  try {
    payload = rawText ? JSON.parse(rawText) : {};
  } catch (parseError) {
    const error = new Error(
      `Unable to parse Twelve Data response: ${parseError.message}`
    );
    error.statusCode = 502;
    throw error;
  }

  if (payload.status && payload.status !== "ok") {
    const apiError = new Error(
      payload.message || "Twelve Data returned an error response"
    );
    apiError.statusCode = payload.code || 502;
    throw apiError;
  }

  if (payload.code && payload.message && !payload.status) {
    const apiError = new Error(payload.message);
    apiError.statusCode = payload.code;
    throw apiError;
  }

  const values = Array.isArray(payload.values) ? payload.values.slice() : [];
  if (!values.length) {
    const apiError = new Error("Twelve Data returned no candle data");
    apiError.statusCode = 404;
    throw apiError;
  }

  const orderedValues = values.sort((a, b) => {
    if (!a?.datetime || !b?.datetime) {
      return 0;
    }
    return a.datetime.localeCompare(b.datetime);
  });

  const limitedValues = orderedValues.slice(-outputsize);

  const toNumber = (value) => {
    if (value === null || value === undefined) {
      return null;
    }
    const numeric = Number.parseFloat(value);
    return Number.isFinite(numeric) ? numeric : null;
  };

  const timestamps = limitedValues.map((entry) => entry.datetime);
  const open = limitedValues.map((entry) => toNumber(entry.open));
  const high = limitedValues.map((entry) => toNumber(entry.high));
  const low = limitedValues.map((entry) => toNumber(entry.low));
  const close = limitedValues.map((entry) => toNumber(entry.close));
  const volume = limitedValues.map((entry) => toNumber(entry.volume));
  const lastEntry = limitedValues[limitedValues.length - 1];

  const effectiveLookbackHours = Math.max(
    (limitedValues.length * intervalMinutes) / 60,
    intervalMinutes / 60
  );
  const usedLookbackHours = Math.min(requestedHours, effectiveLookbackHours);

  const result = {
    pair,
    symbol: symbolMeta.providerSymbol,
    providerSymbol: symbolMeta.providerSymbol,
    interval,
    resolution: interval,
    timestamps,
    open,
    high,
    low,
    close,
    volume,
    lastUpdated: lastEntry?.datetime || new Date().toISOString(),
    lookbackHours: usedLookbackHours,
    fetchDurationMs: Date.now() - startedAt,
    meta: payload.meta || null,
    source: "twelvedata",
    requestedOutputSize: outputsize,
  };

  chartCache.set(pair, {
    data: result,
    cachedAt: Date.now(),
  });

  const humanTime = lastEntry?.datetime;
  if (humanTime) {
    writeLog(
      `${pair}: fetched ${requestedHours}h window via Twelve Data, latest candle ${humanTime}, took ${result.fetchDurationMs}ms`
    );
  } else {
    writeLog(
      `${pair}: fetched ${requestedHours}h window via Twelve Data, took ${result.fetchDurationMs}ms`
    );
  }

  return result;
}

function getCachedCandles(pair, hours) {
  const cached = chartCache.get(pair);
  if (!cached) {
    return null;
  }

  const isFresh = Date.now() - cached.cachedAt < CHART_CACHE_TTL_MS;
  const coversRequestedHours = cached.data.lookbackHours >= hours;

  if (isFresh && coversRequestedHours) {
    return cached.data;
  }

  return null;
}

async function getCandles(pair, hours) {
  const normalizedHours =
    Number.isFinite(hours) && hours > 0 ? Math.min(hours, 240) : 24;
  const cached = getCachedCandles(pair, normalizedHours);
  if (cached) {
    return cached;
  }
  return requestCandles({ pair, hours: normalizedHours });
}

async function pollOHLC() {
  if (!TWELVEDATA_ENABLED) {
    return;
  }
  const pairs = Object.keys(SYMBOLS);
  for (const pair of pairs) {
    try {
      await requestCandles({ pair, hours: POLL_LOOKBACK_HOURS });
    } catch (error) {
      writeLog(`Error polling ${pair}: ${error.message}`);
    }
  }
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.post("/api/login", requireAuth, (req, res) => {
  res.json({
    success: true,
    user: {
      username: req.authenticatedUser,
    },
  });
});

app.use("/api", requireAuth);

app.get("/api/charts", async (req, res) => {
  const pair = (req.query.pair || "XAUUSD").toUpperCase();
  const hoursParam = Number.parseInt(req.query.hours, 10);
  const hours = Number.isFinite(hoursParam) && hoursParam > 0 ? hoursParam : 24;

  if (!TWELVEDATA_ENABLED) {
    return res.status(503).json({
      success: false,
      error: "Twelve Data integration is disabled",
    });
  }

  if (!SYMBOLS[pair]) {
    return res.status(400).json({ success: false, error: "Invalid pair" });
  }

  try {
    const data = await getCandles(pair, hours);
    res.json({ success: true, data });
  } catch (error) {
    const status =
      error.statusCode && Number.isInteger(error.statusCode)
        ? error.statusCode
        : 500;
    writeLog(`Error fetching ${pair}: ${error.message}`);
    res.status(status).json({ success: false, error: error.message });
  }
});

app.get("/api/tradingview/candles", async (req, res) => {
  const options = buildTradingViewOptions(req);

  try {
    const analysis = await fetchTradingViewAnalysis(options);
    res.json({
      success: true,
      data: {
        requestedSymbol: analysis.requestedSymbol,
        symbol: analysis.symbol,
        timeframe: analysis.timeframe,
        smaPeriod: analysis.smaPeriod,
        recentCount: analysis.recentCount,
        totalBarsFetched: analysis.totalBarsFetched,
        candles: analysis.candles,
        closes: analysis.closes,
        sma: analysis.sma,
        matches: analysis.matches,
        meta: analysis.meta,
      },
    });
  } catch (error) {
    const status =
      error.statusCode && Number.isInteger(error.statusCode)
        ? error.statusCode
        : 500;
    writeLog(`TradingView candles error: ${error.message}`);
    res.status(status).json({ success: false, error: error.message });
  }
});

app.get("/api/tradingview/matches", async (req, res) => {
  const options = buildTradingViewOptions(req);

  try {
    const analysis = await fetchTradingViewAnalysis(options);
    res.json({
      success: true,
      data: {
        requestedSymbol: analysis.requestedSymbol,
        symbol: analysis.symbol,
        timeframe: analysis.timeframe,
        smaPeriod: analysis.smaPeriod,
        recentCount: analysis.recentCount,
        greenAbove: analysis.matches.greenAbove,
        redBelow: analysis.matches.redBelow,
        totalBarsFetched: analysis.totalBarsFetched,
        meta: analysis.meta,
      },
    });
  } catch (error) {
    const status =
      error.statusCode && Number.isInteger(error.statusCode)
        ? error.statusCode
        : 500;
    writeLog(`TradingView matches error: ${error.message}`);
    res.status(status).json({ success: false, error: error.message });
  }
});

app.get("/api/tradingview/signal", async (req, res) => {
  const options = buildTradingViewOptions(req);

  try {
    const analysis = await fetchTradingViewAnalysis(options);
    const formingCandle = analysis.candles[analysis.candles.length - 1] || null;
    const previousEntry = analysis.previousCompleted;

    res.json({
      success: true,
      data: {
        requestedSymbol: analysis.requestedSymbol,
        symbol: analysis.symbol,
        timeframe: analysis.timeframe,
        smaPeriod: analysis.smaPeriod,
        totalBarsFetched: analysis.totalBarsFetched,
        previousCompleted: previousEntry,
        formingCandle,
        triggered:
          previousEntry &&
          (previousEntry.matches.greenAbove || previousEntry.matches.redBelow),
        meta: analysis.meta,
      },
    });
  } catch (error) {
    const status =
      error.statusCode && Number.isInteger(error.statusCode)
        ? error.statusCode
        : 500;
    writeLog(`TradingView signal error: ${error.message}`);
    res.status(status).json({ success: false, error: error.message });
  }
});

app.post("/api/tradingview/whatsapp/test", async (req, res) => {
  const body = req.body || {};
  const overrides = {
    symbol: body.symbol || req.query.symbol,
    timeframe: body.timeframe || req.query.timeframe,
    recentCount: body.recentCount || req.query.count,
    smaPeriod: body.sma || body.smaPeriod || req.query.sma,
  };

  const dryRun = parseBooleanFlag(body.dryRun ?? req.query.dryRun, false);
  const sendFlag = parseBooleanFlag(body.send ?? req.query.send, true);
  const actuallySend = !dryRun && sendFlag;

  try {
    const { analysis, message, previousCandle, isVerified } =
      await prepareWhatsAppAlert(overrides);

    const trimmedMessage = message && message.trim();
    const matches = previousCandle?.matches || {};

    if (!isVerified || !trimmedMessage) {
      return res.json({
        success: true,
        data: {
          sent: false,
          dryRun,
          verified: false,
          reason: "No verified candle detected. Nothing sent.",
          message: null,
          delivery: null,
          summary: {
            symbol: analysis.symbol,
            timeframe: analysis.timeframe,
            previousTimestamp: previousCandle?.timestamp || null,
            matches,
            sma: previousCandle?.sma || null,
          },
        },
      });
    }

    let delivery = null;
    let finalMessage = trimmedMessage;

    if (actuallySend) {
      if (!CALLMEBOT_PHONE || !CALLMEBOT_API_KEY) {
        throw new Error("CallMeBot credentials are missing");
      }
      finalMessage = `${trimmedMessage} Just a quick test ping so you know I'm awake.`;
      delivery = await sendWhatsAppMessage({
        phone: CALLMEBOT_PHONE,
        apiKey: CALLMEBOT_API_KEY,
        text: finalMessage,
      });
      writeLog(
        `WhatsApp test alert sent for ${analysis.symbol} ${analysis.timeframe}.`
      );
    }

    res.json({
      success: true,
      data: {
        sent: actuallySend,
        dryRun,
        verified: true,
        message: finalMessage,
        delivery,
        summary: {
          symbol: analysis.symbol,
          timeframe: analysis.timeframe,
          previousTimestamp: previousCandle?.timestamp || null,
          matches,
          sma: previousCandle?.sma || null,
        },
      },
    });
  } catch (error) {
    const status =
      error.statusCode && Number.isInteger(error.statusCode)
        ? error.statusCode
        : 500;
    writeLog(`TradingView WhatsApp test error: ${error.message}`);
    res.status(status).json({ success: false, error: error.message });
  }
});

const server = app.listen(PORT, () => {
  console.log(`LuckyGFX backend listening on port ${PORT}`);
});

if (TWELVEDATA_ENABLED) {
  pollOHLC()
    .catch((error) => {
      writeLog(`Initial poll failed: ${error.message}`);
    })
    .finally(() => {
      setInterval(() => {
        pollOHLC().catch((error) => {
          writeLog(`Poll tick failed: ${error.message}`);
        });
      }, POLL_INTERVAL_MS);
    });
} else {
  console.log("Twelve Data polling disabled (no API key configured).");
}

startWhatsAppAlerts();

process.on("SIGTERM", () => {
  server.close(() => {
    console.log("Server closed gracefully");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  server.close(() => {
    console.log("Server interrupted and closed");
    process.exit(0);
  });
});
