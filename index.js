// index.js
// LINE -> Kommo bridge (stable + verbose logs)
// 1) LINE webhook -> find/create Kommo contact -> find/create ONE lead -> add note with message text
// 2) Kommo webhook (Emfy) -> parse reply text -> find LINE userId via contact tags -> send message to LINE
//
// Требования:
// - Всегда отвечаем Kommo webhook валидным JSON быстро
// - Сообщение клиента НЕ пишем в имя лида (имя лида = [LINE] DisplayName)
// - Для одного LINE пользователя используем ОДИН контакт и ОДИН лид (тег LINE_CHAT)
// - Максимум логов для диагностики

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const querystring = require("querystring");

const app = express();

// ----------------- utils -----------------
function iso() {
  return new Date().toISOString();
}
function rid() {
  return Math.random().toString(36).slice(2, 10);
}
function log(r, ...args) {
  console.log(`[${iso()}] [RID:${r}]`, ...args);
}
function warn(r, ...args) {
  console.warn(`[${iso()}] [RID:${r}]`, ...args);
}
function errlog(r, ...args) {
  console.error(`[${iso()}] [RID:${r}]`, ...args);
}
function maskToken(t) {
  if (!t || typeof t !== "string") return null;
  if (t.length <= 8) return "***";
  return `${t.slice(0, 4)}...${t.slice(-4)}`;
}
function toIntOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ----------------- ENV -----------------
const KOMMO_SUBDOMAIN = process.env.KOMMO_SUBDOMAIN || "";
const KOMMO_TOKEN =
  process.env.KOMMO_ACCESS_TOKEN ||
  process.env.KOMMO_API_KEY ||
  process.env.KOMMO_ACCESS_TOKEN_or_API_KEY ||
  "";
const KOMMO_PIPELINE_ID = toIntOrNull(process.env.KOMMO_PIPELINE_ID);

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";

function kommoReady() {
  return !!(KOMMO_SUBDOMAIN && KOMMO_TOKEN);
}
function lineReady() {
  return !!(LINE_CHANNEL_ACCESS_TOKEN && LINE_CHANNEL_SECRET);
}

