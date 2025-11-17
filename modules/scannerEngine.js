// modules/scannerEngine.js — ФИНАЛЬНАЯ ВЕРСИЯ (Smart Pump 2.0 Logic)
import { GLOBAL, DEFAULTS } from "./config.js";
import { rsi, sma, macd, klineHistory } from "./indicators.js";
import * as binanceApi from "../api/binance.js";
import * as bybitApi from "../api/bybit.js";
import { tfToMinutes, subscriptions } from "./wsManager.js";
import { loadKlineHistory, saveKlineHistory } from "./userManager.js"; 
import { createRequire } from "module";
const require = createRequire(import.meta.url);

let pLimit = require("p-limit");
if (typeof pLimit !== "function" && typeof pLimit.default === "function") pLimit = pLimit.default;
if (typeof pLimit !== "function" && typeof pLimit.pLimit === "function") pLimit = pLimit.pLimit;
if (typeof pLimit !== "function") throw new Error("[scannerEngine] ❌ p-limit is not a function");
const cacheLimit = pLimit(6);

const USERS = new Map();
export function registerUser(chatId, user, onSignal) { USERS.set(chatId, { user, onSignal }); }
export function unregisterUser(chatId) { USERS.delete(chatId); }

const CACHE = { OI: new Map(), CVD: new Map() };
export function startCacheUpdater() {
  console.log("[CACHE] updater every 5m");
  updateCache();
  setInterval(updateCache, 5 * 60 * 1000);
}

async function updateCache() {
  try {
    const active = new Map();
    for (const [key, sub] of subscriptions.entries()) {
      if (sub.count > 0) {
        const [ex, stream, sym, tf] = key.split(":");
        if (stream === "KLINE")
          active.set(`${ex}:${sym}:${tf}`.toUpperCase(), { ex: ex.toLowerCase(), sym, tf: tf.toLowerCase() });
      }
    }
    if (active.size === 0) return;
    const tasks = [];
    for (const [, sub] of active) {
      tasks.push(cacheLimit(async () => {
        const api = sub.ex === "binance" ? binanceApi : bybitApi;
        const tfM = tfToMinutes(sub.tf);
        try {
          const [oi, cvd] = await Promise.all([api.fetchOI(sub.sym, tfM), api.fetchCVD(sub.sym, tfM)]);
          if (oi && oi.oiPct != null) {
            if (!CACHE.OI.has(sub.ex)) CACHE.OI.set(sub.ex, new Map());
            if (!CACHE.OI.get(sub.ex).has(sub.sym)) CACHE.OI.get(sub.ex).set(sub.sym, new Map());
            CACHE.OI.get(sub.ex).get(sub.sym).set(sub.tf, oi);
          }
          if (cvd && cvd.cvdUsd != null) {
            if (!CACHE.CVD.has(sub.ex)) CACHE.CVD.set(sub.ex, new Map());
            if (!CACHE.CVD.get(sub.ex).has(sub.sym)) CACHE.CVD.get(sub.ex).set(sub.sym, new Map());
            CACHE.CVD.get(sub.ex).get(sub.sym).set(sub.tf, cvd);
          }
        } catch (e) {
          if (!String(e.message || "").includes("404")) console.warn("[CACHE] update error:", e.message);
        }
      }));
    }
    await Promise.allSettled(tasks);
    console.log(`[CACHE] refresh complete (OI ex=${CACHE.OI.size}, CVD ex=${CACHE.CVD.size})`);
  } catch (e) { console.warn("[CACHE] global error:", e.message); }
}

