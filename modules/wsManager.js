// modules/wsManager.js — ИСПРАВЛЕН "ПИНГ", ВЫЗЫВАВШИЙ ОТКЛЮЧЕНИЕ
import WebSocket from "ws";

const BINANCE_WSS = "wss://fstream.binance.com/ws"; 
const BYBIT_WSS   = "wss://stream.bybit.com/v5/public/linear";

const SUB_BATCH_SIZE = 5; // "Вежливые" настройки
const SUB_BATCH_DELAY_MS = 500; // "Вежливые" настройки

export const subscriptions = new Map(); 
const sockets = {
  binance: new Map(),
  bybit:   new Map(),
};

export function tfToMinutes(tf) {
  const s = String(tf).toLowerCase();
  if (s.includes("5"))  return 5;
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
  console.log("[WS] manager ready");
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// ===== Binance WS (с "дроблением" подписок) =====
async function subscribeBinanceInBatches(holder, binTf) {
  const allTopics = [...holder.topics].map(sym => `${sym.toLowerCase()}@kline_${binTf}`);
  const topicChunks = chunkArray(allTopics, SUB_BATCH_SIZE);
  
  console.log(`[WS] Binance ${binTf} subscribing to ${allTopics.length} topics in ${topicChunks.length} batches...`);
  
  for (let i = 0; i < topicChunks.length; i++) {
    const chunk = topicChunks[i];
    const subMsg = { method: "SUBSCRIBE", params: chunk, id: Date.now() };
    try {
      if (holder.ready && holder.ws.readyState === WebSocket.OPEN) {
        holder.ws.send(JSON.stringify(subMsg));
      } else {
         console.warn(`[WS] Binance ${binTf} connection lost during batch subscription.`);
         break;
      }
    } catch (e) {
      console.warn(`[WS] Binance ${binTf} batch subscribe error:`, e.message);
    }
    if (i < topicChunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, SUB_BATCH_DELAY_MS));
    }
  }
  console.log(`[WS] Binance ${binTf} batch subscription finished.`);
}

function openBinance(tf) {
  const holder = ensureSocketHolder("binance", tf);
  if (holder.ws) return holder; 
  
  const binTf = tfToBinance(tf);
  
  holder.ws = new WebSocket(BINANCE_WSS);
  holder.ready = false;

  holder.ws.on("open", () => {
    holder.ready = true;
    holder.lastMsgTs = Date.now();
    console.log(`[WS] Connected: binance:${binTf}. Topics: ${holder.topics.size}.`);
    subscribeBinanceInBatches(holder, binTf);
  });

  holder.ws.on("message", (raw) => {
    holder.lastMsgTs = Date.now(); // Cброс таймера при любом сообщении
    try {
      const data = JSON.parse(raw.toString());
      if (data.result === null) return; // Игнор ответа на подписку
      // if (data.pong) return; // data.pong здесь не будет

      const d = data;
      const e = d?.e;
      const k = d?.k;
      if (e === "kline" && k && k.x) {
        const symbol = String(k.s || "").toUpperCase();
        const tfStr  = binTf;
        const kline = [Number(k.t), Number(k.o), Number(k.h), Number(k.l), Number(k.c), Number(k.v), true];
        import("./scannerEngine.js").then(m => { if (m.handleKlineUpdate) m.handleKlineUpdate("binance", symbol, tfStr, kline); }).catch(()=>{});
      }
    } catch {}
  });

  holder.ws.on("error", (err) => console.warn(`[WS] Binance error ${binTf}:`, err.message));

  holder.ws.on("close", () => {
    holder.ready = false;
    safeClose(holder); 
    console.warn(`[WS] Binance closed ${binTf}. Reconnecting in 3s...`);
    setTimeout(() => openBinance(tf), 3000);
  });

  if (holder.pingTimer) clearInterval(holder.pingTimer);
  holder.pingTimer = setInterval(() => {
    const idle = Date.now() - holder.lastMsgTs;
    
    // +++ ОШИБОЧНЫЙ ПИНГ УДАЛЕН +++
    // try {
    //     if (holder.ready && holder.ws.readyState === WebSocket.OPEN) {
    //         holder.ws.send(JSON.stringify({ method: "PING", id: Date.now() }));
    //     }
    // } catch {}
    // +++ КОНЕЦ ИЗМЕНЕНИЯ +++

    // Оставляем ТОЛЬКО "сторожевой" таймер
    if (idle > 180000) { // 3 минуты
      console.warn(`[WS WATCHDOG] No data from binance:${binTf} > 180s. Reconnecting.`);
      try { holder.ws?.terminate(); } catch {}
    }
  }, 20000); // Проверка каждые 20с

  return holder;
}

