// modules/userManager.js (Нова версія з MongoDB + Kline History Persistence)
import { MongoClient } from "mongodb";

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("❌ MONGO_URI missing from .env file");
  process.exit(1);
}

const client = new MongoClient(MONGO_URI);
let db;

// Підключаємось один раз при старті
async function connectToDb() {
  try {
    await client.connect();
    db = client.db("komar_bot_db"); 
    console.log("✅ Connected to MongoDB");
    await db.collection("users").createIndex({ userId: 1 }, { unique: true });
    // +++ ІНДЕКС ДЛЯ KLINE HISTORY +++
    // Створюємо індекс для швидкого пошуку свічок за ключем (EX:SYMBOL:TF)
    await db.collection("kline_history").createIndex({ key: 1 }, { unique: true }); 
    // +++ КІНЕЦЬ ІНДЕКСУ +++
  } catch (e) {
    console.error("❌ MongoDB connection failed:", e.message);
    process.exit(1);
  }
}

connectToDb();

// Завантажує користувача ІЛІ створює його
export async function loadUserSettings(userId, defaults = {}) {
  try {
    const users = db.collection("users");
    const user = await users.findOne({ userId: String(userId) });
    if (user) {
      return user.settings; 
    }
    const newSettings = { ...defaults, authorized: false }; 
    await users.insertOne({ 
      userId: String(userId), 
      settings: newSettings 
    });
    return newSettings;
  } catch (e) {
    console.warn(`[MongoDB] Error loading user ${userId}: ${e.message}`);
    return { ...defaults }; 
  }
}

// Зберігає користувача
export async function saveUserSettings(userId, data) {
  try {
    const users = db.collection("users");
    await users.updateOne(
      { userId: String(userId) },
      { $set: { settings: data } },
      { upsert: true }
    );
  } catch (e) {
    console.warn(`[MongoDB] Error saving user ${userId}: ${e.message}`);
  }
}

// +++ НОВА ФУНКЦІЯ: ЗБЕРЕЖЕННЯ ІСТОРІЇ СВІЧОК +++
// history: [ [t, o, h, l, c, v, is_final], ... ]
export async function saveKlineHistory(key, history) {
    if (!db) return;
    try {
        await db.collection("kline_history").updateOne(
            { key: key }, // Ключ: EX:SYMBOL:TF (напр., BINANCE:BTCUSDT:5m)
            { $set: { history: history, ts: Date.now() } },
            { upsert: true }
        );
    } catch (e) {
        console.warn(`[MongoDB] Error saving kline history ${key}: ${e.message}`);
    }
}

// +++ НОВА ФУНКЦІЯ: ЗАВАНТАЖЕННЯ ІСТОРІЇ СВІЧОК +++
export async function loadKlineHistory(key) {
    if (!db) return null;
    try {
        const doc = await db.collection("kline_history").findOne({ key: key });
        // Повертаємо історію, якщо вона не старша за 2 дні 
        if (doc && (Date.now() - doc.ts) < 2 * 24 * 3600 * 1000) {
             return doc.history;
        }
        return null;
    } catch (e) {
        console.warn(`[MongoDB] Error loading kline history ${key}: ${e.message}`);
        return null;
    }
}
// ЦІ ФУНКЦІЇ БІЛЬШЕ НЕ ПОТРІБНІ, АЛЕ МИ ЇХ ЗАЛИШИМО
export function ensureUserDir() { /* no-op */ }
export function userFilePath(userId) { /* no-op */ }
export function listUsers() {
  console.warn("listUsers() is not fully supported in MongoDB mode yet.");
  return [];
}
