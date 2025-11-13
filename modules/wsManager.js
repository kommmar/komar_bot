// wsManager.js — версия с прокси (для Украины и Render)
import WebSocket from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";

const PROXY_URL = process.env.PROXY_URL || "";
const proxyAgent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : null;

const BINANCE_WSS = "wss://fstream.binance.com/ws";
const BYBIT_WSS   = "wss://stream.bybit.com/v5/public/linear";

const SUB_BATCH_SIZE = 5;
const SUB_BATCH_DELAY_MS = 500;

export const subscriptions = new Map();
const sockets = { binance: new Map(), bybit: new Map() };

export function tfToMinutes(tf) {
  const s = String(tf).toLowerCase();
  if (s.includes("5")) return 5;
  if (s.includes("15")) return 15;
  if (s.includes("1h") || s === "60") return 60;
  if (s.includes("4h") || s === "240") return 240;
  return 5;
}
function tfToBinance(tf) { const m = tfToMinutes(tf); return m === 60 ? "1h" : m === 240 ? "4h" : `${m}m`; }
function tfToBybit(tf)   { const m = tfToMinutes(tf); return m.toString(); }

function keyFor(ex, stream, sym, tf) {
  return `${ex}:${String(stream).toUpperCase()}:${sym.toUpperCase()}:${tf.toLowerCase()}`;
}
function ensureSocketHolder(ex, tf) {
  const map = sockets[ex];
  if (!map.has(tf)) map.set(tf, { ws: null, topics: new Set(), lastMsgTs: 0, pingTimer: null, ready: false });
  return map.get(tf);
}

export function startWsConnections() {
  console.log("[WS] manager ready (with proxy if set)");
  // +++ ДОБАВЛЕННЫЙ ЛОГ ДЛЯ ПРОВЕРКИ ПРОКСИ +++
  if (PROXY_URL) {
      // Логируем только IP/домен, чтобы не раскрывать пароль
      const proxyAddr = PROXY_URL.split('@').pop().split(':')[0]; 
      console.log(`[WS PROXY] Using proxy for WS: ${proxyAddr}`);
  }
  // +++ КОНЕЦ ДОБАВЛЕННОГО ЛОГА +++
}

// ===== Binance =====
function openBinance(tf) {
  const holder = ensureSocketHolder("binance", tf);
  if (holder.ws) return holder;
  const binTf = tfToBinance(tf);

  holder.ws = new WebSocket(BINANCE_WSS, { agent: proxyAgent || undefined });
  holder.ready = false;

  holder.ws.on("open", () => {
    holder.ready = true;
    holder.lastMsgTs = Date.now();
    console.log(`[WS] Connected: binance:${binTf}`);
    subscribeBinance(holder, binTf);
  });

  holder.ws.on("message", raw => {
    holder.lastMsgTs = Date.now();
    try {
      const d = JSON.parse(raw.toString());
      const k = d?.k;
      if (d.e === "kline" && k?.x) {
        const kline = [Number(k.t), Number(k.o), Number(k.h), Number(k.l), Number(k.c), Number(k.v), true];
        import("./scannerEngine.js")
          .then(m => m.handleKlineUpdate?.("binance", k.s, binTf, kline))
          .catch(()=>{});
      }
    } catch {}
  });

  holder.ws.on("error", e => console.warn(`[WS] Binance error ${tf}:`, e.message));
  holder.ws.on("close", () => {
    holder.ready = false;
    safeClose(holder);
    console.warn(`[WS] Binance closed ${tf}. Reconnecting in 3s...`);
    setTimeout(() => openBinance(tf), 3000);
  });

  holder.pingTimer = setInterval(() => {
    const idle = Date.now() - holder.lastMsgTs;
    if (idle > 180000) {
      console.warn(`[WS WATCHDOG] Binance ${tf} idle >180s, reconnecting`);
      try { holder.ws?.terminate(); } catch {}
    }
  }, 20000);

  return holder;
}

async function subscribeBinance(holder, binTf) {
  const allTopics = [...holder.topics].map(sym => `${sym.toLowerCase()}@kline_${binTf}`);
  const chunks = [];
  for (let i = 0; i < allTopics.length; i += SUB_BATCH_SIZE)
    chunks.push(allTopics.slice(i, i + SUB_BATCH_SIZE));
  for (const chunk of chunks) {
    const msg = { method: "SUBSCRIBE", params: chunk, id: Date.now() };
    try { holder.ws.send(JSON.stringify(msg)); } catch {}
    await new Promise(r => setTimeout(r, SUB_BATCH_DELAY_MS));
  }
}

