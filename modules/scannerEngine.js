// modules/scannerEngine.js (Новая логика PumpDump + Мульти-Поиск Дивергенций)
import { GLOBAL, DEFAULTS } from "./config.js";
import { rsi, sma, macd, klineHistory } from "./indicators.js";
import * as binanceApi from "../api/binance.js";
import * as bybitApi from "../api/bybit.js";
import { tfToMinutes, subscriptions } from "./wsManager.js";
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
    const norm = [Number(kline[0]), Number(kline[1]), Number(kline[2]), Number(kline[3]), Number(kline[4]), Number(kline[5])];
    arr.push(norm);
    if (arr.length > 200) arr.shift();
    klineHistory.set(key, arr);

    const oiData = CACHE.OI.get(exchange)?.get(symbol)?.get(tfKey);
    const cvdData = CACHE.CVD.get(exchange)?.get(symbol)?.get(tfKey);
    const oiVal = Number(oiData?.oiPct ?? 0);
    const cvdVal = Number(cvdData?.cvdUsd ?? 0);
    const oiVolUsd = Number(oiData?.totalOIUsd ?? 0); // Это *Общий* OI, а не дельта

    for (const [chatId, { user, onSignal }] of USERS.entries()) {
      const mods = user.modules.filter(m => (user.perModuleTF?.[m] || "5m") === tfKey);
      if (mods.length === 0) continue;
      for (const mod of mods) {
        const sig = analyzeModule(mod, arr, oiVal, cvdVal, user, oiVolUsd, symbol, exchange);
        if (sig) {
          onSignal({
            exchange,
            symbol,
            side: sig.side,
            kind: sig.kind,
            price: sig.price,
            ts: Date.now(),
            detail: {
              ...sig.detail,
              signalTf: tfKey,
              signalActualTf: tfKey,
              signalMode: "RT",
              oiVolUsd: oiVolUsd, // Передаем Общий OI $ для информации в сигнале
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

function volumesArr(kl) { return kl.map(k => Number(k[5])); }
function closesArr(kl)  { return kl.map(k => Number(k[4])); }

function analyzeModule(name, kl, oiVal, cvdVal, u, oiVolUsd = 0, sym = "UNKNOWN", exchange = "binance") {
  try {
    if (name === "sp") return analyzeSmartPump(kl, oiVal, cvdVal, u, oiVolUsd);
    if (name === "pd") return analyzePumpDump(kl, oiVal, cvdVal, u, oiVolUsd);
    if (name === "div") return analyzeDivergenceSmart(kl, oiVal, cvdVal, u);
  } catch (e) { console.warn(`[analyzeModule ${name}]`, e.message); }
  return null;
}

// --- SMART PUMP ---
function analyzeSmartPump(kl, oiVal, cvdVal, u, oiVolUsd = 0) {
  const d = u.sp || {};
  const idx = kl.length - 1;
  const last = kl[idx];
  const prev = kl[idx - 1];
  if (!last || !prev || oiVal === 0) return null;
  const open = +last[1], close = +last[4];
  const priceChangePct = ((close - open) / open) * 100;
  const minOIPct = Number(d.oiPlusPct) || 1;
  const isLong = oiVal >= minOIPct && priceChangePct > 0;
  const isShort = oiVal <= -minOIPct && priceChangePct < 0;
  if (!isLong && !isShort) return null;

  const vol = volumesArr(kl);
  const cls = closesArr(kl);
  const volUsd = vol.map((v, i) => (v * cls[i]) / 1e6);
  const vAvg = sma(volUsd.slice(0, idx), 20);
  const vLast = volUsd[idx];
  const volMult = vAvg ? vLast / vAvg : 1;

  const side = isLong ? "Лонг" : "Шорт";
  return { side, kind: "⚡ Smart Pump", price: close, detail: { oi: oiVal, cvd: cvdVal, volMult } };
}

// --- PUMPDUMP (Новая логика: OI %, CVD $, Body %, Vol x) ---
function analyzePumpDump(kl, oiVal, cvdVal, u, oiVolUsd = 0) {
  const d = u.pd || {};
  const idx = kl.length - 1;
  const last = kl[idx];

  // 1. Фильтр мин. % изменения OI (Главный триггер)
  const minOIPct = Number(d.oiPct) || 1;
  const isOiLong = oiVal >= minOIPct;
  const isOiShort = oiVal <= -minOIPct;
  if (!isOiLong && !isOiShort) return null;

  // 2. Фильтр мин. $ CVD
  const minCvdUsd = Number(d.cvdUsdMin) || 0;
  const isCvdLong = cvdVal >= minCvdUsd;
  const isCvdShort = cvdVal <= -minCvdUsd; // (Например: -150k <= -100k)

  // Определяем направление сигнала по OI и CVD
  const isPump = isOiLong && isCvdLong; // Памп, если OI > 3% И CVD > 100k
  const isDump = isOiShort && isCvdShort; // Дамп, если OI < -3% И CVD < -100k

  if (!isPump && !isDump) return null; // Если OI и CVD не совпадают, игнорируем

  // 3. Фильтр мин. тела свечи
  const open = +last[1], close = +last[4], high = +last[2], low = +last[3];
  const priceChangePct = ((close - open) / open) * 100;
  const minBodyPct = Number(d.minBodyPct) || 20;
  const body = Math.abs(close - open);
  const candleRange = Math.max(1e-9, high - low);
  const bodyPct = (body / candleRange) * 100;
  if (bodyPct < minBodyPct) return null;

  // 4. Фильтр мин. множителя объёма
  const vol = volumesArr(kl);
  const cls = closesArr(kl);
  const volUsd = vol.map((v, i) => (v * cls[i]) / 1e6); // в MUSD
  const vAvg = sma(volUsd.slice(0, idx), 20);
  const vLast = volUsd[idx];
  const volMult = vAvg ? vLast / vAvg : 1;
  const minVolX = Number(d.minVolX) || 0;
  if (volMult < minVolX) return null;

  // 5. Финальная проверка: направление цены должно совпадать
  if (isPump && priceChangePct <= 0) return null; // Памп, а свеча красная? Игнор.
  if (isDump && priceChangePct >= 0) return null; // Дамп, а свеча зеленая? Игнор.

  const side = isPump ? "Лонг" : "Шорт";
  return { side, kind: "🚀 PumpDump", price: close, detail: { oi: oiVal, cvd: cvdVal, volMult, bodyPct } };
}


// --- DIVERGENCE (с НОВЫМ МУЛЬТИ-ПОИСКОМ) ---
function analyzeDivergenceSmart(kl, oiVal, cvdVal, u) {
  const d = u.div || {};
  if (!kl || kl.length < 50) return null; // Требуем больше истории для поиска
  const cls = closesArr(kl);
  const rsiSeries = rsi(cls, Number(d.rsiPeriod || 14)); // У вас 9
  if (rsiSeries.length === 0) return null;
  const idx = kl.length - 1;
  
  // +++ НОВАЯ ЛОГИКА: ПРОВЕРЯЕМ НЕСКОЛЬКО ИНТЕРВАЛОВ +++
  const lookbacks = [5, 8, 13, 21]; // Проверяем 5, 8, 13 и 21 свечу назад
  // +++ КОНЕЦ НОВОЙ ЛОГИКИ +++

  const diff = Number(d.rsiMinDiff || 4); // У вас 2
  const RSI_OVERSOLD = Number(d.rsiOversold || 30); // У вас 45
  const RSI_OVERBOUGHT = Number(d.rsiOverbought || 70); // У вас 65
  
  let side = null;
  let foundLookback = null;
  let rsiPrevFound = null;

  const priceNow = +kl[idx][4];
  const rsiNow = rsiSeries[idx];
  
  if (rsiNow === null) return null; // RSI может быть null в начале

  // +++ НОВЫЙ ЦИКЛ ПОИСКА +++
  for (const lookback of lookbacks) {
    const idxPrev = idx - lookback;
    if (idxPrev < 0) continue; // Недостаточно истории

    const pricePrev = +kl[idxPrev][4];
    const rsiPrev = rsiSeries[idxPrev];
    
    if (rsiPrev === null) continue; // RSI может быть null

    // Бычья дивергенция (цена ниже, RSI выше, прошлый RSI был в зоне)
    if (priceNow < pricePrev && rsiNow > rsiPrev + diff && rsiPrev <= RSI_OVERSOLD) {
      side = "Лонг";
      foundLookback = lookback;
      rsiPrevFound = rsiPrev;
      break; // Нашли, выходим из цикла
    }
    
    // Медвежья дивергенция (цена выше, RSI ниже, прошлый RSI был в зоне)
    if (priceNow > pricePrev && rsiNow < rsiPrev - diff && rsiPrev >= RSI_OVERBOUGHT) {
      side = "Шорт";
      foundLookback = lookback;
      rsiPrevFound = rsiPrev;
      break; // Нашли, выходим из цикла
    }
  }
  // +++ КОНЕЦ ЦИКЛА ПОИСКА +++

  if (!side) return null; // Ничего не нашли

  // --- Strict Mode (MACD) ---
  // Так как у вас "Soft" режим, эта проверка будет пропущена
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
  
  // --- volMult для диверов ---
  const vol = volumesArr(kl);
  const cls2 = closesArr(kl);
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
      lookback: foundLookback, // Добавим для информации, какой интервал сработал
    },
  };
}