// ----------------- Axios clients -----------------
function kommoClient() {
  if (!kommoReady()) {
    throw new Error("Kommo creds missing: KOMMO_SUBDOMAIN and token");
  }
  return axios.create({
    baseURL: `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4`,
    timeout: 15000,
    headers: {
      Authorization: `Bearer ${KOMMO_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
}

function lineClient() {
  if (!LINE_CHANNEL_ACCESS_TOKEN) {
    throw new Error("LINE_CHANNEL_ACCESS_TOKEN is missing");
  }
  return axios.create({
    baseURL: "https://api.line.me",
    timeout: 15000,
    headers: {
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
  });
}

// ----------------- Status & Debug -----------------
app.get("/", (req, res) => {
  res.type("text/plain").send("OK. Use /status, /debug/env, /debug/kommo, /debug/line");
});

app.get("/status", (req, res) => {
  res.json({
    ok: true,
    service: "line-kommo-bridge",
    timestamp: iso(),
  });
});

app.get("/debug/env", (req, res) => {
  res.json({
    ok: true,
    KOMMO_SUBDOMAIN: !!KOMMO_SUBDOMAIN,
    KOMMO_ACCESS_TOKEN_or_API_KEY: !!KOMMO_TOKEN,
    KOMMO_TOKEN_MASK: maskToken(KOMMO_TOKEN),
    LINE_CHANNEL_SECRET: !!LINE_CHANNEL_SECRET,
    LINE_CHANNEL_ACCESS_TOKEN: !!LINE_CHANNEL_ACCESS_TOKEN,
    LINE_TOKEN_MASK: maskToken(LINE_CHANNEL_ACCESS_TOKEN),
    KOMMO_PIPELINE_ID: KOMMO_PIPELINE_ID ? String(KOMMO_PIPELINE_ID) : null,
    ts: iso(),
  });
});

app.get("/debug/kommo", async (req, res) => {
  const r = rid();
  try {
    if (!kommoReady()) {
      return res.status(400).json({ ok: false, error: "Kommo creds missing" });
    }
    const k = kommoClient();
    const resp = await k.get("/account");
    log(r, "[DEBUG] Kommo /account status", resp.status);
    res.json({
      ok: true,
      status: resp.status,
      account_id: resp.data?.id || resp.data?.account_id || null,
      name: resp.data?.name || null,
    });
  } catch (e) {
    errlog(r, "[DEBUG] Kommo error", e?.response?.status, e?.response?.data || e.message);
    res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

app.get("/debug/line", async (req, res) => {
  const r = rid();
  try {
    if (!LINE_CHANNEL_ACCESS_TOKEN) {
      return res.status(400).json({ ok: false, error: "LINE token missing" });
    }
    const l = lineClient();
    const resp = await l.get("/v2/bot/info");
    log(r, "[DEBUG] LINE /v2/bot/info status", resp.status);
    res.json({ ok: true, status: resp.status, bot: resp.data });
  } catch (e) {
    errlog(r, "[DEBUG] LINE error", e?.response?.status, e?.response?.data || e.message);
    res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

// ----------------- LINE signature verify -----------------
function verifyLineSignature(bodyString, signature) {
  const secret = LINE_CHANNEL_SECRET;
  if (!secret || !signature) return false;

  const hash = crypto
    .createHmac("sha256", secret)
    .update(bodyString)
    .digest("base64");

  return hash === signature;
}

// ----------------- Kommo helpers -----------------
function extractCreatedId(data, embeddedKey) {
  // Kommo may return:
  // 1) Array: [{id:...}]
  // 2) { _embedded: { contacts:[{id:...}] } }
  // 3) { id: ... }
  if (!data) return null;

  if (Array.isArray(data) && data[0] && data[0].id) return data[0].id;

  const emb = data?._embedded?.[embeddedKey];
  if (Array.isArray(emb) && emb[0] && emb[0].id) return emb[0].id;

  if (data.id) return data.id;

  return null;
}

async function kommoFindContactByLineUidTag(r, lineUserId) {
  const k = kommoClient();
  const tag = `LINE_UID_${lineUserId}`;

  // В Kommo query ищет по имени/телефону/почте/тегам — мы кладём line uid как тег, значит это работает.
  log(r, "[KOMMO] find contact by query(tag):", tag);

  try {
    const resp = await k.get("/contacts", {
      params: { query: tag, limit: 1 },
    });

    const contacts = resp.data?._embedded?.contacts || resp.data || [];
    const c = Array.isArray(contacts) ? contacts[0] : null;

    if (c?.id) {
      log(r, "[KOMMO] contact found:", { id: c.id, name: c.name });
      return { id: c.id, name: c.name, raw: c };
    }

    log(r, "[KOMMO] contact not found");
    return null;
  } catch (e) {
    errlog(r, "[KOMMO] contact search error:", e?.response?.status, e?.response?.data || e.message);
    return null;
  }
}

async function kommoCreateContact(r, lineUserId, displayName) {
  const k = kommoClient();
  const tagUid = `LINE_UID_${lineUserId}`;

  const name = displayName ? `[LINE] ${displayName}` : `[LINE] ${lineUserId}`;

  const payload = [
    {
      name,
      tags_to_add: [
        { name: "LINE" },
        { name: tagUid },
      ],
    },
  ];

  log(r, "[KOMMO] creating contact:", { name, tags: ["LINE", tagUid] });

  try {
    const resp = await k.post("/contacts", payload);
    const id = extractCreatedId(resp.data, "contacts");

    if (!id) {
      errlog(r, "[KOMMO] contact created but id NOT parsed. Raw response:", JSON.stringify(resp.data).slice(0, 2000));
      return null;
    }

    log(r, "[KOMMO] contact created:", { id, name });
    return { id, name };
  } catch (e) {
    errlog(r, "[KOMMO] create contact error:", e?.response?.status, e?.response?.data || e.message);
    return null;
  }
}

async function kommoGetContactWithLeads(r, contactId) {
  const k = kommoClient();
  try {
    const resp = await k.get(`/contacts/${contactId}`, { params: { with: "leads" } });
    return resp.data || null;
  } catch (e) {
    errlog(r, "[KOMMO] get contact error:", e?.response?.status, e?.response?.data || e.message);
    return null;
  }
}

function hasTag(entity, tagName) {
  const tags = entity?._embedded?.tags || entity?.tags || [];
  if (!Array.isArray(tags)) return false;
  return tags.some((t) => (t?.name || "").toLowerCase() === tagName.toLowerCase());
}

async function kommoCreateLeadForContact(r, contactId, leadName) {
  const k = kommoClient();

  const payload = [
    {
      name: leadName || "[LINE] Chat",
      ...(KOMMO_PIPELINE_ID ? { pipeline_id: KOMMO_PIPELINE_ID } : {}),
      tags_to_add: [{ name: "LINE" }, { name: "LINE_CHAT" }],
      _embedded: {
        contacts: [{ id: contactId }],
      },
    },
  ];

  log(r, "[KOMMO] creating LINE_CHAT lead:", {
    name: payload[0].name,
    pipeline_id: KOMMO_PIPELINE_ID || "(auto)",
    contactId,
  });

  try {
    const resp = await k.post("/leads", payload);
    const id = extractCreatedId(resp.data, "leads");

    if (!id) {
      errlog(r, "[KOMMO] lead created but id NOT parsed. Raw response:", JSON.stringify(resp.data).slice(0, 2000));
      return null;
    }

    log(r, "[KOMMO] lead created:", { id, name: payload[0].name });
    return { id, name: payload[0].name };
  } catch (e) {
    errlog(r, "[KOMMO] create lead error:", e?.response?.status, e?.response?.data || e.message);
    return null;
  }
}

async function kommoFindOrCreateLeadForContact(r, contactId, suggestedLeadName) {
  // 1) пробуем взять лид из contact.with=leads
  const contact = await kommoGetContactWithLeads(r, contactId);
  const leads = contact?._embedded?.leads || [];

  if (Array.isArray(leads) && leads.length > 0) {
    // предпочтительно: LINE_CHAT + (pipeline match если задан)
    let picked =
      leads.find((l) => hasTag(l, "LINE_CHAT") && (!KOMMO_PIPELINE_ID || l.pipeline_id === KOMMO_PIPELINE_ID)) ||
      leads.find((l) => hasTag(l, "LINE_CHAT")) ||
      leads.find((l) => !KOMMO_PIPELINE_ID || l.pipeline_id === KOMMO_PIPELINE_ID) ||
      leads[0];

    if (picked?.id) {
      log(r, "[KOMMO] using existing lead:", { id: picked.id, name: picked.name, pipeline_id: picked.pipeline_id });
      return { id: picked.id, name: picked.name };
    }
  }

  // 2) иначе создаём новый LINE_CHAT lead
  return await kommoCreateLeadForContact(r, contactId, suggestedLeadName);
}

async function kommoAddNoteToLead(r, leadId, text) {
  const k = kommoClient();

  const safeText = String(text || "").slice(0, 3500);

  const payload = [
    {
      note_type: "common",
      params: { text: safeText },
    },
  ];

  log(r, "[KOMMO] add note:", { leadId, textPreview: safeText.slice(0, 120) });

  try {
    const resp = await k.post(`/leads/${leadId}/notes`, payload);
    log(r, "[KOMMO] note created status:", resp.status);
    return true;
  } catch (e) {
    errlog(r, "[KOMMO] add note error:", e?.response?.status, e?.response?.data || e.message);
    return false;
  }
}

// ----------------- LINE helpers -----------------
async function lineGetProfile(r, userId) {
  try {
    const l = lineClient();
    const resp = await l.get(`/v2/bot/profile/${encodeURIComponent(userId)}`);
    const profile = resp.data || null;
    log(r, "👤 LINE profile:", {
      userId,
      displayName: profile?.displayName,
      statusMessage: profile?.statusMessage,
    });
    return profile;
  } catch (e) {
    // profile API может быть недоступен если user not friend — но у тебя уже работает
    warn(r, "LINE profile error:", e?.response?.status, e?.response?.data || e.message);
    return null;
  }
}

async function linePushText(r, to, text) {
  try {
    const l = lineClient();
    const payload = {
      to,
      messages: [{ type: "text", text: String(text || "").slice(0, 4900) }],
    };
    const resp = await l.post("/v2/bot/message/push", payload);
    log(r, "✅ LINE push ok:", { to, status: resp.status });
    return true;
  } catch (e) {
    errlog(r, "❌ LINE push error:", e?.response?.status, e?.response?.data || e.message);
    return false;
  }
}

// ----------------- LINE webhook -----------------
app.post("/line/webhook", express.text({ type: "*/*" }), async (req, res) => {
  const r = rid();

  const signature = req.header("x-line-signature");
  const rawBody = req.body;

  // Быстрый ответ LINE (чтобы не было таймаутов)
  res.json({ ok: true });

  if (!rawBody || typeof rawBody !== "string") {
    warn(r, "LINE webhook: empty/non-string body");
    return;
  }

  if (!signature) {
    warn(r, "LINE webhook: missing x-line-signature header");
    return;
  }

  const sigOk = verifyLineSignature(rawBody, signature);
  if (!sigOk) {
    errlog(r, "LINE webhook: signature mismatch. Check LINE_CHANNEL_SECRET.");
    return;
  }

  let data;
  try {
    data = JSON.parse(rawBody);
  } catch (e) {
    errlog(r, "LINE webhook: JSON parse error:", e.message);
    return;
  }

  const events = Array.isArray(data?.events) ? data.events : [];
  log(r, "📩 LINE events count:", events.length);

  for (const ev of events) {
    try {
      const type = ev?.type;
      const msgType = ev?.message?.type;
      const text = ev?.message?.text;

      const source = ev?.source || {};
      const lineUserId = source.userId || source.groupId || source.roomId || null;

      log(r, "LINE event:", {
        type,
        msgType,
        hasText: typeof text === "string",
        lineUserId,
        mode: ev?.mode,
        timestamp: ev?.timestamp,
      });

      if (type !== "message" || msgType !== "text" || !lineUserId) continue;

      const cleanText = String(text || "").trim();
      if (!cleanText) continue;

      log(r, "✅ New LINE text:", { lineUserId, text: cleanText });

      if (!kommoReady()) {
        errlog(r, "⚠️ KOMMO creds missing -> cannot send to Kommo");
        continue;
      }

      // 1) profile (displayName)
      const profile = await lineGetProfile(r, lineUserId);
      const displayName = profile?.displayName || null;

      // 2) contact find/create
      let contact = await kommoFindContactByLineUidTag(r, lineUserId);
      if (!contact) {
        contact = await kommoCreateContact(r, lineUserId, displayName);
      } else {
        // если нашли контакт, но имя "старое", можем обновить (не обязательно)
        // оставим как есть — чтобы не ломать ручные правки
      }

      if (!contact?.id) {
        errlog(r, "❌ Could not get/create Kommo contact -> stop");
        continue;
      }

      // 3) lead find/create (ONE lead per contact)
      const leadName = displayName ? `[LINE] ${displayName}` : "[LINE] Chat";
      const lead = await kommoFindOrCreateLeadForContact(r, contact.id, leadName);

      if (!lead?.id) {
        errlog(r, "❌ Could not get/create Kommo lead -> stop");
        continue;
      }

      // 4) add note with message text (timeline)
      const noteText = displayName
        ? `${displayName}: ${cleanText}`
        : `LINE user (${lineUserId}): ${cleanText}`;

      await kommoAddNoteToLead(r, lead.id, noteText);
    } catch (e) {
      errlog(r, "LINE event processing error:", e.message);
    }
  }
});

// ----------------- Kommo webhook (Emfy) -----------------
function pickFirstString(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function extractContactIdFromKommoWebhook(parsedBody) {
  return (
    parsedBody["this_item[_embedded][contacts][0][id]"] ||
    parsedBody["contacts[0][id]"] ||
    parsedBody["this_item[contact_id]"] ||
    parsedBody["contact_id"] ||
    ""
  );
}

function extractLeadIdFromKommoWebhook(parsedBody) {
  return (
    parsedBody["this_item[id]"] ||
    parsedBody["leads[add][0][id]"] ||
    parsedBody["lead_id"] ||
    ""
  );
}

async function kommoGetContact(r, contactId) {
  const k = kommoClient();
  try {
    const resp = await k.get(`/contacts/${contactId}`);
    return resp.data || null;
  } catch (e) {
    errlog(r, "[KOMMO] get contact for reply error:", e?.response?.status, e?.response?.data || e.message);
    return null;
  }
}

function extractLineUserIdFromContact(contact) {
  const tags = contact?._embedded?.tags || [];
  if (!Array.isArray(tags)) return null;

  for (const t of tags) {
    const name = t?.name || "";
    if (name.startsWith("LINE_UID_")) return name.replace("LINE_UID_", "");
  }
  return null;
}

app.all("/kommo/webhook", express.text({ type: "*/*" }), async (req, res) => {
  const r = rid();

  // CORS + JSON response ALWAYS
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(200).json({ ok: true, preflight: true });
  }

  // Отдаём JSON сразу (Emfy не любит ждать)
  res.json({ ok: true, ts: iso() });

  try {
    const raw = typeof req.body === "string" ? req.body : "";
    const parsedBody = raw ? querystring.parse(raw) : {};

    const keys = Object.keys(parsedBody || {});
    log(r, "==== KOMMO webhook ====");
    log(r, "Method:", req.method);
    log(r, "Keys count:", keys.length);
    log(r, "Keys sample:", keys.slice(0, 40));

    const contactId = String(extractContactIdFromKommoWebhook(parsedBody) || "");
    const leadId = String(extractLeadIdFromKommoWebhook(parsedBody) || "");
    log(r, "Extracted IDs:", { leadId: leadId || null, contactId: contactId || null });

    // Текст ответа ищем в нескольких местах (зависит от настроек Emfy)
    const replyText = pickFirstString(parsedBody, [
      "reply_text",
      "text",
      "message",
      "note[text]",
      "this_item[text]",
      "this_item[note_text]",
      "this_item[comment]",
      "comment",
    ]);

    if (!replyText) {
      log(r, "Kommo webhook without reply text -> skip sending to LINE");
      return;
    }

    if (!kommoReady()) {
      errlog(r, "Kommo creds missing -> cannot resolve LINE userId for reply");
      return;
    }
    if (!LINE_CHANNEL_ACCESS_TOKEN) {
      errlog(r, "LINE token missing -> cannot send reply");
      return;
    }

    if (!contactId) {
      errlog(r, "No contactId in Kommo webhook -> cannot send reply");
      return;
    }

    const contact = await kommoGetContact(r, contactId);
    const lineUserId = extractLineUserIdFromContact(contact);

    log(r, "LINE userId resolved from contact tags:", lineUserId);

    if (!lineUserId) {
      errlog(r, "No LINE userId tag on contact -> cannot send reply");
      return;
    }

    await linePushText(r, lineUserId, replyText);
  } catch (e) {
    errlog(r, "Error in /kommo/webhook:", e.message);
  }
});

// ----------------- start -----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[${iso()}] line-kommo-bridge is running on port ${PORT}`);
});
