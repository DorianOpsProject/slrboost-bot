import TelegramBot from "node-telegram-bot-api";
import fs from "fs";

const TOKEN = process.env.BOT_TOKEN;
const BACKOFFICE_CHAT_ID = process.env.BACKOFFICE_CHAT_ID;

if (!TOKEN) throw new Error("Missing BOT_TOKEN env var");
if (!BACKOFFICE_CHAT_ID) throw new Error("Missing BACKOFFICE_CHAT_ID env var");

const bot = new TelegramBot(TOKEN, { polling: true });

// --- stockage ultra simple ---
const DB_FILE = "./orders.json";
function loadDB() {
  if (!fs.existsSync(DB_FILE)) return { counter: 0, orders: [] };
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
}
function nextOrderNumber() {
  const db = loadDB();
  db.counter += 1;
  saveDB(db);
  const year = new Date().getFullYear();
  const n = String(db.counter).padStart(4, "0");
  return `SLR-${year}-${n}`;
}

// --- états de conversation en mémoire ---
const state = new Map(); // userId -> { step, data }

function startOrder(chatId, userId) {
  state.set(userId, { step: "service", data: {} });
  bot.sendMessage(chatId, "📦 *Nouvelle commande SLR BOOST*\n\n🛠 Quel service souhaites-tu commander ?", {
    parse_mode: "Markdown",
    reply_markup: {
      keyboard: [[{ text: "❌ Annuler" }]],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  });
}

bot.onText(/^\/start(?:\s+(.+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const text =
    "👋 *Bienvenue chez SLR BOOST*\n\n" +
    "Tu peux commander en 30 secondes.\n" +
    "Clique ci-dessous :";
  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📦 Passer commande", callback_data: "ORDER_START" }],
        [{ text: "🛒 Ouvrir le Shop", url: process.env.SHOP_URL || "https://example.com" }]
      ]
    }
  });

  // Si tu passes un start param depuis la mini-app: ?start=order_Service_399
  const payload = match?.[1];
  if (payload && payload.startsWith("order_")) {
    const parts = payload.split("_"); // ["order", "Service", "399"]
    const service = decodeURIComponent(parts[1] || "");
    const price = decodeURIComponent(parts[2] || "");
    state.set(userId, { step: "amount", data: { service, amount: price } });
    await bot.sendMessage(chatId, `🛠 Service détecté : *${service}*\n💰 Montant détecté : *${price} €*\n\n📍 Donne ton adresse complète :`, {
      parse_mode: "Markdown",
      reply_markup: { keyboard: [[{ text: "❌ Annuler" }]], resize_keyboard: true }
    });
  }
});

bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const userId = q.from.id;

  if (q.data === "ORDER_START") {
    await bot.answerCallbackQuery(q.id);
    return startOrder(chatId, userId);
  }
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  if (!userId) return;

  // ignore /commands (handled separately)
  if (msg.text?.startsWith("/")) return;

  // cancel
  if (msg.text === "❌ Annuler") {
    state.delete(userId);
    return bot.sendMessage(chatId, "✅ Commande annulée.", {
      reply_markup: { remove_keyboard: true }
    });
  }

  const s = state.get(userId);
  if (!s) return;

  const text = (msg.text || "").trim();
  if (!text) return;

  if (s.step === "service") {
    s.data.service = text;
    s.step = "amount";
    state.set(userId, s);
    return bot.sendMessage(chatId, "💰 Quel est le montant de la commande (€) ?", {
      reply_markup: { keyboard: [[{ text: "❌ Annuler" }]], resize_keyboard: true }
    });
  }

  if (s.step === "amount") {
    s.data.amount = text.replace(",", ".");
    s.step = "address";
    state.set(userId, s);
    return bot.sendMessage(chatId, "📍 Donne ton adresse complète :", {
      reply_markup: { keyboard: [[{ text: "❌ Annuler" }]], resize_keyboard: true }
    });
  }

  if (s.step === "address") {
    s.data.address = text;

    const orderNo = nextOrderNumber();
    const username = msg.from.username ? `@${msg.from.username}` : "(sans username)";
    const name = `${msg.from.first_name || ""} ${msg.from.last_name || ""}`.trim() || "Client";
    const now = new Date();

    // save order
    const db = loadDB();
    db.orders.push({
      orderNo,
      userId,
      username,
      name,
      service: s.data.service,
      amount: s.data.amount,
      address: s.data.address,
      date: now.toISOString()
    });
    saveDB(db);

    // send to back office
    const backOfficeMsg =
      `🆕 *NOUVELLE COMMANDE SLR BOOST*\n\n` +
      `🧾 Commande : *${orderNo}*\n` +
      `👤 Client : *${name}* ${username} (ID ${userId})\n` +
      `🛠 Service : *${s.data.service}*\n` +
      `💰 Montant : *${s.data.amount} €*\n` +
      `📍 Adresse :\n${s.data.address}\n\n` +
      `⏱ Date : ${now.toLocaleString("fr-FR")}`;

    await bot.sendMessage(BACKOFFICE_CHAT_ID, backOfficeMsg, { parse_mode: "Markdown" });

    // confirm user
    await bot.sendMessage(chatId, `✅ Commande reçue !\n\nNuméro : ${orderNo}\nOn te recontacte rapidement.`, {
      reply_markup: { remove_keyboard: true }
    });

    state.delete(userId);
  }
});
