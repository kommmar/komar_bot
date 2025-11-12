// modules/userManager.js (Новая версия с MongoDB)
import { MongoClient } from "mongodb";

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("❌ MONGO_URI missing from .env file");
  process.exit(1);
}

const client = new MongoClient(MONGO_URI);
let db;

// Подключаемся один раз при старте
async function connectToDb() {
  try {
    await client.connect();
    // Вы можете назвать базу как угодно. komarbot.bxegrwv.mongodb.net - это хост,
    // а komar_bot_db - это имя самой Базы Данных внутри
    db = client.db("komar_bot_db"); 
    console.log("✅ Connected to MongoDB");
    // Создаем индекс для быстрого поиска
    await db.collection("users").createIndex({ userId: 1 }, { unique: true });
  } catch (e) {
    console.error("❌ MongoDB connection failed:", e.message);
    process.exit(1);
  }
}

// Запускаем подключение
connectToDb();

// Загружает пользователя ИЛИ создает его, если его нет
export async function loadUserSettings(userId, defaults = {}) {
  try {
    const users = db.collection("users");
    
    // 1. Пытаемся найти пользователя
    const user = await users.findOne({ userId: String(userId) });

    if (user) {
      return user.settings; // Нашли - возвращаем
    }

    // 2. Не нашли - создаем нового
    // Сбрасываем 'authorized' для безопасности при первом создании
    const newSettings = { ...defaults, authorized: false }; 
    await users.insertOne({ 
      userId: String(userId), 
      settings: newSettings 
    });
    
    return newSettings;

  } catch (e) {
    console.warn(`[MongoDB] Error loading user ${userId}: ${e.message}`);
    return { ...defaults }; // В случае ошибки, возвращаем дефолт
  }
}

// Сохраняет пользователя
export async function saveUserSettings(userId, data) {
  try {
    const users = db.collection("users");
    
    // $set - обновит только поля,
    // upsert: true - создаст, если не найдет
    await users.updateOne(
      { userId: String(userId) },
      { $set: { settings: data } },
      { upsert: true }
    );

  } catch (e) {
    console.warn(`[MongoDB] Error saving user ${userId}: ${e.message}`);
  }
}

// Эти функции нам больше не нужны, но мы можем их оставить как заглушки
export function ensureUserDir() { /* no-op */ }
export function userFilePath(userId) { /* no-op */ }

// Эта функция теперь тоже сложнее, пока сделаем заглушку
export function listUsers() {
  console.warn("listUsers() is not fully supported in MongoDB mode yet.");
  return [];
}