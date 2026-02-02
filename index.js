// index.js
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const querystring = require("querystring");

const app = express();

// ---------- CONFIG ----------

// Kommo
const KOMMO_SUBDOMAIN = process.env.KOMMO_SUBDOMAIN; // напр. "andriecas"
const KOMMO_API_KEY = process.env.KOMMO_API_KEY;     // долгоживущий токен Kommo

// LINE
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// ID пайплайна и статуса для LINE (мы их видели в логах)
const KOMMO_LINE_PIPELINE_ID = 3153064;
const KOMMO_LINE_STATUS_ID = 46001680;

// ---------- KOMMO HELPERS ----------

async function kommoRequest(method, path, data, extraConfig) {
  if (!KOMMO_SUBDOMAIN || !KOMMO_API_KEY) {
    throw new Error("KOMMO_SUBDOMAIN or KOMMO_API_KEY is not set");
  }

  const url = `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4${path}`;
  const config = Object.assign(
    {
      method,
      url,
      headers: {
        Authorization: `Bearer ${KOMMO_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeout: 10000,
      data,
    },
    extraConfig || {}
  );

  return axios(config);
}

// Найти контакт по имени "LINE <userId>"
async function findKommoContactIdByLineUserId(lineUserId) {
  if (!lineUserId) return null;
  const query = `LINE ${lineUserId}`;

  try {
    const resp = await kommoRequest("get", "/contacts", null, {
      params: {
        query,
        limit: 1,
      },
    });

    const embedded = resp.data && resp.data._embedded;
    const contacts = embedded && embedded.contacts;

    if (Array.isArray(contacts) && contacts.length > 0) {
      return contacts[0].id;
    }

    return null;
  } catch (err) {
    if (err.response) {
      console.error(
        "Kommo API error (find contact):",
        err.response.status,
        JSON.stringify(err.response.data)
      );
    } else {
      console.error("Kommo request failed (find contact):", err.message);
    }
    return null;
  }
}

// Создаём или находим контакт для LINE-пользователя
async function createKommoContactForLineUser(lineUserId) {
  if (!lineUserId) {
    console.warn("createKommoContactForLineUser called without lineUserId");
    return null;
  }

  // 1) пробуем найти существующий контакт по имени "LINE <userId>"
  const existingId = await findKommoContactIdByLineUserId(lineUserId);
  if (existingId) {
    console.log("Using existing Kommo contact for LINE user:", {
      lineUserId,
      contactId: existingId,
    });
    return existingId;
  }

  // 2) создаём новый контакт
  const contactName = `LINE ${lineUserId}`;
  const payload = [
    {
      name: contactName,
      _embedded: {
        tags: [{ name: "LINE" }],
      },
    },
  ];

  try {
    const resp = await kommoRequest("post", "/contacts", payload);
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
        "Kommo API error (create contact):",
        err.response.status,
        JSON.stringify(err.response.data)
      );
    } else {
      console.error("Kommo request failed (create contact):", err.message);
    }
    return null;
  }
}

// Создаём лид из сообщения LINE и привязываем к контакту
async function createKommoLeadFromLine(lineUserId, text, contactId) {
  if (!KOMMO_SUBDOMAIN || !KOMMO_API_KEY) {
    console.error("Kommo credentials are missing");
    return null;
  }

  const leadName =
    (text && text.trim().slice(0, 200)) || "New message from LINE";

  const lead = {
    name: leadName,
    pipeline_id: KOMMO_LINE_PIPELINE_ID,
    status_id: KOMMO_LINE_STATUS_ID,
    _embedded: {
      tags: [{ name: "LINE" }],
    },
  };

  if (contactId) {
    lead._embedded.contacts = [{ id: contactId }];
  }

  const payload = [lead];

  try {
    const resp = await kommoRequest("post", "/leads", payload);
    const created = Array.isArray(resp.data) ? resp.data[0] : null;
    const leadId = created ? created.id : null;

    console.log("Kommo lead created from LINE:", {
      lineUserId,
      leadId,
      contactId,
    });

    return leadId;
  } catch (err) {
    if (err.response) {
      console.error(
        "Kommo API error (create lead):",
        err.response.status,
        JSON.stringify(err.response.data)
      );
    } else {
      console.error("Kommo request failed (create lead):", err.message);
    }
    return null;
  }
}

// Загрузить контакт Kommo по contactId
async function fetchKommoContact(contactId) {
  if (!contactId) return null;

  try {
    const resp = await kommoRequest("get", `/contacts/${contactId}`, null);
    const contact = resp.data;

    console.log("Loaded contact from Kommo:", {
      contactId,
      hasTags: !!(contact && contact._embedded && contact._embedded.tags),
    });

    return contact;
  } catch (err) {
    if (err.response) {
      console.error(
        "Kommo API error (fetch contact):",
        err.response.status,
        JSON.stringify(err.response.data)
      );
    } else {
      console.error("Kommo request failed (fetch contact):", err.message);
    }
    return null;
  }
}

// ---------- LINE HELPERS ----------

// Проверка подписи LINE
function verifyLineSignature(bodyString, signature) {
  const secret = LINE_CHANNEL_SECRET;
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

// Отправка push-сообщения в LINE
async function sendLineMessage(to, text) {
  if (!LINE_CHANNEL_ACCESS_TOKEN) {
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
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    });
    console.log("LINE message sent", { to, status: resp.status });
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

// ---------- KOMMO WEBHOOK PARSING ----------

// Достаём leadId / leadName / contactId из тела Emfy-вебхука
function extractLeadInfoFromWebhookBody(parsedBody) {
  const leadId =
    parsedBody["this_item[id]"] ||
    parsedBody["leads[add][0][id]"] ||
    null;

  const leadName =
    parsedBody["this_item[name]"] ||
    parsedBody["leads[add][0][name]"] ||
    null;

  const contactId =
    parsedBody["this_item[contacts][0][id]"] ||
    parsedBody["this_item[_embedded][contacts][0][id]"] ||
    parsedBody["leads[add][0][_embedded][contacts][0][id]"] ||
    null;

  return { leadId, leadName, contactId };
}

// Парсим userId из имени лида вида "LINE <userId>: текст"
function extractLineUserIdFromLeadName(leadName) {
  if (!leadName || typeof leadName !== "string") return null;
  const match = /^LINE\s+([^:]+):/.exec(leadName);
  return match ? match[1] : null;
}

// Парсим userId из контакта, если имя "LINE <userId>"
function extractLineUserIdFromContact(contact) {
  if (!contact) return null;
  if (contact.name && typeof contact.name === "string") {
    const m = /^LINE\s+(\S+)/.exec(contact.name);
    if (m) return m[1];
  }
  return null;
}

// ---------- ROUTES ----------

// Health-check
app.get("/status", (req, res) => {
  res.json({
    ok: true,
    service: "line-kommo-bridge",
    timestamp: new Date().toISOString(),
  });
});

// Вебхук LINE: входящие сообщения → Kommo
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
          source.userId || source.groupId || source.roomId || null;

        console.log("New LINE message:", { lineUserId, text });

        // создаём/находим контакт и лид
        const contactId = await createKommoContactForLineUser(lineUserId);
        await createKommoLeadFromLine(lineUserId, text, contactId);
      } else {
        console.log("Skip non-text event from LINE");
      }
    } catch (e) {
      console.error("Error while handling LINE event:", e.message);
    }
  }

  // LINE нужно быстро отвечать
  res.json({ ok: true });
});

// Вебхук Kommo (через Emfy) → отправка сообщения в LINE
app.all(
  "/kommo/webhook",
  express.text({ type: "*/*" }),
  async (req, res) => {
    // CORS для виджета Emfy
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "*");
    res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

    if (req.method === "OPTIONS") {
      return res.status(200).end();
    }

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

      const { leadId, leadName, contactId } = extractLeadInfoFromWebhookBody(
        parsedBody
      );

      console.log("Lead from Kommo:", {
        leadId,
        leadName,
        contactId,
      });

      let lineUserId = extractLineUserIdFromLeadName(leadName);

      if (lineUserId) {
        console.log("Extracted lineUserId from leadName:", lineUserId);
      } else if (contactId) {
        console.log(
          "Lead name does not contain 'LINE <userId>:', will try contact."
        );
        const contact = await fetchKommoContact(contactId);
        lineUserId = extractLineUserIdFromContact(contact);
        console.log("Extracted lineUserId from contact:", lineUserId);
      }

      if (lineUserId) {
        const msg = `Test reply from Kommo for your request ${
          leadId || ""
        }.`;
        await sendLineMessage(lineUserId, msg);
      } else {
        console.log(
          "No LINE userId found (tags, lead name, contact); skipping sendLineMessage"
        );
      }

      res.json({
        ok: true,
        message: "kommo webhook received",
        method: req.method,
        received: parsedBody,
      });
    } catch (err) {
      console.error("Error in /kommo/webhook:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// ---------- START SERVER ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`line-kommo-bridge is running on port ${PORT}`);
});
