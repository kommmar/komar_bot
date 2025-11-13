// api/bybit.js — версия с прокси для Украины
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";

const BASE = "https://api.bybit.com";
const PROXY_URL = process.env.PROXY_URL || "";
const proxyAgent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : null;

function tfMinToBybitOI(min) {
  const m = Number(String(min).replace("m", ""));
  if (m === 5) return "5min";
  if (m === 15) return "15min";
  if (m === 30) return "30min";
  if (m === 60) return "1h";
  if (m === 120) return "2h";
  if (m === 240) return "4h";
  if (m === 720) return "12h";
  if (m === 1440) return "1d";
  return "15min";
}

// === Klines ===
export async function getKlines(symbol, interval = "15", limit = 200) {
  try {
    const res = await axios.get(`${BASE}/v5/market/kline`, {
      httpsAgent: proxyAgent, httpAgent: proxyAgent,
      params: { category: "linear", symbol, interval, limit },
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    const list = res.data?.result?.list || [];
    // +++ КРИТИЧНЕ ВИПРАВЛЕННЯ: Сортування Bybit +++
    // Bybit повертає свічки від найновішої до найстарішої, 
    // але для індикаторів потрібен порядок від найстарішої до найновішої.
    return list.reverse(); 
    // +++ КІНЕЦЬ ВИПРАВЛЕННЯ +++
  } catch (e) {
    console.warn(`Bybit Klines error (${symbol}): ${e.message}`);
    return [];
  }
}

// === Open Interest ===
export async function fetchOI(symbol, tfMinStr) {
  const tf = tfMinToBybitOI(tfMinStr);
  try {
    const res = await axios.get(`${BASE}/v5/market/open-interest`, {
      httpsAgent: proxyAgent, httpAgent: proxyAgent,
      params: { category: "linear", symbol, intervalTime: tf, limit: 30 },
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    const list = res.data?.result?.list;
    if (!list || list.length < 2) return { oiPct: null, totalOIUsd: null };

    const prev = parseFloat(list[list.length - 2].openInterest);
    const cur = parseFloat(list[list.length - 1].openInterest);
    const valUsd = parseFloat(list[list.length - 1].value || 0);
    const oiPct = prev ? ((cur - prev) / prev) * 100 : 0;
    return { oiPct, totalOIUsd: valUsd || cur };
  } catch (e) {
    console.warn(`Bybit OI fetch error (${symbol}, TF=${tfMinStr}): ${e.message}`);
    return { oiPct: null, totalOIUsd: null };
  }
}

// === CVD ===
export async function fetchCVD(symbol, timeframeMin) {
  try {
    const tf = String(timeframeMin);
    const r = await axios.get(`${BASE}/v5/market/kline`, {
      httpsAgent: proxyAgent, httpAgent: proxyAgent,
      params: { category: "linear", symbol, interval: tf, limit: 2 },
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    const kl = r.data?.result?.list || [];
    if (!kl.length) return { cvdUsd: 0 };
    // Примітка: Для CVD ми беремо найновішу свічку, яка є першою в списку Bybit.
    const k = kl[0]; 
    const o = parseFloat(k[1]);
    const c = parseFloat(k[4]);
    const v = parseFloat(k[5]);
    const mid = (o + c) / 2;
    // Формула CVD: (close - open) / open * volume * mid_price 
    return { cvdUsd: ((c - o) / o) * v * mid }; 
  } catch (e) {
    console.warn(`Bybit CVD fetch error (${symbol}): ${e.message}`);
    return { cvdUsd: 0 };
  }
}

// === Активные символы ===
export async function getActiveSymbols(minQuote = 5000000) {
  try {
    const res = await axios.get(`${BASE}/v5/market/tickers`, {
      httpsAgent: proxyAgent, httpAgent: proxyAgent,
      params: { category: "linear" },
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    const list = res.data?.result?.list || [];
    return list
      .filter(x => x.symbol.endsWith("USDT"))
      .filter(x => Number(x.turnover24h) >= minQuote)
      .map(x => x.symbol);
  } catch (e) {
    console.error(`[❌ API Error] Bybit 24hr failed: ${e.message}`);
    throw e;
  }
}

// Заглушки
export async function getAllOI() { return {}; }
export async function getAllCVD() { return {}; }
export async function getUsdtPerpSymbols() { return getActiveSymbols(0); }
export async function getOpenInterestHistChange() { return null; }
export async function getOpenInterestChangeUsd() { return null; }
