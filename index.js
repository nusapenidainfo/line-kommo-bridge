// index.js
// Простая связка: LINE webhook -> создание лида в Kommo

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

const app = express();

// --------- Служебный статус ---------
app.get("/status", (req, res) => {
  res.json({
    ok: true,
    service: "line-kommo-bridge",
    timestamp: new Date().toISOString(),
  });
});

// --------- Помощники ---------

// Проверка подписи LINE (если вдруг что-то пойдёт не так — просто логируем)
function verifyLineSignature(bodyString, signature) {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret || !signature) {
    console.warn("LINE signature check skipped (no secret or signature)");
    return true;
  }
  try {
    const hash = crypto
      .createHmac("sha256", secret)
      .update(bodyString)
      .digest("base64");
    const ok = hash === signature;
    if (!ok) console.error("LINE signature mismatch");
    return ok;
  } catch (e) {
    console.error("Error while checking LINE signature:", e.message);
    return false;
  }
}

// Создание простого лида в Kommo
async function createKommoLeadFromLine(lineUserId, text) {
  const subdomain = process.env.KOMMO_SUBDOMAIN; // andriecas
  const apiKey = process.env.KOMMO_API_KEY; // long-lived token

  if (!subdomain || !apiKey) {
    console.error("Kommo credentials are missing. Check env variables.");
    return;
  }

  const url = `https://${subdomain}.kommo.com/api/v4/leads`;

  // Название лида: кусок текста + userId, чтобы было понятно, откуда он
  const leadName = `LINE ${lineUserId}: ${text}`.slice(0, 250);

  const payload = [
    {
      name: leadName,
      // можно будет добавить pipeline_id / tags и т.п. позже
    },
  ];

  try {
    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeout: 10000,
    });

    const created = Array.isArray(response.data) ? response.data[0] : null;
    console.log(
      "Kommo lead created",
      created ? `id=${created.id}` : "(no id in response)"
    );
  } catch (err) {
    if (err.response) {
      console.error(
        "Kommo API error:",
        err.response.status,
        JSON.stringify(err.response.data)
      );
    } else {
      console.error("Kommo request failed:", err.message);
    }
  }
}

// --------- Webhook от LINE ---------

// Используем raw text, чтобы посчитать подпись
app.post("/line/webhook", express.text({ type: "*/*" }), async (req, res) => {
  const signature = req.header("x-line-signature");

  if (!verifyLineSignature(req.body, signature)) {
    return res.status(401).send("Bad signature");
  }

  let data;
  try {
    data = JSON.parse(req.body);
  } catch (e) {
    console.error("Cannot parse LINE webhook body as JSON:", e.message);
    return res.status(400).send("Invalid JSON");
  }

  if (!data.events || !Array.isArray(data.events)) {
    return res.json({ ok: true, message: "no events" });
  }

  // Обрабатываем все события
  for (const event of data.events) {
    try {
      if (
        event.type === "message" &&
        event.message &&
        event.message.type === "text"
      ) {
        const text = event.message.text || "";
        const source = event.source || {};
        const lineUserId =
          source.userId || source.groupId || source.roomId || "unknown";

        console.log("New LINE message:", { lineUserId, text });

        // Создаём лид в Kommo
        await createKommoLeadFromLine(lineUserId, text);
      } else {
        console.log("Skip non-text event from LINE");
      }
    } catch (e) {
      console.error("Error while handling LINE event:", e.message);
    }
  }

  // LINE важно получить ответ быстро
  res.json({ ok: true });
});

// --------- Запуск сервера ---------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`line-kommo-bridge is running on port ${PORT}`);
});
