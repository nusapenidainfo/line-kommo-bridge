// index.js
// LINE <-> Kommo bridge
// 1) Webhook от LINE: создаём/ищем контакт + лид в Kommo, пишем входящее сообщение в note
// 2) Webhook от Kommo (Emfy Webhooks / виджет): берём текст ответа и шлём его в LINE

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const querystring = require("querystring");

const app = express();

// ===================== ENV =====================

const KOMMO_SUBDOMAIN = process.env.KOMMO_SUBDOMAIN; // andriecas
const KOMMO_CLIENT_ID = process.env.KOMMO_CLIENT_ID;
const KOMMO_CLIENT_SECRET = process.env.KOMMO_CLIENT_SECRET;

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// ===================== STATUS =====================

app.get("/status", (req, res) => {
  res.json({
    ok: true,
    service: "line-kommo-bridge",
    timestamp: new Date().toISOString(),
  });
});

// ===================== HELPERS =====================

// ---- Kommo auth (client_credentials) ----

let kommoTokenCache = {
  accessToken: null,
  expiresAt: 0,
};

async function getKommoAccessToken() {
  if (
    kommoTokenCache.accessToken &&
    kommoTokenCache.expiresAt - Date.now() > 60_000
  ) {
    return kommoTokenCache.accessToken;
  }

  if (!KOMMO_SUBDOMAIN || !KOMMO_CLIENT_ID || !KOMMO_CLIENT_SECRET) {
    throw new Error("KOMMO_SUBDOMAIN / KOMMO_CLIENT_ID / KOMMO_CLIENT_SECRET are missing");
  }

  const url = `https://${KOMMO_SUBDOMAIN}.kommo.com/oauth2/access_token`;

  const payload = {
    client_id: KOMMO_CLIENT_ID,
    client_secret: KOMMO_CLIENT_SECRET,
    grant_type: "client_credentials",
  };

  const resp = await axios.post(url, payload, {
    headers: { "Content-Type": "application/json" },
    timeout: 10000,
  });

  const data = resp.data || {};
  if (!data.access_token || !data.expires_in) {
    throw new Error("Cannot get access_token from Kommo");
  }

  kommoTokenCache.accessToken = data.access_token;
  kommoTokenCache.expiresAt = Date.now() + data.expires_in * 1000;

  return kommoTokenCache.accessToken;
}

async function kommoRequest(method, path, data) {
  const token = await getKommoAccessToken();

  const url = `https://${KOMMO_SUBDOMAIN}.kommo.com${path}`;

  const config = {
    method,
    url,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    timeout: 15000,
  };

  if (data) {
    config.data = data;
  }

  const resp = await axios(config);
  return resp.data;
}

// ---- LINE signature ----

function verifyLineSignature(rawBody, signatureHeader) {
  if (!LINE_CHANNEL_SECRET) {
    console.warn("LINE_CHANNEL_SECRET is missing, skipping signature verification");
    return true;
  }
  if (!signatureHeader) {
    console.warn("No x-line-signature header");
    return false;
  }

  try {
    const hash = crypto
      .createHmac("sha256", LINE_CHANNEL_SECRET)
      .update(rawBody)
      .digest("base64");

    const ok = hash === signatureHeader;
    if (!ok) console.error("LINE signature mismatch");
    return ok;
  } catch (e) {
    console.error("Error verifying LINE signature:", e.message);
    return false;
  }
}

// ---- LINE profile ----

async function getLineProfile(lineUserId) {
  if (!LINE_CHANNEL_ACCESS_TOKEN) return null;

  try {
    const url = `https://api.line.me/v2/bot/profile/${encodeURIComponent(
      lineUserId
    )}`;

    const resp = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      timeout: 10000,
    });

    return resp.data || null;
  } catch (e) {
    console.error("Failed to get LINE profile:", e.response?.status, e.message);
    return null;
  }
}

// ---- LINE push message ----

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
    console.log("✅ LINE message sent to", to, "status", resp.status);
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

// ---- Kommo: contacts / leads / notes ----

function makeLineContactName(lineUserId, displayName) {
  if (displayName) return `LINE ${displayName} (${lineUserId})`;
  return `LINE ${lineUserId}`;
}

function makeLineLeadName(displayName) {
  if (displayName) return `[LINE] ${displayName}`;
  return "[LINE] New LINE lead";
}

// По тегам вида LINE_UID_<userId> достаём lineUserId
function extractLineUserIdFromContact(contact) {
  try {
    const tags = contact?._embedded?.tags || [];
    const uidTag = tags.find(
      (t) => t.name && typeof t.name === "string" && t.name.startsWith("LINE_UID_")
    );
    if (!uidTag) return null;
    return uidTag.name.replace("LINE_UID_", "");
  } catch (e) {
    return null;
  }
}

