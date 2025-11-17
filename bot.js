// bot.js — ФИНАЛЬНАЯ ВЕРСИЯ (SP 2.0 + Исправленный MACD + Async DB)
import "dotenv/config";
import fs from "fs";
import TelegramBot from "node-telegram-bot-api";
import express from "express";
import { HttpsProxyAgent } from "https-proxy-agent";

import { startWsConnections, manageSubscription, unsubscribeAllForUser } from "./modules/wsManager.js";
import { startCacheUpdater, registerUser, unregisterUser } from "./modules/scannerEngine.js";
import { DEFAULTS as RAW_DEFAULTS, MODULE_NAMES } from "./modules/config.js";
import * as binanceApi from "./api/binance.js";
import * as bybitApi from "./api/bybit.js";
import { loadUserSettings, saveUserSettings, loadKlineHistory, saveKlineHistory, ensureDbConnection } from "./modules/userManager.js"; 


// ===== ENV =====
const TOKEN = process.env.TELEGRAM_TOKEN;
const SECRET_WORD = process.env.SECRET_WORD || "komar";
const PROXY_URL = process.env.PROXY_URL || "";
if (!TOKEN) {
  console.error("❌ TELEGRAM_TOKEN missing");
  process.exit(1);
}
const proxyAgent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : null;

if (proxyAgent) {
    console.log(`[PROXY] ✅ Agent created for: ${PROXY_URL.split('@').pop().split(':')[0]}`);
} else {
    console.log("[PROXY] ❌ Agent not created (PROXY_URL is empty).");
}

// ===== 1. Лок-файл (Защита от двойного запуска) =====
const LOCK_FILE = "/tmp/komar_bot.lock";
try {
  fs.writeFileSync(LOCK_FILE, process.pid.toString(), { flag: 'wx' }); 
  process.on("exit", () => { try { fs.unlinkSync(LOCK_FILE); } catch {} });
} catch (e) {
  if (e.code === 'EEXIST') {
      console.error(`[LOCK] ❌ Найдён другой запущенный процесс (PID ${fs.readFileSync(LOCK_FILE, 'utf8')}). Завершаюсь…`);
      process.exit(1); 
  }
  console.warn(`[LOCK] ⚠️ Не удалось записать lock-файл, продолжаю работу: ${e.message}`);
}

// ===== 2. Telegram Bot Инициализация =====
const bot = new TelegramBot(TOKEN, { polling: true });

(async () => {
  try {
    await bot.deleteWebHook({ drop_pending_updates: true });
    console.log("[TG] Webhook disabled. Polling clean start.");
  } catch (e) {
    console.error("[TG] deleteWebHook error:", e.message);
  }
})();

bot.getUpdates({ limit: 1 }).catch(err => {
  if (String(err.message || "").includes("409")) {
    console.error("❌ Обнаружен другой активный экземпляр (409) при старте. Завершаюсь…");
    process.exit(0);
  }
});

bot.getMe().then(me => console.log(`✅ Bot @${me.username}`)).catch(()=>{});

// ===== 3. Защита от Polling Error =====
let restarting = false;
bot.on("polling_error", async (err) => {
  const msg = String(err?.message || err);
  console.error("[POLLING ERROR]", msg);
  if (restarting) return;
    
  if (msg.includes("409") || msg.includes("499")) { 
    console.error("❌ Conflict: Обнаружен другой экземпляр. Принудительно завершаю процесс.");
    try { await bot.stopPolling(); } catch {}
    process.exit(1); 
    return;
  }

  restarting = true;
  try {
    await bot.stopPolling();
    await bot.deleteWebHook({ drop_pending_updates: true });
  } catch {}
  setTimeout(async () => {
    try {
      await bot.startPolling();
      console.log("[TG] Polling restarted.");
    } catch (e) {
      console.error("[TG] Poll restart failed:", e?.message || e);
    } finally {
      restarting = false;
    }
  }, 5000);
});

// ===== 4. Старт движка =====
startWsConnections(proxyAgent);
startCacheUpdater();

