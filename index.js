// index.js
// Связка:
// 1) LINE webhook -> создание лида в Kommo
// 2) Kommo (Emfy Webhooks) -> наш сервер -> поиск LINE userId в Kommo и отправка тестового ответа в LINE

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const querystring = require("querystring");

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

// Проверка подписи LINE
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

// Отправка сообщения в LINE (push API)
async function sendLineMessage(to, text) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    console.error("LINE_CHANNEL_ACCESS_TOKEN is missing");
    return;
  }

  const url = "https://api.line.me/v2/bot/message/push";
  const payload = {
    to,
    messages: [
      {
        type: "text",
        text,
      },
    ],
  };

  try {
    const resp = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    });
    console.log("LINE message sent to", to, "status", resp.status);
  } catch (err) {
    if (err.response) {
      console.error(
        "LINE API error:",
        err.response.status,
        JSON.stringify(err.response.data)
      );
    } else {
      console.error("LINE request failed:", err.message);
    }
  }
}

// Создание простого лида в Kommo из сообщения LINE
async function createKommoLeadFromLine(lineUserId, text) {
  const subdomain = process.env.KOMMO_SUBDOMAIN; // andriecas
  const apiKey = process.env.KOMMO_API_KEY; // long-lived token

  if (!subdomain || !apiKey) {
    console.error(
      "Kommo credentials are missing. Check KOMMO_SUBDOMAIN and KOMMO_API_KEY."
    );
    return;
  }

  const url = `https://${subdomain}.kommo.com/api/v4/leads`;

  // Название лида: кусок текста + userId, чтобы было понятно, откуда он
  const leadName = `LINE ${lineUserId}: ${text}`.slice(0, 250);

  const payload = [
    {
      name: leadName,
      // сюда потом можно добавить pipeline_id, tags и т.п.
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

// Вытаскиваем LINE userId из имени лида формата "LINE UXXXX: текст"
function extractLineUserIdFromLeadName(leadName) {
  if (!leadName || typeof leadName !== "string") return null;
  const match = /^LINE\s+([^:]+):/.exec(leadName);
  return match ? match[1] : null;
}

// Запрос лида в Kommo и попытка найти LINE userId в JSON
async function findLineUserIdViaKommoApi(leadId) {
  const subdomain = process.env.KOMMO_SUBDOMAIN;
  const apiKey = process.env.KOMMO_API_KEY;

  if (!subdomain || !apiKey) {
    console.error(
      "Cannot call Kommo API: KOMMO_SUBDOMAIN or KOMMO_API_KEY is missing"
    );
    return null;
  }

  const url = `https://${subdomain}.kommo.com/api/v4/leads/${leadId}?with=contacts`;

  try {
    const resp = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      timeout: 10000,
    });

    // Чуть-чуть логов для диагностики (отрезаем, чтобы не заспамить)
    try {
      const shortLog = JSON.stringify(
        {
          id: resp.data && resp.data.id,
          name: resp.data && resp.data.name,
          embeddedKeys: resp.data && resp.data._embedded
            ? Object.keys(resp.data._embedded)
            : [],
        },
        null,
        2
      );
      console.log("Kommo lead short JSON:", shortLog);
    } catch (e) {
      console.warn("Cannot stringify Kommo lead short JSON:", e.message);
    }

    const jsonStr = JSON.stringify(resp.data);

    // Ищем что-то похожее на LINE userId: строка, начинающаяся с U и много hex-символов
    const match = jsonStr.match(/U[a-f0-9]{10,}/i);
    if (match) {
      console.log("Found LINE userId in Kommo JSON:", match[0]);
      return match[0];
    }

    console.warn("LINE userId not found in Kommo lead JSON");
    return null;
  } catch (err) {
    if (err.response) {
      console.error(
        "Error while requesting Kommo lead:",
        err.response.status,
        JSON.stringify(err.response.data)
      );
    } else {
      console.error("Error while requesting Kommo lead:", err.message);
    }
    return null;
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

// --------- Webhook из Kommo (Emfy Webhooks) ---------
// Принимаем и GET, и POST, и OPTIONS
// Тело приходит как x-www-form-urlencoded (строка "a=1&b=2") — разбираем через querystring.parse

app.all(
  "/kommo/webhook",
  express.text({ type: "*/*" }),
  async (req, res) => {
    try {
      console.log("==== Kommo webhook ====");
      console.log("Method:", req.method);
      console.log("Headers:", JSON.stringify(req.headers, null, 2));
      console.log("Raw body:", req.body);

      let parsedBody = {};
      if (typeof req.body === "string" && req.body.length > 0) {
        try {
          parsedBody = querystring.parse(req.body);
        } catch (e) {
          console.error("Error parsing urlencoded body:", e.message);
        }
      }

      console.log("Parsed body:", parsedBody);

      // CORS для фронта Kommo
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Access-Control-Allow-Headers", "*");
      res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

      // Preflight запрос
      if (req.method === "OPTIONS") {
        return res.status(200).end();
      }

      // ---- Логика поиска LINE userId ----
      const leadIdFromThisItem = parsedBody["this_item[id]"];
      const leadIdFromAdd = parsedBody["leads[add][0][id]"];
      const leadNameFromThisItem = parsedBody["this_item[name]"];
      const leadNameFromLeadsAdd = parsedBody["leads[add][0][name]"];

      const leadId = leadIdFromThisItem || leadIdFromAdd || null;
      const leadName =
        (typeof leadNameFromThisItem === "string" && leadNameFromThisItem) ||
        (typeof leadNameFromLeadsAdd === "string" && leadNameFromLeadsAdd) ||
        null;

      console.log("Lead from Kommo:", {
        leadId,
        leadNameFromLeadsAdd,
        leadNameFromThisItem,
        leadName,
      });

      let lineUserId = extractLineUserIdFromLeadName(leadName);
      console.log("Extracted lineUserId from leadName:", lineUserId);

      // Если из имени лида не получилось — пробуем через Kommo API
      if (!lineUserId && leadId) {
        lineUserId = await findLineUserIdViaKommoApi(leadId);
      }

      if (lineUserId) {
        const msg = `Test reply from Kommo for your request ${
          leadId || ""
        }.`;
        // не ждём, чтобы не задерживать ответ Emfy
        sendLineMessage(lineUserId, msg).catch((e) =>
          console.error("sendLineMessage error:", e.message)
        );
      } else {
        console.log(
          "Could not extract LINE userId; skipping sendLineMessage"
        );
      }

      // Отвечаем валидным JSON — этого ждёт виджет Emfy
      res.json({
        ok: true,
        message: "kommo webhook received",
        method: req.method,
        received: parsedBody,
      });
    } catch (err) {
      console.error("Error in /kommo/webhook:", err.message);

      res.set("Access-Control-Allow-Origin", "*");
      res.set("Access-Control-Allow-Headers", "*");
      res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// --------- Запуск сервера ---------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`line-kommo-bridge is running on port ${PORT}`);
});
