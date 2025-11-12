// api/bybit.js — стабильная версия для фьючерсов (linear)
import axios from "axios";

const BASE = "https://api.bybit.com";

// +++ ДОБАВЛЕН КОНВЕРТЕР ТАЙМФРЕЙМОВ ДЛЯ OI +++
function tfMinToBybitOI(min) {
  const m = Number(String(min).replace("m", ""));
  if (m === 5) return "5min";
  if (m === 15) return "15min";
  if (m === 30) return "30min";
  if (m === 60) return "1h";
  if (m === 120) return "2h";
  if (m === 240) return "4h";
  if (m === 360) return "6h";
  if (m === 720) return "12h";
  if (m === 1440) return "1d";
  return "15min"; // Значение по умолчанию
}
// +++ КОНЕЦ ДОБАВЛЕНИЯ +++

// === Получение Klines (linear only) ===
export async function getKlines(symbol, interval = "15m", limit = 200) {
  try {
    const res = await axios.get(`${BASE}/v5/market/kline`, {
      params: { category: "linear", symbol, interval, limit },
    });
    return res.data?.result?.list || [];
  } catch (e) {
    console.warn(`Bybit Klines error (${symbol}): ${e.message}`);
    return [];
  }
}

// === Open Interest (исправленный intervalTime) ===
export async function fetchOI(symbol, tfMinStr) {
  try {
    // +++ ЭТА СТРОКА ИЗМЕНЕНА +++
    const tf = tfMinToBybitOI(tfMinStr);
    // +++ КОНЕЦ ИЗМЕНЕНИЯ +++

    const res = await axios.get(`${BASE}/v5/market/open-interest`, {
      params: { 
          category: "linear", 
          symbol, 
          intervalTime: tf,
          limit: 30 // Добавим лимит для надежности
      },
    });

    const list = res.data?.result?.list;
    if (!list || list.length < 2)
      return { oiPct: null, totalOIUsd: null };

    const prev = parseFloat(list[list.length - 2].openInterest);
    const cur = parseFloat(list[list.length - 1].openInterest);
    const valUsd = parseFloat(list[list.length - 1].value || 0);

    const oiPct = prev ? ((cur - prev) / prev) * 100 : 0;
    const totalOIUsd = valUsd || cur;

    return { oiPct, totalOIUsd };
  } catch (e) {
    // Улучшаем логгирование
    if (!String(e.message).includes("404")) {
       console.warn(`Bybit OI fetch error (${symbol}, TF=${tfMinStr}): ${e.message}`);
    }
    return { oiPct: null, totalOIUsd: null };
  }
}

// === CVD (только linear) ===
export async function fetchCVD(symbol, timeframeMin) {
  try {
    const tf =
      timeframeMin === 5 ? "5" :
      timeframeMin === 15 ? "15" :
      timeframeMin === 60 ? "60" :
      timeframeMin === 240 ? "240" : "5";

    const r = await axios.get(`${BASE}/v5/market/kline`, {
      params: { category: "linear", symbol, interval: tf, limit: 2 },
    });

    const kl = r.data?.result?.list || [];
    if (!kl.length) return { cvdUsd: 0 };

    // свеча [timestamp, open, high, low, close, volume, turnover]
    const k = kl[0];
    const o = parseFloat(k[1]);
    const c = parseFloat(k[4]);
    const v = parseFloat(k[5]);
    const midPrice = (o + c) / 2;
    const volUsd = v * midPrice;
    const cvdUsd = ((c - o) / o) * volUsd;

    return { cvdUsd };
  } catch (e) {
    console.warn(`Bybit CVD fetch error (${symbol}): ${e.message}`);
    return { cvdUsd: 0 };
  }
}

// === Список активных фьючерсов (только linear) ===
export async function getActiveSymbols(minQuote = 5000000) {
  try {
    const res = await axios.get(`${BASE}/v5/market/tickers`, {
      params: { category: "linear" },
    });
    const linear = res.data?.result?.list || [];
    return linear
      .filter(x => x.symbol.endsWith("USDT"))
      .filter(x => Number(x.turnover24h) >= minQuote)
      .map(x => x.symbol);
  } catch (e) {
    console.error(`[❌ API Error] Bybit 24hr failed: ${e.message}`);
    throw e;
  }
}

// === Совместимость (заглушки, если вызываются старые функции) ===
export async function getAllOI() { return {}; }
export async function getAllCVD() { return {}; }
export async function getUsdtPerpSymbols() { return getActiveSymbols(0); }
export async function getOpenInterestHistChange() { return null; }
export async function getOpenInterestChangeUsd() { return null; }