// ===== 5. Управление пользователями =====
const userCache = new Map();
function normalizeUser(u) {
  const D = RAW_DEFAULTS;
  return {
    ...D,
    ...u,
    modules: Array.isArray(u?.modules) ? u.modules : D.modules,
    exchanges: Array.isArray(u?.exchanges) ? u.exchanges : D.exchanges,
    sp: { ...D.sp, ...(u?.sp || {}) },
    pd: { ...D.pd, ...(u?.pd || {}) },
    div: { ...D.div, ...(u?.div || {}) },
    perModuleTF: { ...D.perModuleTF, ...(u?.perModuleTF || {}) },
    realtime: typeof u?.realtime === "boolean" ? u.realtime : true,
    minVolumeUsd: Number.isFinite(+u?.minVolumeUsd) ? +u.minVolumeUsd : D.minVolumeUsd,
    authorized: !!u?.authorized,
  };
}

async function ensureUser(id) {
  await ensureDbConnection(); 
  if (userCache.has(id)) return userCache.get(id);
  let u = await loadUserSettings(id, RAW_DEFAULTS);
  u = normalizeUser(u);
  userCache.set(id, u);
  return u;
}
function saveUser(id, u) {
  ensureDbConnection().then(() => {
    const n = normalizeUser(u);
    saveUserSettings(id, n);
    userCache.set(id, n);
  }).catch(e => console.error("[DB SAVE ERROR]:", e.message));
}

// ===== 6. Меню =====
const mainMenu = {
  reply_markup: {
    keyboard: [
      [{ text: "🚀 Начать" }, { text: "⛔ Стоп" }],
      [{ text: "⚙️ Настройки" }]
    ],
    resize_keyboard: true,
  },
};
const waitingInput = new Map();
const activeUsers = new Map();

// ===== 7. Форматирование сигналов =====
const sideEmoji = (s) => (s === "Лонг" ? "🟢" : s === "Шорт" ? "🔴" : "▪️");
const num = (v, d = 2) => { const n = Number(v); return Number.isFinite(n) ? n.toFixed(d) : "—"; };
const pct = (v) => { const n = Number(v); return Number.isFinite(n) ? (n > 0 ? "+" : "") + n.toFixed(2) + "%" : "—"; };
const money = (n) => { const v = Number(n); const a = Math.abs(v); if (a >= 1e6) return (v/1e6).toFixed(2) + "M$"; if (a >= 1e3) return (v/1e3).toFixed(1) + "K$"; return v.toFixed(0) + "$"; };

