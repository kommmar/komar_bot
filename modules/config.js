// modules/config.js (Финальная версия для WebSockets)

export const GLOBAL = {
  // SCAN_PERIOD_MS УДАЛЕН - теперь используется WebSockets
  MAX_SYMBOLS_PER_EXCHANGE: 300, 
  MAX_SIGNALS_PER_PASS: 16 
};

// modules/config.js
export const DEFAULTS = {
  exchanges: ["binance", "bybit"],
  modules: ["sp", "pd", "div"],

  perModuleTF: {
    sp: "5m",
    pd: "15m",
    div: "15m"
  },

  sp: {
    oiPlusPct: 0.02 // 2%
  },

  pd: {
    oiPct: 0.05,
    // +++ ЛОГИКА ИЗМЕНЕНА +++
    // oiUsdMin: 500000, // УДАЛЕНО
    cvdUsdMin: 100000, // ДОБАВЛЕНО (Мин. $ CVD)
    // +++ КОНЕЦ ИЗМЕНЕНИЯ +++
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