export async function handleKlineUpdate(exchange, symbol, tf, kline) {
  try {
    const tfKey = normalizeTf(exchange, tf);
    const key = `${exchange}:${symbol}:${tfKey}`.toUpperCase();
    const arr = klineHistory.get(key) || [];
    
    // kline[6] - это is_final/is_closed
    const isClosed = kline[6] === true; 
    const norm = [Number(kline[0]), Number(kline[1]), Number(kline[2]), Number(kline[3]), Number(kline[4]), Number(kline[5]), isClosed];
    
    if (isClosed) { 
        arr.push(norm); 
        if (arr.length > 200) arr.shift();
        await saveKlineHistory(key, arr); 
    } else {
        if (arr.length > 0 && arr[arr.length - 1][6] === false) {
            arr[arr.length - 1] = norm;
        } else {
            arr.push(norm);
        }
    }
    
    klineHistory.set(key, arr);

    const oiData = CACHE.OI.get(exchange)?.get(symbol)?.get(tfKey);
    const cvdData = CACHE.CVD.get(exchange)?.get(symbol)?.get(tfKey);
    const oiVal = Number(oiData?.oiPct ?? 0);
    const cvdVal = Number(cvdData?.cvdUsd ?? 0);
    const oiVolUsd = Number(oiData?.totalOIUsd ?? 0); 

    for (const [chatId, { user, onSignal }] of USERS.entries()) {
      const mods = user.modules.filter(m => (user.perModuleTF?.[m] || "5m") === tfKey);
      if (mods.length === 0) continue;
      for (const mod of mods) {
        // Анализ только на закрытых свечах (последняя в массиве, если она закрыта)
        const sig = analyzeModule(mod, arr, oiVal, cvdVal, user, oiVolUsd, symbol, exchange);
        if (sig) {
          onSignal({
            exchange,
            symbol,
            side: sig.side,
            kind: sig.kind,
            price: sig.price,
            ts: Date.now(),
            candleTs: sig.detail?.candleTs || Date.now(), // Для дедупликации
            detail: {
              ...sig.detail,
              signalTf: tfKey,
              signalActualTf: tfKey,
              signalMode: "RT",
              oiVolUsd: oiVolUsd, 
            },
          });
        }
      }
    }
  } catch (e) { console.warn(`[handleKlineUpdate ERR] ${exchange}:${symbol}:${tf}:`, e.message); }
}

function normalizeTf(exchange, tf) {
  const s = String(tf).toLowerCase();
  if (exchange === "bybit") {
    if (s === "5" || s === "5m") return "5m";
    if (s === "15" || s === "15m") return "15m";
    if (s === "60" || s === "1h") return "1h";
    if (s === "240" || s === "4h") return "4h";
  }
  if (s === "60") return "1h";
  if (s === "240") return "4h";
  return s;
}

function volumesArr(kl) { return kl.filter(k => k[6] === true).map(k => Number(k[5])); } 
function closesArr(kl)  { return kl.filter(k => k[6] === true).map(k => Number(k[4]));} 

function analyzeModule(name, kl, oiVal, cvdVal, u, oiVolUsd = 0, sym = "UNKNOWN", exchange = "binance") {
  try {
    if (name === "sp") return analyzeSmartPump(kl, oiVal, cvdVal, u, oiVolUsd);
    if (name === "pd") return analyzePumpDump(kl, oiVal, cvdVal, u, oiVolUsd);
    if (name === "div") return analyzeDivergenceSmart(kl, oiVal, cvdVal, u);
  } catch (e) { console.warn(`[analyzeModule ${name}]`, e.message); }
  return null;
}