function formatSignal(sig) {
  const ex = String(sig.exchange || "").toUpperCase();
  const tf = sig.detail?.signalActualTf || sig.detail?.signalTf || "";
  const kind = sig.kind, side = sig.side, d = sig.detail || {};
  const kindName = kind.includes("Divergence") ? `ДИВЕРГЕНЦИЯ (${d.strictMode ? 'MACD' : 'RSI'})` : kind.toUpperCase();
  const title = `${sideEmoji(side)} ${side.toUpperCase()} • ${kindName} • ${ex} • ${sig.symbol} • ${tf}`;
  
  let baseLines = [
    `Цена закрытия:       \`${num(sig.price, 6)}\``,
    `Объем ×SMA20:        \`${num(d.volMult, 2)}×\``,
    `OI Дельта:           \`${pct(d.oi || 0)}\` (${money(d.oiVolUsd || 0)})`,
    `CVD Дельта:          \`${money(d.cvd || 0)}\``,
  ];
  
  // Для SP показываем изменение цены
  if (d.priceChangePct) {
      baseLines.splice(1, 0, `Изм. Цены:           \`${pct(d.priceChangePct)}\``);
  }

  let specificDetails = [];
  
  if (kind.includes("Divergence")) {
      const mode = d.strictMode ? "Strict (MACD)" : "Soft (RSI)";
      const rsiDirection = (side === 'Лонг' ? `Цена ↓ vs RSI ↑` : `Цена ↑ vs RSI ↓`);
      const rsiOversoldParam = d.rsiOversold || 30;
      const rsiOverboughtParam = d.rsiOverbought || 70;
      const zoneRequirement = (side === 'Лонг' ? `< ${rsiOversoldParam}` : `> ${rsiOverboughtParam}`);

      specificDetails = [
          `\n*📊 ДЕТАЛИ ДИВЕРГЕНЦИИ (${mode}):*`,
          `Направление:         ${rsiDirection}`,
          `RSI текущий:         \`${num(d.rsiNow, 1)}\` (Был: ${num(d.rsiPrev, 1)})`,
          `Сработало на:        \`${d.lookback} свеч назад\``,
          `Требование зоны:     ${zoneRequirement}`
      ];
      
      if (d.strictMode) {
          specificDetails.push(`MACD Пересечение:      ✅`);
      }
  }

  const oi = Number(d.oi), cvd = Number(d.cvd);
  const oiThreshold = 0.05; 
  const cvdThreshold = 1000; 
  const isOiLong = oi > oiThreshold;
  const isOiShort = oi < -oiThreshold;
  const isCvdLong = cvd > cvdThreshold;
  const isCvdShort = cvd < -cvdThreshold;
  let comment = "ℹ️ Направление OI/CVD не определено.";
  
  if (side === "Лонг") {
      if (isOiLong && isCvdLong) comment = "🟢 Лонг подтвержден! OI и CVD растут вместе → сильный бычий импульс.";
      else if (isCvdLong && !isOiLong) comment = "⚠️ Ложный рост (CVD↑, OI не растет). Возможен Short Squeeze.";
      else if (isOiLong && !isCvdLong) comment = "⚠️ Слабый Лонг (OI↑, CVD не растет). Нет поддержки покупателей.";
      else comment = "❌ Лонг не подтвержден. OI и CVD не показывают сильной активности.";
  } else if (side === "Шорт") {
      if (isOiShort && isCvdShort) comment = "🔴 Шорт подтвержден! OI и CVD падают вместе → сильный медвежий импульс.";
      else if (isCvdShort && !isOiShort) comment = "⚠️ Ложное падение (CVD↓, OI не падает). Возможен Long Squeeze.";
      else if (isOiShort && !isCvdShort) comment = "⚠️ Слабый Шорт (OI↓, CVD не падает). Нет поддержки продавцов.";
      else comment = "❌ Шорт не подтвержден. OI и CVD не показывают сильной активности.";
  }
  
  return `*${title}*\n---\n\n*💰 ТЕКУЩИЕ ПАРАМЕТРЫ:*\n${baseLines.join("\n")}\n\n${specificDetails.join("\n")}\n\n*АНАЛИЗ РИСКА:*\n${comment}`;
}

// Функция Анти-Спама
function makeOnSignal(chatId) {
  const dedup = new Map();
  const clearOldKeys = () => {
      const oneHourAgo = Date.now() - 3600 * 1000;
      for (const [key, ts] of dedup.entries()) {
          if (ts < oneHourAgo) dedup.delete(key);
      }
  };
  setInterval(clearOldKeys, 10 * 60 * 1000);

  return async (sig) => {
    const key = `${sig.exchange}:${sig.symbol}:${sig.kind}:${sig.detail?.signalTf}:${sig.candleTs}`;
    if (dedup.has(key)) return; 
    dedup.set(key, Date.now());
    
    try { 
      await bot.sendMessage(chatId, formatSignal(sig), { parse_mode: "Markdown" }); 
    }
    catch (e) { 
      console.error("[TG SEND ERROR]", e.message); 
      dedup.delete(key); 
    }
  };
}


// ===== 8. Обработчики сообщений =====
bot.onText(/^\/start$/, async (msg) => {
  const id = msg.chat.id;
  const u = await ensureUser(id);
  if (!u.authorized) {
    bot.sendMessage(id, "🔐 Введите секретное слово:");
    waitingInput.set(id, { field: "auth" });
  } else {
    bot.sendMessage(id, "👋 Привет! Реактивный режим включён.", mainMenu);
  }
});