// Создаём / находим контакт по lineUserId
async function ensureKommoContact(lineUserId, displayNameHint) {
  const query = encodeURIComponent(lineUserId);
  let contact = null;

  try {
    const data = await kommoRequest(
      "get",
      `/api/v4/contacts?query=${query}&limit=50`
    );
    const items = data?._embedded?.contacts || [];
    if (items.length > 0) {
      contact = items[0];
    }
  } catch (e) {
    console.error("Error searching Kommo contacts:", e.message);
  }

  const displayName = displayNameHint || null;

  if (contact) {
    const contactId = contact.id;
    const existingName = contact.name || "";
    const needUpdateName =
      !existingName || !existingName.includes(lineUserId);

    const tags = contact._embedded?.tags || [];
    const hasGenericTag = tags.some((t) => t.name === "LINE");
    const hasUidTag = tags.some(
      (t) => t.name === `LINE_UID_${lineUserId}`
    );

    if (needUpdateName || !hasGenericTag || !hasUidTag) {
      const newContact = {
        id: contactId,
        name: needUpdateName ? makeLineContactName(lineUserId, displayName) : existingName,
        _embedded: {
          tags: [
            ...(hasGenericTag ? [] : [{ name: "LINE" }]),
            ...(hasUidTag ? [] : [{ name: `LINE_UID_${lineUserId}` }]),
          ],
        },
      };

      try {
        await kommoRequest("patch", "/api/v4/contacts", [newContact]);
        console.log("Updated Kommo contact for LINE user", lineUserId);
      } catch (e) {
        console.error("Failed to update Kommo contact:", e.message);
      }
    }

    return {
      contactId,
      name: contact.name || makeLineContactName(lineUserId, displayName),
    };
  }

  // Создаём новый контакт
  const payload = [
    {
      name: makeLineContactName(lineUserId, displayName),
      _embedded: {
        tags: [{ name: "LINE" }, { name: `LINE_UID_${lineUserId}` }],
      },
    },
  ];

  try {
    const created = await kommoRequest("post", "/api/v4/contacts", payload);
    const newContact = Array.isArray(created) ? created[0] : null;
    const contactId = newContact?.id;
    console.log("Created Kommo contact for LINE user", lineUserId, "id:", contactId);

    return {
      contactId,
      name: newContact?.name || makeLineContactName(lineUserId, displayName),
    };
  } catch (e) {
    console.error("Failed to create Kommo contact:", e.message);
    return { contactId: null, name: makeLineContactName(lineUserId, displayName) };
  }
}

// Ищем существующий "живой" лид контакта, иначе создаём новый
async function findOrCreateLeadForContact(contactId, displayName, firstMessageText) {
  if (!contactId) {
    console.error("findOrCreateLeadForContact: contactId is missing");
    return { leadId: null, leadName: null };
  }

  try {
    const data = await kommoRequest(
      "get",
      `/api/v4/leads?filter[contacts][]=${contactId}&limit=50`
    );
    const leads = data?._embedded?.leads || [];

    // Игнорируем стандартные статусы "успешно" (142) и "неуспешно" (143)
    const activeLead =
      leads.find(
        (l) => l.status_id !== 142 && l.status_id !== 143
      ) || null;

    if (activeLead) {
      console.log(
        "Using existing Kommo lead for contact:",
        JSON.stringify(
          {
            contactId,
            leadId: activeLead.id,
            leadName: activeLead.name,
          },
          null,
          2
        )
      );

      return { leadId: activeLead.id, leadName: activeLead.name };
    }
  } catch (e) {
    console.error("Error searching Kommo leads:", e.message);
  }

  // Создаём новый лид
  const payload = [
    {
      name: makeLineLeadName(displayName),
      _embedded: {
        contacts: [{ id: contactId }],
        tags: [{ name: "LINE" }],
      },
    },
  ];

  try {
    const created = await kommoRequest("post", "/api/v4/leads", payload);
    const lead = Array.isArray(created) ? created[0] : null;
    console.log(
      "Kommo lead created from LINE:",
      JSON.stringify(
        {
          contactId,
          leadId: lead?.id || null,
          leadName: lead?.name || null,
        },
        null,
        2
      )
    );

    return { leadId: lead?.id || null, leadName: lead?.name || null };
  } catch (e) {
    console.error("Failed to create Kommo lead:", e.message);
    return { leadId: null, leadName: null };
  }
}

