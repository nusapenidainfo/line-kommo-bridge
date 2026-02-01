// index.js
// Связка:
// 1) LINE webhook -> создание лида в Kommo
// 2) Kommo (Emfy Webhooks) -> наш сервер -> попытка отправить ответ в LINE

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

// Отправка текста в LINE (push API)
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
    console.error("Kommo credentials are missing. Check env variables.");
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

// Загрузка контакта из Kommo
async function fetchKommoContact(contactId) {
  const subdomain = process.env.KOMMO_SUBDOMAIN;
  const apiKey = process.env.KOMMO_API_KEY;

  if (!subdomain || !apiKey) {
    console.error(
      "Kommo credentials are missing for fetchKommoContact. Check env variables."
    );
    throw new Error("Kommo credentials missing");
  }

  const url = `https://${subdomain}.kommo.com/api/v4/contacts/${contactId}`;

  try {
    const resp = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      timeout: 10000,
    });

    return resp.data;
  } catch (err) {
    if (err.response) {
      console.error(
        "Kommo API error (fetchKommoContact):",
        err.response.status,
        JSON.stringify(err.response.data)
      );
    } else {
      console.error("Kommo request failed (fetchKommoContact):", err.message);
    }
    throw err;
  }
}

// Поиск LINE userId внутри контакта
function extractLineUserIdFromContact(contact) {
  if (!contact || typeof contact !== "object") return null;

  // 1) Пытаемся найти в custom_fields_values поле, где имя/код содержит "line"
  const cfv = contact.custom_fields_values;
  if (Array.isArray(cfv)) {
    for (const field of cfv) {
      const fieldName = (field.field_name || field.name || "").toLowerCase();
      const fieldCode = (field.field_code || "").toLowerCase();

      if (fieldName.includes("line") || fieldCode.includes("line")) {
        if (Array.isArray(field.values)) {
          for (const v of field.values) {
            if (v && typeof v.value === "string") {
              const candidate = v.value.trim();
              if (/^U[0-9a-f]{16,}$/i.test(candidate)) {
                return candidate;
              }
            }
          }
        }
      }
    }
  }

  // 2) Универсальный глубокий поиск по всему объекту
  const fromDeep = deepSearchLineUserId(contact);
  if (fromDeep) return fromDeep;

  return null;
}

// Глубокий поиск строки, похожей на LINE userId, по всему объекту
function deepSearchLineUserId(root) {
  const visited = new WeakSet();

  function helper(node) {
    if (node == null) return null;

    if (typeof node === "string") {
      const candidate = node.trim();
      if (/^U[0-9a-f]{16,}$/i.test(candidate)) {
        return candidate;
      }
      return null;
    }

    if (typeof node !== "object") return null;

    if (visited.has(node)) return null;
    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node) {
        const res = helper(item);
        if (res) return res;
      }
    } else {
      for (const key of Object.keys(node)) {
        const res = helper(node[key]);
        if (res) return res;
      }
    }

    return null;
  }

  return helper(root);
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

      // Достаём базовые данные лида/контакта
      const leadId =
        parsedBody["this_item[id]"] ||
        parsedBody["leads[add][0][id]"] ||
        parsedBody["leads[update][0][id]"] ||
        null;

      const leadName =
        parsedBody["this_item[name]"] ||
        parsedBody["leads[add][0][name]"] ||
        parsedBody["leads[update][0][name]"] ||
        null;

      const contactId =
        parsedBody["this_item[_embedded][contacts][0][id]"] ||
        parsedBody["leads[add][0][_embedded][contacts][0][id]"] ||
        parsedBody["leads[update][0][_embedded][contacts][0][id]"] ||
        null;

      console.log("Lead from Kommo:", {
        leadId,
        leadName,
        contactId,
      });

      // Пробуем достать userId из имени лида (для наших новых лидов)
      let lineUserId = null;
      if (leadName && typeof leadName === "string") {
        const match = /^LINE\s+([^:]+):/.exec(leadName);
        if (match) {
          lineUserId = match[1];
        }
      }

      console.log("Extracted lineUserId from leadName:", lineUserId || "null");

      // Если в имени лида нет userId — пробуем контакт
      if (!lineUserId && contactId) {
        console.log(
          "Lead name does not contain 'LINE <userId>:' pattern, will try contact."
        );

        try {
          console.log(
            "Trying to fetch contact from Kommo to inspect fields..."
          );
          const contact = await fetchKommoContact(contactId);
          console.log(
            "Contact from Kommo:",
            JSON.stringify(contact, null, 2)
          );

          lineUserId = extractLineUserIdFromContact(contact);
          console.log(
            "Extracted lineUserId from contact:",
            lineUserId || "null"
          );
        } catch (err) {
          console.error(
            "Could not load contact from Kommo for contactId:",
            contactId
          );
        }
      }

      if (lineUserId) {
        const msg = `Test reply from Kommo for your lead ${
          leadId || ""
        }.`;
        // Отправляем, но не ждём, чтобы не тормозить ответ Emfy
        sendLineMessage(lineUserId, msg).catch((e) =>
          console.error("sendLineMessage error:", e.message)
        );
      } else {
        console.log(
          "No LINE userId found (neither in lead name nor contact); skipping sendLineMessage"
        );
      }

      // CORS для фронта Kommo
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Access-Control-Allow-Headers", "*");
      res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

      // Preflight запрос
      if (req.method === "OPTIONS") {
        return res.status(200).end();
      }

      // Ответ для Emfy
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