bot.on("message", async (msg) => {
  try {
    const id = msg.chat.id;
    if (msg.chat.type !== "private") return;
    const text = (msg.text || "").trim();
    let u = await ensureUser(id);

    if (waitingInput.has(id)) {
      const w = waitingInput.get(id);
      waitingInput.delete(id);
      bot.deleteMessage(id, msg.message_id).catch(() => {});

      if (w.field === "auth") {
        if (text.toLowerCase() === SECRET_WORD.toLowerCase()) {
          u.authorized = true;
          saveUser(id, u);
          return bot.sendMessage(id, "✅ Доступ разрешён!", mainMenu);
        } else {
          return bot.sendMessage(id, "❌ Неверное секретное слово.");
        }
      }

      try {
        const value = parseFloat(text.replace(",", "."));
        if (!Number.isFinite(value)) throw new Error("NaN");
        const [mod, field] = w.field.split(".");
        if (mod === "common") u[field] = value;
        else if (["sp","pd","div"].includes(mod)) u[mod][field] = value;
        else return bot.sendMessage(id, "⚠️ Поле не распознано.");
        saveUser(id, u);
        return bot.sendMessage(id, `✅ Обновлено: ${mod}.${field} = ${value}`, mainMenu);
      } catch {
        return bot.sendMessage(id, "❌ Ошибка: нужно число.");
      }
    }

    if (!u.authorized) return bot.sendMessage(id, "🔐 Введите секретное слово.");

    if (text === "⚙️ Настройки") return renderRootSettings(id);

    if (text === "🚀 Начать") {
      if (activeUsers.has(id)) return bot.sendMessage(id, "⏳ Уже запущено.", mainMenu);
      if (u.modules.length === 0) return bot.sendMessage(id, "❌ Нет модулей.");
      if (u.exchanges.length === 0) return bot.sendMessage(id, "❌ Нет бирж.");

      const msgStart = await bot.sendMessage(id, "🔎 Реактивный запуск (WS подписки)...");
      registerUser(id, u, makeOnSignal(id));
      await subscribeUserUniverse(id, u);
      activeUsers.set(id, { subscribed: true });
      bot.deleteMessage(id, msgStart.message_id).catch(() => {});
      return bot.sendMessage(
        id,
        `✅ Реактивный режим включён\n🧩 Модули: \`${u.modules.join(", ")}\`\n💰 Биржи: \`${u.exchanges.join(", ")}\`\n⏱️ TF: \`SP:${u.perModuleTF.sp}, PD:${u.perModuleTF.pd}, DIV:${u.perModuleTF.div}\``,
        { ...mainMenu, parse_mode: "Markdown" }
      );
    }

    if (text === "⛔ Стоп") {
      if (!activeUsers.has(id)) return bot.sendMessage(id, "⏹ Уже остановлено.", mainMenu);
      unregisterUser(id);
      await unsubscribeAllForUser(id);
      activeUsers.delete(id);
      return bot.sendMessage(id, "🛑 Реактивный режим остановлен.", mainMenu);
    }
  } catch (e) {
    console.error("[BOT ERROR]", e.message);
  }
});

// ===== 9. UI (Меню и Кнопки) =====
function renderRootSettings(id) {
  const text = "⚙️ Настройки:";
  const markup = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🧩 Модули", callback_data: "modules" }],
        [{ text: "💰 Биржи",  callback_data: "exchanges" }],
        [{ text: "🧠 Smart Pump", callback_data: "sp" }],
        [{ text: "📈 PumpDump",   callback_data: "pd" }],
        [{ text: "🎯 Divergence", callback_data: "div" }],
        [{ text: "⚡ Общие параметры", callback_data: "common" }],
        [{ text: "⬅️ Назад", callback_data: "back_main" }],
      ]
    }
  };
  bot.sendMessage(id, text, markup);
}

function renderDivModeMenu(id, msgId, u) {
    const current = String(u.div.mode || "soft").toLowerCase();
    const kb = [
        [{ text: `${current === 'soft' ? '✅ ' : ''}🪶 Soft (RSI)`, callback_data: "set_div_mode_soft" }],
        [{ text: `${current === 'strict' ? '✅ ' : ''}🧩 Strict (MACD)`, callback_data: "set_div_mode_strict" }],
        [{ text: "⬅️ Назад", callback_data: "div" }]
    ];
    bot.editMessageText("🎯 Выберите режим анализа Дивергенции:", {
        chat_id: id, message_id: msgId, reply_markup: { inline_keyboard: kb }
    });
}

