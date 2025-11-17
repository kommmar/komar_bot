// modules/config.js — ФИНАЛЬНАЯ ВЕРСИЯ (Обновленные настройки SP)

export const GLOBAL = {
  MAX_SYMBOLS_PER_EXCHANGE: 300, 
  MAX_SIGNALS_PER_PASS: 16 
};

export const DEFAULTS = {
  exchanges: ["binance", "bybit"],
  modules: ["sp", "pd", "div"],

  perModuleTF: {
    sp: "5m",
    pd: "15m",
    div: "15m"
  },

  // === НАСТРОЙКИ SMART PUMP 2.0 ===
  sp: {
    oiPlusPct: 2.0,     // Мин. рост OI (как и было)
    minPricePct: 0.8,   // НОВОЕ: Мин. % движения цены (фильтр шума)
    maxPricePct: 4.0,   // НОВОЕ: Макс. % движения (фильтр хаев/FOMO)
    minVolX: 1.5,       // НОВОЕ: Текущий объем должен быть в X раз выше среднего
    strictCvd: false    // НОВОЕ: Требовать подтверждение CVD (Вкл/Выкл)
  },
  // ===============================

  pd: {
    oiPct: 3,
    cvdUsdMin: 100000, // Мин. $ CVD
    minBodyPct: 0.3,
    minVolX: 2.0
  },

  div: {
    rsiPeriod: 14,
    rsiMinDiff: 6,
    rsiOverbought: 70,
    rsiOversold: 30,
    macdFast: 12,
    macdSlow: 26,
    macdSignal: 9,
    mode: "strict"
  },

  minVolumeUsd: 50_000_000, // $50M
  cooldownSec: 1800,        // 30 минут
  analysisMode: "Closed",
  authorized: true,
  realtime: true
};

export const MODULE_NAMES = {
  sp: "⚡ Smart Pump",
  pd: "🚀 Памп/Дамп (OI+CVD)",
  div: "📈 Дивергенция (RSI)",
};

export const TF_MAP = {
  "5m": { binance: "5m", bybit: "5" },
  "15m": { binance: "15m", bybit: "15" },
  "1h": { binance: "1h", bybit: "60" },
  "4h": { binance: "4h", bybit: "240" }
};