// === SMART PUMP 2.0 (ОБНОВЛЕНО) ===
function analyzeSmartPump(kl, oiVal, cvdVal, u, oiVolUsd = 0) {
  const d = u.sp || {};
  const closedKlines = kl.filter(k => k[6] === true);
  const idx = closedKlines.length - 1;
  const last = closedKlines[idx];
  
  // Если данных нет или OI = 0 (не загрузился), выходим
  if (!last || oiVal === 0) return null;

  const open = +last[1], close = +last[4];
  // 1. Расчет % изменения цены свечи
  const priceChangePct = ((close - open) / open) * 100;

  // 2. Проверка направления OI и Цены
  const minOIPct = Number(d.oiPlusPct) || 2.0;
  
  // ЛОНГ: Цена растет + OI растет (набор лонгов)
  const isOiLong = oiVal >= minOIPct && priceChangePct > 0;
  // ШОРТ: Цена падает + OI растет (набор шортов)
  // Важно: Мы фильтруем ситуации, где OI падает (закрытие позиций/сквиз), требуя oiVal >= minOIPct (положительное число)
  const isOiShort = oiVal >= minOIPct && priceChangePct < 0; 

  if (!isOiLong && !isOiShort) return null;

  // 3. Фильтр Цены (Импульс)
  const absChange = Math.abs(priceChangePct);
  const minPrice = Number(d.minPricePct) || 0.5; // По умолчанию 0.5%, если не задано
  const maxPrice = Number(d.maxPricePct) || 10.0;
  
  if (absChange < minPrice) return null; // Слишком мелко (шум)
  if (absChange > maxPrice) return null; // Слишком высоко (уже поздно)

  // 4. Фильтр Объема (Топливо)
  const vol = volumesArr(closedKlines);
  const cls = closesArr(closedKlines);
  const volUsd = vol.map((v, i) => (v * cls[i])); 
  const vAvg = sma(volUsd.slice(0, idx), 20);
  const vLast = volUsd[idx];
  const volMult = vAvg ? vLast / vAvg : 1;
  
  const minVolX = Number(d.minVolX) || 0;
  if (volMult < minVolX) return null; // Нет аномалии объема

  // 5. Фильтр CVD (Опционально)
  if (d.strictCvd) {
      // Лонг: требуют покупок по рынку (CVD > 0)
      if (isOiLong && cvdVal <= 0) return null; 
      // Шорт: требуют продаж по рынку (CVD < 0)
      if (isOiShort && cvdVal >= 0) return null;
  }

  const side = isOiLong ? "Лонг" : "Шорт";
  return { 
      side, 
      kind: "⚡ Smart Pump", 
      price: close, 
      detail: { 
          oi: oiVal, 
          cvd: cvdVal, 
          volMult, 
          priceChangePct,
          candleTs: last[0] // Время свечи
      } 
  };
}

// --- PUMPDUMP ---
function analyzePumpDump(kl, oiVal, cvdVal, u, oiVolUsd = 0) {
  const d = u.pd || {};
  const closedKlines = kl.filter(k => k[6] === true);
  const idx = closedKlines.length - 1;
  const last = closedKlines[idx];

  const minOIPct = Number(d.oiPct) || 1;
  const isOiLong = oiVal >= minOIPct;
  const isOiShort = oiVal <= -minOIPct;
  if (!isOiLong && !isOiShort) return null;

  const minCvdUsd = Number(d.cvdUsdMin) || 0;
  const isCvdLong = cvdVal >= minCvdUsd;
  const isCvdShort = cvdVal <= -minCvdUsd; 

  const isPump = isOiLong && isCvdLong; 
  const isDump = isOiShort && isCvdShort; 

  if (!isPump && !isDump) return null; 

  const open = +last[1], close = +last[4], high = +last[2], low = +last[3];
  const priceChangePct = ((close - open) / open) * 100;
  const minBodyPct = Number(d.minBodyPct) || 20;
  const body = Math.abs(close - open);
  const candleRange = Math.max(1e-9, high - low);
  const bodyPct = (body / candleRange) * 100;
  if (bodyPct < minBodyPct) return null;

  const vol = volumesArr(closedKlines);
  const cls = closesArr(closedKlines);
  const volUsd = vol.map((v, i) => (v * cls[i])); 
  const vAvg = sma(volUsd.slice(0, idx), 20);
  const vLast = volUsd[idx];
  const volMult = vAvg ? vLast / vAvg : 1;
  const minVolX = Number(d.minVolX) || 0;
  if (volMult < minVolX) return null;

  if (isPump && priceChangePct <= 0) return null; 
  if (isDump && priceChangePct >= 0) return null; 

  const side = isPump ? "Лонг" : "Шорт";
  return { side, kind: "🚀 PumpDump", price: close, detail: { oi: oiVal, cvd: cvdVal, volMult, bodyPct, candleTs: last[0] } };
}


