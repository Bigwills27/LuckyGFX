"use strict";

const fetch = require("node-fetch");

function formatDecimal(value, digits = 2) {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  return value.toFixed(digits);
}

function describeTimeframe(code) {
  if (!code) return "";
  const normalized = String(code).trim().toLowerCase();
  const lookup = {
    1: "1 minute",
    3: "3 minutes",
    5: "5 minutes",
    15: "15 minutes",
    30: "30 minutes",
    45: "45 minutes",
    60: "1 hour",
    120: "2 hours",
    180: "3 hours",
    240: "4 hours",
    360: "6 hours",
    480: "8 hours",
    720: "12 hours",
    d: "daily",
    w: "weekly",
    m: "monthly",
  };
  if (lookup[normalized]) {
    return lookup[normalized];
  }
  if (normalized.endsWith("h")) {
    const hours = Number.parseInt(normalized, 10);
    if (Number.isFinite(hours)) {
      return hours === 1 ? "1 hour" : `${hours} hours`;
    }
  }
  if (normalized.endsWith("m")) {
    const minutes = Number.parseInt(normalized, 10);
    if (Number.isFinite(minutes)) {
      return minutes === 1 ? "1 minute" : `${minutes} minutes`;
    }
  }
  return normalized;
}

function normalizePairName(symbol) {
  if (!symbol) {
    return "pair";
  }
  const trimmed = String(symbol).trim();
  const withoutPrefix = trimmed.includes(":")
    ? trimmed.split(":").pop()
    : trimmed;
  return withoutPrefix.toLowerCase();
}

function buildFriendlyWhatsAppMessage(options) {
  const { symbol, timeframe, previousCandle, formingCandle } = options;

  if (!previousCandle || !previousCandle.matches) {
    return "";
  }

  const matches = previousCandle.matches || {};
  const verified = Boolean(matches.greenAbove || matches.redBelow);
  if (!verified) {
    return "";
  }

  const candleTime = previousCandle.timestamp
    ? new Date(previousCandle.timestamp).toLocaleString()
    : "the last candle";
  const timeframeLabel = describeTimeframe(timeframe || "");
  const closeValue = Number.isFinite(previousCandle.close)
    ? formatDecimal(previousCandle.close, 2)
    : null;
  const formingClose =
    formingCandle && Number.isFinite(formingCandle.close)
      ? formatDecimal(formingCandle.close, 2)
      : null;

  const pairName = normalizePairName(symbol);
  const patternFragment = matches.greenAbove
    ? "it's a green above the MA"
    : "it's a red below the MA";

  const timeframeText = timeframeLabel ? ` on the ${timeframeLabel} chart` : "";
  const timeNote = candleTime ? ` (closed ${candleTime})` : "";

  const parts = [
    `I juust spotted a candle on the ${pairName} pair similar to your pattern${timeframeText}${timeNote}, ${patternFragment}.`,
  ];

  if (closeValue) {
    parts.push(`It closed around ${closeValue}.`);
  }

  if (formingClose) {
    parts.push(`The one forming now is hovering close to ${formingClose}.`);
  }

  parts.push("Please do well to check it out.");

  return parts.filter(Boolean).join(" ");
}

async function sendWhatsAppMessage({ phone, apiKey, text }) {
  if (!phone || !apiKey) {
    throw new Error("Missing CallMeBot credentials");
  }
  if (!text) {
    throw new Error("Cannot send an empty WhatsApp message");
  }

  const endpoint = new URL("https://api.callmebot.com/whatsapp.php");
  endpoint.searchParams.set("phone", phone.replace(/[^0-9+]/g, ""));
  endpoint.searchParams.set("text", text);
  endpoint.searchParams.set("apikey", apiKey.trim());

  const response = await fetch(endpoint.toString());
  const resultText = await response.text();

  if (!response.ok) {
    throw new Error(
      `CallMeBot responded with ${response.status}: ${
        resultText || "Unknown error"
      }`
    );
  }

  if (!/Message sent/i.test(resultText)) {
    throw new Error(
      resultText && resultText.trim()
        ? resultText.trim()
        : "CallMeBot did not confirm message delivery"
    );
  }

  return resultText.trim();
}

module.exports = {
  buildFriendlyWhatsAppMessage,
  sendWhatsAppMessage,
};