bot.on("callback_query", async (q) => {
  try {
    const id = q.message.chat.id;
    let u = await ensureUser(id);
    const data = q.data || "";

    if (data === "back_main") {
      await safeDeleteMessage(id, q.message.message_id);
      return bot.sendMessage(id, "🏠 Главное меню", mainMenu);
    }
    if (data === "modules")   return renderModules(id, q.message.message_id, u);
    if (data === "exchanges") return renderExchanges(id, q.message.message_id, u);
    if (["sp","pd","div","common"].includes(data)) return renderSettings(id, q.message.message_id, data, u);

    // --- DIV MODES ---
    if (data === "div_mode_menu") return renderDivModeMenu(id, q.message.message_id, u);
    if (data.startsWith("set_div_mode_")) {
        const mode = data.replace("set_div_mode_", "");
        u.div.mode = mode;
        saveUser(id, u);
        bot.answerCallbackQuery(q.id, { text: `✅ Режим: ${mode.toUpperCase()}` });
        return renderSettings(id, q.message.message_id, 'div', u); 
    }

    // --- SMART PUMP TOGGLES (Для SP 2.0) ---
    if (data === "toggle_sp_cvd") {
        u.sp.strictCvd = !u.sp.strictCvd;
        saveUser(id, u);
        bot.answerCallbackQuery(q.id, { text: `CVD фильтр: ${u.sp.strictCvd ? 'ВКЛ' : 'ВЫКЛ'}` });
        return renderSettings(id, q.message.message_id, 'sp', u);
    }

    if (data.startsWith("toggle_mod_")) {
      const k = data.replace("toggle_mod_", "");
      const i = u.modules.indexOf(k);
      if (i > -1) u.modules.splice(i, 1); else u.modules.push(k);
      saveUser(id, u);
      bot.answerCallbackQuery(q.id, { text: "✅ Модули обновлены" });
      return renderModules(id, q.message.message_id, u);
    }

    if (data.startsWith("toggle_ex_")) {
      const k = data.replace("toggle_ex_", "");
      const i = u.exchanges.indexOf(k);
      if (i > -1) u.exchanges.splice(i, 1); else u.exchanges.push(k);
      saveUser(id, u);
      bot.answerCallbackQuery(q.id, { text: "✅ Биржи обновлены" });
      return renderExchanges(id, q.message.message_id, u);
    }

    if (data.startsWith("tf_")) {
      const [, mod, tf] = data.split("_");
      if (["sp","pd","div"].includes(mod) && ["5m","15m","1h","4h"].includes(tf)) {
        u.perModuleTF[mod] = tf;
        saveUser(id, u);
        bot.answerCallbackQuery(q.id, { text: `✅ TF: ${tf}` });
        return renderSettings(id, q.message.message_id, mod, u);
    }
    }

    if (data.startsWith("edit_")) {
      const field = data.replace("edit_", ""); 
      const promptMsg = await bot.sendMessage(id, `💬 Введите число для "${field}":`);
      waitingInput.set(id, { field, promptId: promptMsg.message_id });
      return;
    }
  } catch (e) {
    console.error("[BOT CB ERROR]", e.message);
  }
});

function renderModules(id, msgId, u) {
  const btn = (k) => {
    const name = MODULE_NAMES[k] || k;
    const on = u.modules.includes(k);
    return { text: `${on ? "✅" : "❌"} ${name}`, callback_data: `toggle_mod_${k}` };
  };
  const kb = [
    [btn("sp")], [btn("pd")], [btn("div")],
    [{ text: "⬅️ Назад", callback_data: "back_main" }]
  ];
  bot.editMessageText("🧩 Выберите активные модули:", {
    chat_id: id, message_id: msgId, reply_markup: { inline_keyboard: kb }
  });
}