// --- DIVERGENCE ---
function analyzeDivergenceSmart(kl, oiVal, cvdVal, u) {
  const d = u.div || {};
  const closedKlines = kl.filter(k => k[6] === true);
  
  if (!closedKlines || closedKlines.length < 25) return null;
  const cls = closesArr(closedKlines);
  const rsiSeries = rsi(cls, Number(d.rsiPeriod || 14));
  if (rsiSeries.length === 0) return null;
  const idx = closedKlines.length - 1;
  
  const lookbacks = [5, 8, 13, 21];

  const diff = Number(d.rsiMinDiff || 4);
  const RSI_OVERSOLD = Number(d.rsiOversold || 30);
  const RSI_OVERBOUGHT = Number(d.rsiOverbought || 70);
  
  let side = null;
  let foundLookback = null;
  let rsiPrevFound = null;

  const priceNow = +closedKlines[idx][4];
  const rsiNow = rsiSeries[idx];
  
  if (rsiNow === null) return null;

  for (const lookback of lookbacks) {
    const idxPrev = idx - lookback;
    if (idxPrev < 0) continue; 

    const pricePrev = +closedKlines[idxPrev][4];
    const rsiPrev = rsiSeries[idxPrev];
    
    if (rsiPrev === null) continue; 

    if (priceNow < pricePrev && rsiNow > rsiPrev + diff && rsiPrev <= RSI_OVERSOLD) {
      side = "Лонг";
      foundLookback = lookback;
      rsiPrevFound = rsiPrev;
      break; 
    }
    
    if (priceNow > pricePrev && rsiNow < rsiPrev - diff && rsiPrev >= RSI_OVERBOUGHT) {
      side = "Шорт";
      foundLookback = lookback;
      rsiPrevFound = rsiPrev;
      break; 
    }
  }

  if (!side) return null;

  const strictMode = String(d.mode || "soft").toLowerCase() === "strict";
  if (strictMode) {
      const { macdLine, signalLine } = macd(cls, d.macdFast || 12, d.macdSlow || 26, d.macdSignal || 9);
      const macdLen = macdLine.length;
      const macdOffset = cls.length - macdLen;
      const macdIdx = idx - macdOffset;
      if (macdIdx < 1) return null;
      const isCrossLong = macdLine[macdIdx - 1] < signalLine[macdIdx - 1] && macdLine[macdIdx] >= signalLine[macdIdx];
      const isCrossShort = macdLine[macdIdx - 1] > signalLine[macdIdx - 1] && macdLine[macdIdx] <= signalLine[macdIdx];
      const macdNow = macdLine[macdIdx];
      const macdOk =
        (side === "Лонг" && isCrossLong && macdNow <= 0) ||
        (side === "Шорт" && isCrossShort && macdNow >= 0);
      if (!macdOk) return null;
  }
  
  const vol = volumesArr(closedKlines);
  const cls2 = closesArr(closedKlines);
  const volUsdRaw = vol.map((v, i) => v * cls2[i]);
  const vAvg = sma(volUsdRaw.slice(0, idx), 20);
  const vLast = volUsdRaw[idx];
  const volMult = vLast / (vAvg || 1);

  return {
    side,
    kind: "🎯 Divergence",
    price: priceNow,
    detail: {
      oi: oiVal,
      cvd: cvdVal,
      volMult,
      strictMode,
      rsiNow,
      rsiPrev: rsiPrevFound,
      lookback: foundLookback,
      rsiOverbought: RSI_OVERBOUGHT, 
      rsiOversold: RSI_OVERSOLD,
      candleTs: closedKlines[idx][0]
    },
  };
}
