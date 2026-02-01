// index.js
// Связка:
// 1) LINE webhook -> создаём контакт + лид в Kommo, сохраняем LINE userId в теге контакта
// 2) Kommo (Emfy Webhooks) -> наш сервер -> отправка тестового ответа в LINE

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

function getKommoCreds() {
  const subdomain = process.env.KOMMO_SUBDOMAIN;
  const apiKey = process.env.KOMMO_API_KEY; // long-lived token

  if (!subdomain || !apiKey) {
    console.error(
      "Kommo credentials are missing. Check KOMMO_SUBDOMAIN and KOMMO_API_KEY"
    );
    return null;
  }

  return { subdomain, apiKey };
}

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

// Создать контакт в Kommo для LINE-пользователя
async function createKommoContactForLineUser(lineUserId) {
  const creds = getKommoCreds();
  if (!creds) return null;
  const { subdomain, apiKey } = creds;

  const url = `https://${subdomain}.kommo.com/api/v4/contacts`;

  const payload = [
    {
      name: `LINE ${lineUserId}`,
      _embedded: {
        tags: [
          { name: "LINE" },
          { name: `LINE_UID_${lineUserId}` },
        ],
      },
    },
  ];

  try {
    const resp = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeout: 10000,
    });

    const created = Array.isArray(resp.data) ? resp.data[0] : null;
    const contactId = created ? created.id : null;
    console.log("Created Kommo contact for LINE user:", {
      lineUserId,
      contactId,
    });
    return contactId;
  } catch (err) {
    if (err.response) {
      console.error(
        "Kommo API error (createKommoContactForLineUser):",
        err.response.status,
        JSON.stringify(err.response.data)
      );
    } else {
      console.error(
        "Kommo request failed (createKommoContactForLineUser):",
        err.message
      );
    }
    return null;
  }
}

// Создать лид в Kommo и привязать к контакту
async function createKommoLeadForContact(contactId, lineUserId, text) {
  const creds = getKommoCreds();
  if (!creds) return;
  const { subdomain, apiKey } = creds;

  const url = `https://${subdomain}.kommo.com/api/v4/leads`;

  const cleanText =
    text && text.trim().length > 0 ? text.trim().slice(0, 250) : "LINE lead";

  const payload = [
    {
      name: cleanText,
      _embedded: {
        tags: [{ name: "LINE" }],
        contacts: contactId ? [{ id: Number(contactId) }] : [],
      },
    },
  ];

  try {
    const resp = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeout: 10000,
    });

    const created = Array.isArray(resp.data) ? resp.data[0] : null;
    console.log("Kommo lead created from LINE:", {
      lineUserId,
      leadId: created ? created.id : null,
      contactId,
    });
  } catch (err) {
    if (err.response) {
      console.error(
        "Kommo API error (createKommoLeadForContact):",
        err.response.status,
        JSON.stringify(err.response.data)
      );
    } else {
      console.error(
        "Kommo request failed (createKommoLeadForContact):",
        err.message
      );
    }
  }
}

// Получить контакт из Kommo по contactId
async function fetchKommoContact(contactId) {
  const creds = getKommoCreds();
  if (!creds) return null;
  const { subdomain, apiKey } = creds;

  if (!contactId) {
    console.warn("fetchKommoContact called without contactId");
    return null;
  }

  const url = `https://${subdomain}.kommo.com/api/v4/contacts/${contactId}?with=tags,custom_fields`;

  try {
    const resp = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      timeout: 10000,
    });
    const hasTags =
      !!(resp.data && resp.data._embedded && resp.data._embedded.tags);
    console.log("Loaded contact from Kommo:", { contactId, hasTags });
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
    return null;
  }
}

// Пытаемся вытащить LINE userId из контакта
function extractLineUserIdFromContact(contact) {
  if (!contact || typeof contact !== "object") return null;

  // 1) Теги вида LINE_UID_XXXXX
  const tags = (contact._embedded && contact._embedded.tags) || [];
  for (const tag of tags) {
    if (!tag || !tag.name) continue;
    if (tag.name.startsWith("LINE_UID_")) {
      const uid = tag.name.replace(/^LINE_UID_/, "").trim();
      if (uid) return uid;
    }
  }

  // 2) На всякий случай — поиск в кастомных полях
  const cfv = contact.custom_fields_values;
  if (Array.isArray(cfv)) {
    for (const field of cfv) {
      const values = field.values || [];
      for (const v of values) {
        const val = typeof v.value === "string" ? v.value.trim() : null;
        if (!val) continue;
        if (val.startsWith("U") && val.length >= 10) {
          return val;
        }
      }
    }
  }

  return null;
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

        // 1) Создаём контакт с тегами LINE + LINE_UID_...
        const contactId = await createKommoContactForLineUser(lineUserId);

        // 2) Создаём лид и привязываем контакт
        await createKommoLeadForContact(contactId, lineUserId, text);
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

      const leadId =
        parsedBody["this_item[id]"] || parsedBody["leads[add][0][id]"];
      const leadNameFromThisItem = parsedBody["this_item[name]"];
      const leadNameFromLeadsAdd = parsedBody["leads[add][0][name]"];
      const leadName = leadNameFromThisItem || leadNameFromLeadsAdd;

      const contactId =
        parsedBody["this_item[_embedded][contacts][0][id]"] ||
        parsedBody["this_item[contact][id]"];

      console.log("Lead from Kommo:", {
        leadId,
        leadNameFromLeadsAdd,
        leadNameFromThisItem,
        leadName,
        contactId,
      });

      let lineUserId = null;

      // 1) Пытаемся вытащить из имени лида "LINE <userId>: ..."
      if (leadName && typeof leadName === "string") {
        const match = /^LINE\s+([^:]+):/.exec(leadName);
        if (match) {
          lineUserId = match[1];
          console.log("Extracted lineUserId from leadName:", lineUserId);
        } else {
          console.log(
            'Lead name does not contain "LINE <userId>:" pattern, will try contact.'
          );
        }
      }

      // 2) Если в имени нет — ищем в контакте (теги LINE_UID_...)
      if (!lineUserId && contactId) {
        console.log(
          "Trying to fetch contact from Kommo to inspect LINE tags..."
        );
        const contact = await fetchKommoContact(contactId);
        const fromContact = extractLineUserIdFromContact(contact);
        console.log("Extracted lineUserId from contact:", fromContact);
        if (fromContact) {
          lineUserId = fromContact;
        }
      }

      if (!lineUserId) {
        console.log(
          "No LINE userId found (tags, lead name, contact); skipping sendLineMessage"
        );
      } else {
        const msg = `Test reply from Kommo for your request ${
          leadId || ""
        }.`;
        sendLineMessage(lineUserId, msg).catch((e) =>
          console.error("sendLineMessage error:", e.message)
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