// ===== Bybit =====
function openBybit(tf) {
  const holder = ensureSocketHolder("bybit", tf);
  if (holder.ws) return holder;
  const bybitTf = tfToBybit(tf);

  holder.ws = new WebSocket(BYBIT_WSS, { agent: proxyAgent || undefined });
  holder.ready = false;

  holder.ws.on("open", () => {
    holder.ready = true;
    holder.lastMsgTs = Date.now();
    console.log(`[WS] Connected: bybit:${tf}`);
    subscribeBybit(holder, bybitTf);
  });

  holder.ws.on("message", raw => {
    holder.lastMsgTs = Date.now();
    try {
      const msg = JSON.parse(raw.toString());
      if (!msg?.topic?.startsWith("kline.")) return;
      const parts = msg.topic.split(".");
      const tfNum = parts[1];
      const symbol = parts[2];
      for (const it of msg.data || []) {
        if (it.confirm) {
          const kline = [Number(it.start), Number(it.open), Number(it.high), Number(it.low), Number(it.close), Number(it.volume), true];
          import("./scannerEngine.js")
            .then(m => m.handleKlineUpdate?.("bybit", symbol, tfNum, kline))
            .catch(()=>{});
        }
      }
    } catch {}
  });

  holder.ws.on("error", e => console.warn(`[WS] Bybit error ${tf}:`, e.message));
  holder.ws.on("close", () => {
    holder.ready = false;
    safeClose(holder);
    console.warn(`[WS] Bybit closed ${tf}. Reconnecting in 3s...`);
    setTimeout(() => openBybit(tf), 3000);
  });

  holder.pingTimer = setInterval(() => {
    const idle = Date.now() - holder.lastMsgTs;
    if (idle > 180000) {
      console.warn(`[WS WATCHDOG] Bybit ${tf} idle >180s, reconnecting`);
      try { holder.ws?.terminate(); } catch {}
    }
  }, 20000);

  return holder;
}

async function subscribeBybit(holder, tf) {
  const all = [...holder.topics].map(sym => `kline.${tf}.${sym}`);
  const chunks = [];
  for (let i = 0; i < all.length; i += SUB_BATCH_SIZE)
    chunks.push(all.slice(i, i + SUB_BATCH_SIZE));
  for (const chunk of chunks) {
    const msg = { op: "subscribe", args: chunk };
    try { holder.ws.send(JSON.stringify(msg)); } catch {}
    await new Promise(r => setTimeout(r, SUB_BATCH_DELAY_MS));
  }
}

// ===== Управление подписками =====
function subscribeTopic(ex, tf, sym) {
  const holder = ensureSocketHolder(ex, tf);
  const s = sym.toUpperCase();
  if (holder.topics.has(s)) return;
  holder.topics.add(s);

  if (holder.ready) {
    if (ex === "binance") {
      const binTf = tfToBinance(tf);
      const subMsg = { method: "SUBSCRIBE", params: [`${sym.toLowerCase()}@kline_${binTf}`], id: Date.now() };
      try { holder.ws.send(JSON.stringify(subMsg)); } catch {}
    } else {
      const sub = { op: "subscribe", args: [`kline.${tfToBybit(tf)}.${sym.toUpperCase()}`] };
      try { holder.ws.send(JSON.stringify(sub)); } catch {}
    }
  }
}

function unsubscribeTopic(ex, tf, sym) {
  const holder = ensureSocketHolder(ex, tf);
  const s = sym.toUpperCase();
  if (!holder.topics.has(s)) return;
  holder.topics.delete(s);

  if (holder.ready) {
    if (ex === "binance") {
      const binTf = tfToBinance(tf);
      const msg = { method: "UNSUBSCRIBE", params: [`${sym.toLowerCase()}@kline_${binTf}`], id: Date.now() };
      try { holder.ws.send(JSON.stringify(msg)); } catch {}
    } else {
      const msg = { op: "unsubscribe", args: [`kline.${tfToBybit(tf)}.${sym.toUpperCase()}`] };
      try { holder.ws.send(JSON.stringify(msg)); } catch {}
    }
  }
}

function safeClose(holder) {
  try { if (holder.pingTimer) clearInterval(holder.pingTimer); } catch {}
  try { holder.ws?.close(); } catch {}
  holder.pingTimer = null;
  holder.ws = null;
  holder.ready = false;
}

// ===== Основная логика управления =====
export async function manageSubscription(ex, stream, symbol, tf, chatId, enable) {
  const key = keyFor(ex, stream, symbol, tf);
  let obj = subscriptions.get(key);

  if (enable) {
    if (!obj) {
      obj = { users: new Set(), count: 0 };
      subscriptions.set(key, obj);
    }

    const needSocket = !sockets[ex].has(tf) || !sockets[ex].get(tf).ws;
    if (needSocket) ex === "binance" ? openBinance(tf) : openBybit(tf);

    obj.users.add(chatId);
    obj.count++;
    subscribeTopic(ex, tf, symbol);
  } else {
    if (!obj) return;
    obj.users.delete(chatId);
    obj.count = Math.max(0, obj.count - 1);
    if (obj.count === 0) {
      unsubscribeTopic(ex, tf, symbol);
      subscriptions.delete(key);
    }
  }
}

export async function unsubscribeAllForUser(chatId) {
  for (const [key, sub] of subscriptions.entries()) {
    if (sub.users.has(chatId)) {
      const [ex, stream, sym, tf] = key.split(":");
      await manageSubscription(ex.toLowerCase(), stream.toLowerCase(), sym, tf, chatId, false);
    }
  }
}
