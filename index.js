// index.js
// Простой сервер для LINE Webhook → (позже добавим Kommo)

const express = require("express");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// Секрет канала LINE из переменной окружения на Render
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";

// ======================================================
// Простой корневой маршрут – чтобы было видно, что сервер жив
// GET https://line-kommo-bridge.onrender.com/
app.get("/", (req, res) => {
  res.send("line-kommo-bridge is running ✅");
});

// Health-check маршрут
// GET https://line-kommo-bridge.onrender.com/status
app.get("/status", (req, res) => {
  res.json({
    ok: true,
    service: "line-kommo-bridge",
    timestamp: new Date().toISOString(),
  });
});

// ======================================================
// LINE Webhook
// Сюда LINE будет слать POST-запросы
// URL: https://line-kommo-bridge.onrender.com/line/webhook
app.post(
  "/line/webhook",
  // ВАЖНО: используем raw, чтобы подпись считалась правильно
  express.raw({ type: "*/*" }),
  (req, res) => {
    try {
      // Подпись из заголовка
      const signature = req.headers["x-line-signature"];

      if (CHANNEL_SECRET) {
        const computedHash = crypto
          .createHmac("sha256", CHANNEL_SECRET)
          .update(req.body) // req.body – это Buffer
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

      // TODO: тут потом добавим отправку данных в Kommo

      // Быстро отвечаем 200 OK, чтобы LINE был доволен
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error("❌ Error in /line/webhook handler:", err);
      res.status(500).send("Internal Server Error");
    }
  }
);

// ======================================================
// Запуск сервера
app.listen(PORT, () => {
  console.log(`🚀 line-kommo-bridge running on port ${PORT}`);
});

module.exports = app;