// Добавляем примечание к лиду
async function addNoteToLead(leadId, text) {
  if (!leadId || !text) return;

  const payload = [
    {
      entity_id: leadId,
      entity_type: "leads",
      note_type: "common",
      text,
    },
  ];

  try {
    await kommoRequest("post", "/api/v4/notes", payload);
    console.log("Added note to Kommo lead:", { leadId, text });
  } catch (e) {
    console.error("Failed to add note to Kommo lead:", e.message);
  }
}

// Получаем контакт (и по необходимости лид) для ответа из Kommo
async function getKommoContactAndLineUserId({ leadId, contactId }) {
  let contact = null;

  try {
    if (!contactId && leadId) {
      // Тянем лид, чтобы узнать contactId
      const lead = await kommoRequest("get", `/api/v4/leads/${leadId}?with=contacts`);
      const contacts = lead?._embedded?.contacts || [];
      if (contacts.length > 0) {
        contactId = contacts[0].id;
      }
    }

    if (contactId) {
      contact = await kommoRequest("get", `/api/v4/contacts/${contactId}`);
    }
  } catch (e) {
    console.error("Error loading contact/lead in getKommoContactAndLineUserId:", e.message);
  }

  const lineUserId = extractLineUserIdFromContact(contact);

  return { contact, lineUserId, contactId, leadId };
}

// ===================== LINE WEBHOOK =====================
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

        console.log("💌 New LINE message:", {
          lineUserId,
          text,
        });

        const profile = await getLineProfile(lineUserId);
        const displayName = profile?.displayName || null;

        // 1) Контакт
        const contactInfo = await ensureKommoContact(lineUserId, displayName);
        const contactId = contactInfo.contactId;

        // 2) Лид (ищем существующий, иначе создаём)
        const leadInfo = await findOrCreateLeadForContact(
          contactId,
          displayName,
          text
        );

        // 3) Добавляем note с текстом сообщения
        const prettyName = displayName || lineUserId;
        const noteText = `From LINE (${prettyName}):\n${text}`;
        await addNoteToLead(leadInfo.leadId, noteText);
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

// ===================== KOMMO WEBHOOK =====================
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

      // ---- Определяем leadId / contactId из вебхука ----
      const ids = {
        leadId:
          parsedBody["this_item[id]"] ||
          parsedBody["lead[id]"] ||
          parsedBody["leads[update][0][id]"] ||
          parsedBody["leads[add][0][id]"] ||
          null,
        contactId:
          parsedBody["this_item[_embedded][contacts][0][id]"] ||
          parsedBody["contact[id]"] ||
          parsedBody["contacts[0][id]"] ||
          null,
      };

      console.log("Extracted IDs from Kommo webhook:", ids);

      // ---- Ищем текст ответа ----
      const replyText =
        parsedBody.reply_text ||
        parsedBody["reply_text"] ||
        parsedBody.text ||
        parsedBody["text"] ||
        parsedBody["note[text]"] ||
        parsedBody["this_item[text]"] ||
        parsedBody["message"] ||
        "";

      if (!replyText || !replyText.toString().trim()) {
        console.log(
          "Kommo webhook without reply text (probably system event); nothing to send to LINE."
        );

        // CORS для фронта Kommo
        res.set("Access-Control-Allow-Origin", "*");
        res.set("Access-Control-Allow-Headers", "*");
        res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

        if (req.method === "OPTIONS") {
          return res.status(200).end();
        }

        return res.json({
          ok: true,
          skipped: true,
          reason: "no reply text",
        });
      }

      // ---- Тянем контакт и lineUserId из Kommo ----
      const { lineUserId } = await getKommoContactAndLineUserId(ids);

      console.log("LINE userId from Kommo:", lineUserId);

      if (!lineUserId) {
        console.warn(
          "⚠️ Не удалось найти LINE userId ни в контакте, ни в лиде; ответ в LINE не отправляем."
        );

        res.set("Access-Control-Allow-Origin", "*");
        res.set("Access-Control-Allow-Headers", "*");
        res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

        if (req.method === "OPTIONS") {
          return res.status(200).end();
        }

        return res.json({
          ok: true,
          skipped: true,
          reason: "no lineUserId",
        });
      }

      const finalText = replyText.toString().trim();

      // Отправляем, но не ждём, чтобы не задерживать ответ Emfy
      sendLineMessage(lineUserId, finalText).catch((e) =>
        console.error("sendLineMessage error:", e.message)
      );

      // CORS
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Access-Control-Allow-Headers", "*");
      res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

      if (req.method === "OPTIONS") {
        return res.status(200).end();
      }

      // Отвечаем валидным JSON — этого ждёт виджет Emfy
      res.json({
        ok: true,
        sent: true,
        lineUserId,
        text: finalText,
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

// ===================== START =====================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`line-kommo-bridge is running on port ${PORT}`);
});
