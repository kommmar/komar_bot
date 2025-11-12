// api/binance.js — стабильный расчёт OI и CVD по свечам
import axios from "axios";

const BINANCE_API_BASE = "https://fapi.binance.com/fapi/v1";

function tfMinToBinancePeriod(min) {
  const m = Number(min);
  if (m === 5) return "5m";
  if (m === 15) return "15m";
  if (m === 30) return "30m";
  if (m === 60) return "1h";
  if (m === 120) return "2h";
  if (m === 240) return "4h";
  if (m === 360) return "6h";
  if (m === 720) return "12h";
  if (m === 1440) return "1d";
  return "15m";
}

// === Получение свечей ===
export async function getKlines(symbol, interval = "15m", limit = 200) {
  const url = `${BINANCE_API_BASE}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  try {
    const res = await axios.get(url);
    return res.data;
  } catch (e) {
    console.error(`Binance Klines fetch error (${symbol}): ${e.message}`);
    return [];
  }
}

// === OI ===
export async function fetchOI(symbol, tfMinStr) {
  const binancePeriod = tfMinToBinancePeriod(tfMinStr);
  try {
    const url = `https://fapi.binance.com/futures/data/openInterestHist`;
    const r = await axios.get(url, {
      params: { symbol, period: binancePeriod, limit: 30 },
    });
    const list = r.data;
    if (list.length < 2) return { oiPct: null, totalOIUsd: null };

    const lastItem = list[list.length - 1];
    const prevItem = list[list.length - 2];

    const prev = parseFloat(prevItem.sumOpenInterest);
    const cur = parseFloat(lastItem.sumOpenInterest);

    // === Новый расчёт USD-значения через последнюю цену ===
    let totalOIUsd = parseFloat(lastItem.sumOpenInterestValue);
    if (!totalOIUsd || totalOIUsd === 0) {
      try {
        const kl = await getKlines(symbol, binancePeriod, 1);
        const lastClose = parseFloat(kl[0]?.[4] || 1);
        totalOIUsd = cur * lastClose;
      } catch {
        totalOIUsd = cur;
      }
    }

    if (prev === 0) return { oiPct: 0, totalOIUsd };
    return { oiPct: ((cur - prev) / prev) * 100, totalOIUsd };
  } catch (e) {
    if (!String(e.message).includes("404")) {
      console.warn(`Binance OI fetch error (${symbol}): ${e.message}`);
    }
    return { oiPct: null, totalOIUsd: null };
  }
}

// === CVD по свечам (реалистичные данные) ===
export async function fetchCVD(symbol, timeframeMin) {
  try {
    const interval = tfMinToBinancePeriod(timeframeMin);
    const url = `${BINANCE_API_BASE}/klines?symbol=${symbol}&interval=${interval}&limit=2`;
    const r = await axios.get(url);
    const kl = r.data;
    if (!kl || !kl.length) return { cvdUsd: 0 };

    const [ , open, , , close, volume ] = kl[kl.length - 1];
    const o = parseFloat(open);
    const c = parseFloat(close);
    const v = parseFloat(volume);
    const midPrice = (o + c) / 2;
    const volUsd = v * midPrice;

    // Приближение CVD: положительный для бычьих свечей, отрицательный для медвежьих
    const cvdUsd = ((c - o) / o) * volUsd;

    return { cvdUsd };
  } catch (e) {
    console.warn(`Binance CVD fetch error (${symbol}): ${e.message}`);
    return { cvdUsd: 0 };
  }
}

// === Активные символы ===
export async function getActiveSymbols(minQuote) {
  try {
    const res = await axios.get(`${BINANCE_API_BASE}/ticker/24hr`);
    return res.data
      .filter(x => x.symbol.endsWith("USDT"))
      .filter(x => Number(x.quoteVolume) >= minQuote)
      .map(x => x.symbol);
  } catch (e) {
    console.error(`[❌ API Error] Binance 24hr failed: ${e.message}`);
    throw e;
  }
}

// === Совместимость ===
export async function getAllOI() { return {}; }
export async function getAllCVD() { return {}; }
export async function getUsdtPerpSymbols() { return getActiveSymbols(0); }
export async function getOpenInterestHistChange() { return null; }
export async function getOpenInterestChangeUsd() { return null; }