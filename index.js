// index.js
// LINE <-> Kommo bridge
// 1) Входящие сообщения из LINE -> контакт + лид + заметка в Kommo
// 2) Webhook из Kommo (Emfy Webhooks) -> ответ в LINE

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const querystring = require("querystring");

const app = express();

// ---------- ENV ----------

const KOMMO_SUBDOMAIN = process.env.KOMMO_SUBDOMAIN;
const KOMMO_API_KEY = process.env.KOMMO_API_KEY; // long-lived token Kommo
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

function kommoBaseUrl() {
  if (!KOMMO_SUBDOMAIN) {
    throw new Error("KOMMO_SUBDOMAIN is not set");
  }
  return `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4`;
}

function getKommoHeaders() {
  if (!KOMMO_API_KEY) {
    throw new Error("KOMMO_API_KEY is not set");
  }
  return {
    Authorization: `Bearer ${KOMMO_API_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

// ---------- Service status ----------

app.get("/status", (req, res) => {
  res.json({
    ok: true,
    service: "line-kommo-bridge",
    timestamp: new Date().toISOString(),
  });
});

// ---------- LINE helpers ----------

// Проверка подписи от LINE
function verifyLineSignature(bodyString, signature) {
  if (!LINE_CHANNEL_SECRET) {
    console.warn(
      "LINE signature check skipped: LINE_CHANNEL_SECRET is not set"
    );
    return true;
  }
  if (!signature) {
    console.warn("LINE signature is missing");
    return false;
  }
  try {
    const hash = crypto
      .createHmac("sha256", LINE_CHANNEL_SECRET)
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

// Отправка сообщений в LINE
async function sendLineMessage(to, text) {
  if (!LINE_CHANNEL_ACCESS_TOKEN) {
    console.error(
      "LINE_CHANNEL_ACCESS_TOKEN is missing; cannot send message to LINE"
    );
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
    console.log("✅ LINE message sent", { to, status: resp.status });
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

// Профайл пользователя из LINE (displayName)
async function getLineProfile(userId) {
  if (!LINE_CHANNEL_ACCESS_TOKEN) {
    console.warn(
      "Cannot load LINE profile: LINE_CHANNEL_ACCESS_TOKEN is missing"
    );
    return null;
  }

  const url = `https://api.line.me/v2/bot/profile/${encodeURIComponent(
    userId
  )}`;

  try {
    const resp = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      timeout: 8000,
    });
    // { displayName, userId, pictureUrl, statusMessage }
    return resp.data;
  } catch (err) {
    if (err.response) {
      console.error(
        "Error fetching LINE profile:",
        err.response.status,
        JSON.stringify(err.response.data)
      );
    } else {
      console.error("Error fetching LINE profile:", err.message);
    }
    return null;
  }
}

// ---------- Kommo helpers ----------

// Найти контакт по LINE userId (ищем по query — в имени будет userId)
async function findContactByLineUserId(lineUserId) {
  try {
    const url = `${kommoBaseUrl()}/contacts?filter[query]=${encodeURIComponent(
      lineUserId
    )}&limit=1`;

    const resp = await axios.get(url, {
      headers: getKommoHeaders(),
      timeout: 10000,
    });

    const contacts = resp.data?._embedded?.contacts;
    const found =
      Array.isArray(contacts) && contacts.length > 0 ? contacts[0] : null;

    if (found) {
      console.log("👤 Found existing Kommo contact for LINE user:", {
        lineUserId,
        contactId: found.id,
        name: found.name,
      });
    }

    return found;
  } catch (err) {
    if (err.response) {
      console.error(
        "Kommo API error (findContactByLineUserId):",
        err.response.status,
        JSON.stringify(err.response.data)
      );
    } else {
      console.error(
        "Kommo request failed (findContactByLineUserId):",
        err.message
      );
    }
    return null;
  }
}

// Создать контакт в Kommo для нового LINE пользователя
async function createContactForLineUser(lineUserId) {
  const profile = await getLineProfile(lineUserId);
  const displayName = profile?.displayName;

  // Имя: "Artem (LINE Uxxxx)" или "LINE Uxxxx", если имени нет
  const name = displayName
    ? `${displayName} (LINE ${lineUserId})`
    : `LINE ${lineUserId}`;

  const payload = [
    {
      name,
      _embedded: {
        tags: [{ name: "LINE" }],
      },
    },
  ];

  try {
    const url = `${kommoBaseUrl()}/contacts`;
    const resp = await axios.post(url, payload, {
      headers: getKommoHeaders(),
      timeout: 10000,
    });

    const created = Array.isArray(resp.data) ? resp.data[0] : null;

    console.log("🆕 Created Kommo contact for LINE user:", {
      lineUserId,
      contactId: created?.id || null,
      name: created?.name || name,
    });

    return created;
  } catch (err) {
    if (err.response) {
      console.error(
        "Kommo API error (createContactForLineUser):",
        err.response.status,
        JSON.stringify(err.response.data)
      );
    } else {
      console.error(
        "Kommo request failed (createContactForLineUser):",
        err.message
      );
    }
    return null;
  }
}

async function getOrCreateContactForLineUser(lineUserId) {
  let contact = await findContactByLineUserId(lineUserId);
  if (contact) return contact;

  contact = await createContactForLineUser(lineUserId);
  return contact;
}

// Найти последний лид по контакту (используем его, не создаём новые)
async function findLastLeadForContact(contactId) {
  try {
    const url = `${kommoBaseUrl()}/leads?filter[contacts][]=${contactId}&order[created_at]=desc&limit=1`;

    const resp = await axios.get(url, {
      headers: getKommoHeaders(),
      timeout: 10000,
    });

    const leads = resp.data?._embedded?.leads;
    const lead = Array.isArray(leads) && leads.length > 0 ? leads[0] : null;

    if (lead) {
      console.log("📎 Using existing Kommo lead for contact:", {
        contactId,
        leadId: lead.id,
        leadName: lead.name,
      });
    }

    return lead;
  } catch (err) {
    if (err.response) {
      console.error(
        "Kommo API error (findLastLeadForContact):",
        err.response.status,
        JSON.stringify(err.response.data)
      );
    } else {
      console.error(
        "Kommo request failed (findLastLeadForContact):",
        err.message
      );
    }
    return null;
  }
}

// Создать новый лид из первого сообщения в LINE
async function createLeadForLineMessage(contactId, text) {
  const trimmed = (text || "").trim();
  const baseName = trimmed || "New request from LINE";
  const leadName = baseName.slice(0, 250);

  const payload = [
    {
      name: leadName,
      _embedded: {
        contacts: [{ id: contactId }],
        tags: [{ name: "LINE" }],
      },
    },
  ];

  try {
    const url = `${kommoBaseUrl()}/leads`;
    const resp = await axios.post(url, payload, {
      headers: getKommoHeaders(),
      timeout: 10000,
    });

    const created = Array.isArray(resp.data) ? resp.data[0] : null;

    console.log("🆕 Kommo lead created from LINE:", {
      leadId: created?.id || null,
      leadName: created?.name || leadName,
      contactId,
    });

    return created;
  } catch (err) {
    if (err.response) {
      console.error(
        "Kommo API error (createLeadForLineMessage):",
        err.response.status,
        JSON.stringify(err.response.data)
      );
    } else {
      console.error(
        "Kommo request failed (createLeadForLineMessage):",
        err.message
      );
    }
    return null;
  }
}

// Добавить заметку в лид с текстом сообщения клиента
async function addIncomingMessageNoteToLead(leadId, text, lineUserId) {
  const trimmed = (text || "").trim();
  if (!trimmed) return;

  const payload = [
    {
      entity_id: leadId,
      note_type: "common",
      params: {
        text: `LINE message${
          lineUserId ? ` (${lineUserId})` : ""
        }: ${trimmed}`,
      },
    },
  ];

  try {
    const url = `${kommoBaseUrl()}/leads/notes`;
    await axios.post(url, payload, {
      headers: getKommoHeaders(),
      timeout: 10000,
    });
    console.log("📝 Added note to Kommo lead:", { leadId, text: trimmed });
  } catch (err) {
    if (err.response) {
      console.error(
        "Kommo API error (addIncomingMessageNoteToLead):",
        err.response.status,
        JSON.stringify(err.response.data)
      );
    } else {
      console.error(
        "Kommo request failed (addIncomingMessageNoteToLead):",
        err.message
      );
    }
  }
}

// Главный обработчик входящего текстового сообщения из LINE
async function handleIncomingLineText(lineUserId, text) {
  console.log("📩 New LINE message:", { lineUserId, text });

  if (!KOMMO_SUBDOMAIN || !KOMMO_API_KEY) {
    console.error(
      "Kommo credentials are missing; check KOMMO_SUBDOMAIN and KOMMO_API_KEY env vars."
    );
    return;
  }

  const contact = await getOrCreateContactForLineUser(lineUserId);
  if (!contact || !contact.id) {
    console.error("Cannot process LINE message: Kommo contact not found/created");
    return;
  }

  // 1) пытаемся найти последний лид этого контакта
  let lead = await findLastLeadForContact(contact.id);

  // 2) если лида нет — создаём первый
  if (!lead) {
    lead = await createLeadForLineMessage(contact.id, text);
  }

  // 3) добавляем текст клиента в таймлайн лида
  if (lead && lead.id) {
    await addIncomingMessageNoteToLead(lead.id, text, lineUserId);
  }
}

// ---------- LINE webhook ----------

app.post("/line/webhook", express.text({ type: "*/*" }), (req, res) => {
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

  if (!Array.isArray(data.events)) {
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

        if (!lineUserId) {
          console.warn("LINE message without userId/groupId/roomId, skipping");
          continue;
        }

        // Обрабатываем асинхронно, чтобы быстро ответить LINE
        handleIncomingLineText(lineUserId, text).catch((e) =>
          console.error("Error in handleIncomingLineText:", e.message)
        );
      } else {
        console.log("Skipping non-text LINE event");
      }
    } catch (e) {
      console.error("Error while handling LINE event:", e.message);
    }
  }

  // Для LINE важно получить ответ быстро
  res.json({ ok: true });
});

// ---------- Kommo webhook (Emfy Webhooks / LINE Reply) ----------

app.all("/kommo/webhook", express.text({ type: "*/*" }), async (req, res) => {
  // CORS для виджета Kommo
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

    const leadId =
      parsedBody["this_item[id]"] || parsedBody["leads[add][0][id]"] || null;

    const contactId =
      parsedBody["this_item[_embedded][contacts][0][id]"] ||
      parsedBody["contacts[add][0][id]"] ||
      null;

    // Текст, который менеджер написал в виджете
    const candidateTextKeys = [
      "text",
      "message",
      "note",
      "widget[text]",
      "widget[message]",
      "kommo_widget_text",
    ];
    let replyText = "";
    for (const key of candidateTextKeys) {
      if (
        parsedBody[key] &&
        typeof parsedBody[key] === "string" &&
        parsedBody[key].trim()
      ) {
        replyText = parsedBody[key].trim();
        break;
      }
    }
    if (!replyText) {
      replyText = "New reply from Kommo.";
    }

    console.log("Extracted from Kommo webhook →", {
      leadId,
      contactId,
      replyText,
    });

    // Пытаемся найти LINE userId
    let lineUserId = null;

    // 1) Старый формат: "LINE Uxxxx: ...." в имени лида
    const leadName = parsedBody["this_item[name]"];
    if (leadName && typeof leadName === "string") {
      const m = /LINE\s+([^:\s]+)/.exec(leadName);
      if (m) {
        lineUserId = m[1];
      }
    }

    // 2) Если не нашли — тянем контакт из Kommo и ищем "LINE Uxxxx" в имени контакта
    if (!lineUserId && contactId && KOMMO_SUBDOMAIN && KOMMO_API_KEY) {
      try {
        const url = `${kommoBaseUrl()}/contacts/${contactId}`;
        const resp = await axios.get(url, {
          headers: getKommoHeaders(),
          timeout: 10000,
        });
        const contact = resp.data;
        const name = contact?.name || "";
        console.log("Loaded contact from Kommo for reply:", {
          contactId,
          name,
        });

        const m = /LINE\s+([0-9a-zA-Z]+)/.exec(name);
        if (m) {
          lineUserId = m[1];
        }
      } catch (err) {
        if (err.response) {
          console.error(
            "Kommo API error while loading contact for reply:",
            err.response.status,
            JSON.stringify(err.response.data)
          );
        } else {
          console.error(
            "Kommo request failed while loading contact for reply:",
            err.message
          );
        }
      }
    }

    console.log("LINE userId from Kommo for reply:", lineUserId);

    if (lineUserId) {
      await sendLineMessage(lineUserId, replyText);
    } else {
      console.warn(
        "⚠️ Could not find LINE userId (neither in lead name nor contact); reply to LINE was not sent."
      );
    }

    return res.json({
      ok: true,
      message: "kommo webhook received",
      leadId,
      contactId,
      sentToLine: Boolean(lineUserId),
    });
  } catch (err) {
    console.error("Error in /kommo/webhook:", err.message);
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

// ---------- Start server ----------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`line-kommo-bridge is running on port ${PORT}`);
});
