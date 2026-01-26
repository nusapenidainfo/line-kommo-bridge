// index.js
// Простой сервер для LINE Webhook → (позже добавим Kommo)

const express = require("express");
const crypto = require("crypto");

const app = express();

// Чтобы Express понимал JSON-тело запроса от LINE
app.use(express.json());

// Секрет канала LINE берём из переменной окружения
// (пока можно оставить пустым, позже настроим на Render)
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";

// Проверка подписи от LINE (защита от подделки запросов)
function isValidLineSignature(req) {
  if (!LINE_CHANNEL_SECRET) {
    // Если секрет не настроен – пропускаем проверку
    return true;
  }

  const signature = req.headers["x-line-signature"];
  if (!signature) return false;

  const body = JSON.stringify(req.body);
  const hash = crypto
    .createHmac("sha256", LINE_CHANNEL_SECRET)
    .update(body)
    .digest("base64");

  return signature === hash;
}

// 1) Простой тестовый эндпоинт – чтобы проверять, что сервер жив
app.get("/health", (req, res) => {
  res.send("LINE → Kommo bridge is running ✅");
});

// 2) Основной Webhook-эндпоинт для LINE
app.post("/line/webhook", (req, res) => {
  // Проверяем подпись
  if (!isValidLineSignature(req)) {
    console.log("❌ Invalid LINE signature");
    return res.status(401).send("Invalid signature");
  }

  // Логируем всё, что прислал LINE (для отладки)
  console.log("✅ LINE webhook event:");
  console.log(JSON.stringify(req.body, null, 2));

  // Здесь позже добавим отправку данных в Kommo

  // LINE ожидает 200 OK быстро
  res.json({ status: "ok" });
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server is listening on port ${PORT}`);
});