function renderExchanges(id, msgId, u) {
  const btn = (k) => {
    const name = k.charAt(0).toUpperCase() + k.slice(1);
    const on = u.exchanges.includes(k);
    return { text: `${on ? "✅" : "❌"} ${name}`, callback_data: `toggle_ex_${k}` };
  };
  const kb = [
    [btn("binance")], [btn("bybit")],
    [{ text: "⬅️ Назад", callback_data: "back_main" }]
  ];
  bot.editMessageText("💰 Выберите активные биржи:", {
    chat_id: id, message_id: msgId, reply_markup: { inline_keyboard: kb }
  });
}

function renderSettings(id, msgId, mod, u) {
  const modNames = { sp:"🧠 Smart Pump", pd:"📈 PumpDump", div:"🎯 Divergence", common:"⚡ Общие параметры" };
  const tfButtons = (modKey) => {
    const cur = u.perModuleTF[modKey];
    const mk = (tf) => ({ text: tf === cur ? `${tf} ✅` : tf, callback_data: `tf_${modKey}_${tf}` });
    return [[mk("5m"), mk("15m"), mk("1h"), mk("4h")]];
  };

  let inline = [];
  if (mod === "sp") {
    const cvdStatus = u.sp.strictCvd ? "✅ Вкл" : "❌ Выкл";
    inline = [
      // === SMART PUMP 2.0 КНОПКИ ===
      [{ text: `🔋 Мин. рост OI (%): ${u.sp.oiPlusPct}`, callback_data: "edit_sp.oiPlusPct" }],
      [{ text: `📉 Мин. изм. цены (%): ${u.sp.minPricePct}`, callback_data: "edit_sp.minPricePct" }],
      [{ text: `📈 Макс. изм. цены (%): ${u.sp.maxPricePct}`, callback_data: "edit_sp.maxPricePct" }],
      [{ text: `📊 Мин. объём (x): ${u.sp.minVolX}`, callback_data: "edit_sp.minVolX" }],
      [{ text: `💎 Фильтр по CVD: ${cvdStatus}`, callback_data: "toggle_sp_cvd" }],
      // =============================

      [{ text: `⏱️ Таймфрейм: ${u.perModuleTF.sp}`, callback_data: "noop" }],
      ...tfButtons("sp")
    ];
  } else if (mod === "pd") {
    inline = [
      [{ text: `📈 Мин. OI (%): ${u.pd.oiPct}`,            callback_data: "edit_pd.oiPct" }],
      [{ text: `💰 Мин. CVD ($): ${u.pd.cvdUsdMin}`,       callback_data: "edit_pd.cvdUsdMin" }],
      [{ text: `🕯️ Мин. тело свечи (%): ${u.pd.minBodyPct}`, callback_data: "edit_pd.minBodyPct" }],
      [{ text: `📊 Мин. объём ×: ${u.pd.minVolX}`,         callback_data: "edit_pd.minVolX" }],
      [{ text: `⏱️ Таймфрейм: ${u.perModuleTF.pd}`,        callback_data: "noop" }],
      ...tfButtons("pd")
    ];
  } else if (mod === "div") {
    const currentMode = String(u.div.mode || "soft").toLowerCase() === "strict";
    inline = [
      [{ text: `Режим: ${currentMode ? "🧩 Strict (MACD)" : "🪶 Soft (RSI)"}`, callback_data: "div_mode_menu" }], 
      [{ text: `RSI Период: ${u.div.rsiPeriod}`,           callback_data: "edit_div.rsiPeriod" }],
      [{ text: `RSI Мин. разница: ${u.div.rsiMinDiff}`,    callback_data: "edit_div.rsiMinDiff" }],
      [{ text: `RSI Перекупленность: ${u.div.rsiOverbought}`, callback_data: "edit_div.rsiOverbought" }],
      [{ text: `RSI Перепроданность: ${u.div.rsiOversold}`,   callback_data: "edit_div.rsiOversold" }],
      
      // === ИСПРАВЛЕНО: 3 КНОПКИ ДЛЯ MACD ===
      [{ text: `🔹 MACD Fast: ${u.div.macdFast}`,     callback_data: "edit_div.macdFast" }],
      [{ text: `🔹 MACD Slow: ${u.div.macdSlow}`,     callback_data: "edit_div.macdSlow" }],
      [{ text: `🔹 MACD Signal: ${u.div.macdSignal}`, callback_data: "edit_div.macdSignal" }],
      // =====================================

      [{ text: `⏱️ Таймфрейм: ${u.perModuleTF.div}`,       callback_data: "noop" }],
      ...tfButtons("div")
    ];
  } else if (mod === "common") {
    inline = [
      [{ text: `💰 Мин. объём ($): ${u.minVolumeUsd}`, callback_data: "edit_common.minVolumeUsd" }],
    ];
  }

  inline.push([{ text: "⬅️ Назад", callback_data: "back_main" }]);

  bot.editMessageText(`${modNames[mod]} — настройки:`, {
    chat_id: id, message_id: msgId,
    reply_markup: { inline_keyboard: inline }
  });
}

