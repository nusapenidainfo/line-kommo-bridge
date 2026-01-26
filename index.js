// index.js
// Простой сервер для LINE Webhook → (позже добавим Kommo)

const express = require("express");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// Секрет канала LINE из переменной окружения на Render
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";

// ---------------------- Health-check ----------------------
// Чтобы проверить, что сервер жив: GET /status
app.get("/status", (req, res) => {
  res.json({
    ok: true,
    service: "line-kommo-bridge",
    timestamp: new Date().toISOString(),
  });
});

// ---------------------- LINE Webhook ----------------------
// LINE будет слать сюда POST-запросы
app.post(
  "/line/webhook",
  // Для проверки подписи нужен "сырое" тело, а не уже распарсенный JSON
  express.raw({ type: "*/*" }),
  (req, res) => {
    try {
      // Подпись из заголовка
      const signature = req.headers["x-line-signature"];

      if (CHANNEL_SECRET) {
        const computedHash = crypto
          .createHmac("sha256", CHANNEL_SECRET)
          .update(req.body) // req.body здесь Buffer
          .digest("base64");

        if (signature !== computedHash) {
          console.warn("⚠️  Wrong LINE signature");
          return res.status(401).send("Signature validation failed");
        }
      } else {
        console.warn("⚠️  No CHANNEL_SECRET set, skipping signature check");
      }

      const bodyText = req.body.toString("utf8");
      const json = JSON.parse(bodyText);

      console.log("✅ LINE webhook event received:");
      console.log(JSON.stringify(json, null, 2));

      // TODO: здесь позже добавим отправку данных в Kommo

      // Важно: быстро ответить 200 OK, чтобы LINE был доволен
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error("❌ Error in /line/webhook handler:", err);
      res.status(500).send("Internal Server Error");
    }
  }
);

// ---------------------- Start server ----------------------
app.listen(PORT, () => {
  console.log(`🚀 line-kommo-bridge running on port ${PORT}`);
});

module.exports = app;