// ===== Bybit WS (без изменений, он работал) =====
async function subscribeBybitInBatches(holder, bybitTf) {
  const allTopics = [...holder.topics].map(sym => `kline.${bybitTf}.${sym}`);
  const topicChunks = chunkArray(allTopics, SUB_BATCH_SIZE);
  
  console.log(`[WS] Bybit ${bybitTf} subscribing to ${allTopics.length} topics in ${topicChunks.length} batches...`);
  
  for (let i = 0; i < topicChunks.length; i++) {
    const chunk = topicChunks[i];
    const subMsg = { op: "subscribe", args: chunk };
    try {
      if (holder.ready && holder.ws.readyState === WebSocket.OPEN) {
        holder.ws.send(JSON.stringify(subMsg));
      } else {
         console.warn(`[WS] Bybit ${bybitTf} connection lost during batch subscription.`);
         break;
      }
    } catch (e) {
      console.warn(`[WS] Bybit ${bybitTf} batch subscribe error:`, e.message);
    }
    if (i < topicChunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, SUB_BATCH_DELAY_MS));
    }
  }
  console.log(`[WS] Bybit ${bybitTf} batch subscription finished.`);
}

function openBybit(tf) {
  const holder = ensureSocketHolder("bybit", tf);
  if (holder.ws) return holder; 

  const bybitTf = tfToBybit(tf);

  holder.ws = new WebSocket(BYBIT_WSS);
  holder.ready = false;

  holder.ws.on("open", () => {
    holder.ready = true;
    holder.lastMsgTs = Date.now();
    console.log(`[WS] Connected: bybit:${tf}. Topics: ${holder.topics.size}.`);
    subscribeBybitInBatches(holder, bybitTf);
  });

  holder.ws.on("message", (raw) => {
    holder.lastMsgTs = Date.now();
    try {
      const msg = JSON.parse(raw.toString());
      const topic = msg?.topic || "";
      if (!topic.startsWith("kline.")) return;
      const parts = topic.split(".");
      const tfNum = parts[1];
      const symbol = parts[2];
      const arr = msg?.data || [];
      for (const it of arr) {
        if (it.confirm === true) {
          const kline = [Number(it.start), Number(it.open), Number(it.high), Number(it.low), Number(it.close), Number(it.volume), true];
          import("./scannerEngine.js").then(m => { if (m.handleKlineUpdate) m.handleKlineUpdate("bybit", symbol, tfNum, kline); }).catch(()=>{});
        }
      }
    } catch {}
  });

  holder.ws.on("error", (err) => console.warn(`[WS] Bybit error ${tf}:`, err.message));

  holder.ws.on("close", () => {
    holder.ready = false;
    safeClose(holder); 
    console.warn(`[WS] Bybit closed ${tf}. Reconnecting in 3s...`);
    setTimeout(() => openBybit(tf), 3000);
  });

  if (holder.pingTimer) clearInterval(holder.pingTimer);
  holder.pingTimer = setInterval(() => {
    const idle = Date.now() - holder.lastMsgTs;
    // Для Bybit автоматического пинга/понга от 'ws' достаточно
    if (idle > 180000) {
      console.warn(`[WS WATCHDOG] No data from bybit:${tf} > 180s. Reconnecting.`);
      try { holder.ws?.terminate(); } catch {}
    }
  }, 20000);

  return holder;
}

// (Остальной код файла без изменений)
function subscribeTopic(ex, tf, sym) {
  const holder = ensureSocketHolder(ex, tf);

  const upperSym = sym.toUpperCase();
  if (holder.topics.has(upperSym)) return; 
  holder.topics.add(upperSym);

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
  const upperSym = sym.toUpperCase();
  if (!holder.topics.has(upperSym)) return; 
  holder.topics.delete(upperSym);

  if (holder.ready) {
     if (ex === "binance") {
        const binTf = tfToBinance(tf);
        const unsubMsg = { method: "UNSUBSCRIBE", params: [`${sym.toLowerCase()}@kline_${binTf}`], id: Date.now() };
        try { holder.ws.send(JSON.stringify(unsubMsg)); } catch {}
    } else {
      const unsub = { op: "unsubscribe", args: [`kline.${tfToBybit(tf)}.${sym.toUpperCase()}`] };
      try { holder.ws.send(JSON.stringify(unsub)); } catch {}
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

export async function manageSubscription(ex, stream, symbol, tf, chatId, enable) {
  const key = keyFor(ex, stream, symbol, tf);
  let obj = subscriptions.get(key);
  
  if (enable) {
    if (!obj) {
      obj = { users: new Set(), count: 0 };
      subscriptions.set(key, obj);
    }
    
    const isFirstUserForTf = !sockets[ex].has(tf) || !sockets[ex].get(tf).ws;
    if(isFirstUserForTf){
        if(ex === "binance") openBinance(tf);
        else openBybit(tf);
    }

    obj.users.add(chatId);
    obj.count++;
    subscribeTopic(ex, tf, symbol); 
  } else {
    if (!obj) return; 
    obj.users.delete(chatId);
    if (obj.count > 0) obj.count--;
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