async function safeDeleteMessage(id, mid) {
  try { await bot.deleteMessage(id, mid); } catch {}
}

// ===== 10. Кеш символов и Подписки =====
const symbolCache = new Map();
const CACHE_SYMBOLS_TTL_MS = 30 * 60 * 1000;

async function getCachedActiveSymbols(ex, minVolumeUsd) {
  const cache = symbolCache.get(ex);
  if (cache && (Date.now() - cache.ts < CACHE_SYMBOLS_TTL_MS)) return cache.symbols;
  const api = ex === "binance" ? binanceApi : bybitApi;
  try {
    const syms = await api.getActiveSymbols(minVolumeUsd);
    symbolCache.set(ex, { symbols: syms, ts: Date.now() });
    return syms;
  } catch (e) {
    console.warn(`[CACHE SYMBOLS] ${ex.toUpperCase()} symbols failed: ${e.message}`);
    return cache?.symbols || [];
  }
}

async function subscribeUserUniverse(chatId, u) {
  const tfs = new Set(u.modules.map(m => u.perModuleTF[m]));
  const tfList = [...tfs];
  for (const ex of u.exchanges) {
    const symsAll = await getCachedActiveSymbols(ex, u.minVolumeUsd || 5_000_000);
    if (!symsAll || symsAll.length === 0) {
      console.warn(`[SUB] ${ex.toUpperCase()} no symbols found`);
      continue;
    }
    console.log(`[SUB] ${ex.toUpperCase()} queuing ${symsAll.length} symbols on TF: ${tfList.join(", ")}`);
    
    const api = ex === "binance" ? binanceApi : bybitApi; 
    const indicatorsModule = await import("./modules/indicators.js"); 
    
    await ensureDbConnection(); 

    for (const sym of symsAll) {
      for (const tf of tfList) {
        const key = `${ex}:${sym}:${tf}`.toUpperCase();

        const history = await loadKlineHistory(key);

        if (history && history.length > 0) {
            indicatorsModule.klineHistory.set(key, history);
        } else {
            try {
              const klines = await api.getKlines(sym, tf, 200); 
              if (klines && klines.length > 0) {
                  const normKlines = klines.map(k => [Number(k[0]), Number(k[1]), Number(k[2]), Number(k[3]), Number(k[4]), Number(k[5]), true]);
                  indicatorsModule.klineHistory.set(key, normKlines);
                  await saveKlineHistory(key, normKlines);
              }
            } catch (e) {
               console.warn(`[HIST] Failed to fetch klines for ${sym}:${tf} via REST: ${e.message}`);
            }
        }
        
        manageSubscription(ex, "kline", sym, tf, chatId, true);
      }
    }
  }
}

// ===== 11. Web Server (Render Uptime) =====
const PORT = process.env.PORT || 3000;
const app = express();
app.get("/", (_req, res) => res.send("Bot is alive and polling!"));
app.listen(PORT, () => console.log(`[RENDER] Web-server running on port ${PORT}`));

// ===== 12. Graceful Shutdown =====
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    try { await bot.stopPolling(); } catch {}
    try { fs.existsSync(LOCK_FILE) && fs.unlinkSync(LOCK_FILE); } catch {}
    process.exit(0);
  });
}
