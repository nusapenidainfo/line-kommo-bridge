// index.js
// LINE <-> Kommo bridge (production)
// Основная логика:
// 1) LINE webhook -> найти/создать контакт в Kommo -> найти/создать 1 лид -> добавить note с текстом
// 2) Kommo webhook (Emfy) -> вытащить текст ответа -> найти LINE userId -> отправить сообщение в LINE
//
// Важно:
// - Текст клиента НЕ кладём в name лида
// - 1 контакт = 1 активный лид (в pipeline), дальше только notes
// - Подтягиваем displayName из LINE profile
// - Всегда отвечаем JSON в /kommo/webhook (иначе Emfy ругается)
// - Много логов для диагностики

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const querystring = require("querystring");

const app = express();

/** -------------------- helpers: logging -------------------- */
function rid() {
  return Math.random().toString(36).slice(2, 10);
}
function nowISO() {
  return new Date().toISOString();
}
function log(r, ...args) {
  console.log(`[${nowISO()}] [RID:${r}]`, ...args);
}
function warn(r, ...args) {
  console.warn(`[${nowISO()}] [RID:${r}]`, ...args);
}
function err(r, ...args) {
  console.error(`[${nowISO()}] [RID:${r}]`, ...args);
}

/** -------------------- env helpers -------------------- */
function getKommoSubdomain() {
  return process.env.KOMMO_SUBDOMAIN;
}
function getKommoToken() {
  // поддерживаем оба имени, но приоритет KOMMO_ACCESS_TOKEN
  return process.env.KOMMO_ACCESS_TOKEN || process.env.KOMMO_API_KEY;
}
function getKommoPipelineId() {
  const v = process.env.KOMMO_PIPELINE_ID;
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function maskToken(t) {
  if (!t || typeof t !== "string") return null;
  if (t.length <= 10) return "***";
  return `${t.slice(0, 4)}...${t.slice(-4)}`;
}

/** -------------------- basic routes -------------------- */
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "line-kommo-bridge",
    endpoints: ["/status", "/debug/env", "/debug/kommo", "/debug/line"],
    ts: nowISO(),
  });
});

app.get("/status", (req, res) => {
  res.json({
    ok: true,
    service: "line-kommo-bridge",
    timestamp: nowISO(),
  });
});

app.get("/debug/env", (req, res) => {
  const ktoken = getKommoToken();
  const ltoken = process.env.LINE_CHANNEL_ACCESS_TOKEN;

  res.json({
    ok: true,
    KOMMO_SUBDOMAIN: !!process.env.KOMMO_SUBDOMAIN,
    KOMMO_ACCESS_TOKEN_or_API_KEY: !!ktoken,
    KOMMO_TOKEN_MASK: maskToken(ktoken),
    LINE_CHANNEL_SECRET: !!process.env.LINE_CHANNEL_SECRET,
    LINE_CHANNEL_ACCESS_TOKEN: !!ltoken,
    LINE_TOKEN_MASK: maskToken(ltoken),
    KOMMO_PIPELINE_ID: process.env.KOMMO_PIPELINE_ID || null,
    ts: nowISO(),
  });
});

/** -------------------- LINE signature verify -------------------- */
function verifyLineSignature(bodyString, signature) {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret || !signature) return true; // если не задано — не блокируем
  try {
    const hash = crypto
      .createHmac("sha256", secret)
      .update(bodyString)
      .digest("base64");
    return hash === signature;
  } catch (e) {
    return false;
  }
}

/** -------------------- axios instances -------------------- */
const http = axios.create({
  timeout: 15000,
});

/** -------------------- LINE API -------------------- */
async function lineGetProfile(r, userId) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    warn(r, "[LINE] LINE_CHANNEL_ACCESS_TOKEN missing; cannot get profile");
    return null;
  }
  const url = `https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`;
  try {
    const resp = await http.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    log(r, "[LINE] Profile status:", resp.status);
    return resp.data || null;
  } catch (e) {
    if (e.response) {
      err(r, "[LINE] Profile error:", e.response.status, JSON.stringify(e.response.data));
    } else {
      err(r, "[LINE] Profile request failed:", e.message);
    }
    return null;
  }
}

async function lineGetBotInfo(r) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return { ok: false, error: "LINE_CHANNEL_ACCESS_TOKEN missing" };
  const url = "https://api.line.me/v2/bot/info";
  try {
    const resp = await http.get(url, { headers: { Authorization: `Bearer ${token}` } });
    return { ok: true, status: resp.status, bot: resp.data };
  } catch (e) {
    if (e.response) return { ok: false, status: e.response.status, error: e.response.data };
    return { ok: false, error: e.message };
  }
}

async function linePushMessage(r, to, text) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    err(r, "[LINE] LINE_CHANNEL_ACCESS_TOKEN missing; cannot push message");
    return false;
  }
  const url = "https://api.line.me/v2/bot/message/push";
  const payload = {
    to,
    messages: [{ type: "text", text: String(text || "").slice(0, 5000) }],
  };

  try {
    const resp = await http.post(url, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    log(r, "[LINE] push ok status:", resp.status);
    return true;
  } catch (e) {
    if (e.response) {
      err(r, "[LINE] push error:", e.response.status, JSON.stringify(e.response.data));
    } else {
      err(r, "[LINE] push failed:", e.message);
    }
    return false;
  }
}

app.get("/debug/line", async (req, res) => {
  const r = rid();
  const info = await lineGetBotInfo(r);
  res.json(info);
});

/** -------------------- KOMMO API -------------------- */
async function kommoRequest(r, method, path, { params, data } = {}) {
  const subdomain = getKommoSubdomain();
  const token = getKommoToken();
  if (!subdomain || !token) {
    throw new Error("KOMMO_SUBDOMAIN or KOMMO_ACCESS_TOKEN/KOMMO_API_KEY is missing");
  }

  const url = `https://${subdomain}.kommo.com${path}`;
  try {
    const resp = await http.request({
      method,
      url,
      params,
      data,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });
    return resp;
  } catch (e) {
    if (e.response) {
      err(r, `[KOMMO] ${method} ${path} error`, e.response.status, JSON.stringify(e.response.data));
    } else {
      err(r, `[KOMMO] ${method} ${path} failed`, e.message);
    }
    throw e;
  }
}

app.get("/debug/kommo", async (req, res) => {
  const r = rid();
  try {
    const resp = await kommoRequest(r, "GET", "/api/v4/account");
    res.json({
      ok: true,
      status: resp.status,
      account_id: resp.data?.id || resp.data?.account_id || resp.data?._embedded?.account?.id || null,
      name: resp.data?.name || null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

function buildKommoTags(lineUserId) {
  return [
    { name: "LINE" },
    { name: "LINE_CHAT" },
    { name: `LINE_UID_${lineUserId}` },
  ];
}

function extractLineUserIdFromTagsOrName(obj) {
  // obj может быть contact или lead payload
  // 1) tags: ищем LINE_UID_
  const tags = obj?._embedded?.tags || obj?.tags || [];
  for (const t of tags) {
    const name = t?.name;
    if (typeof name === "string" && name.startsWith("LINE_UID_")) {
      return name.replace("LINE_UID_", "").trim() || null;
    }
  }

  // 2) name: ищем LINE_UID_ или формат userId (обычно "U" + 32 hex)
  const nm = obj?.name;
  if (typeof nm === "string") {
    const m1 = /LINE_UID_([A-Za-z0-9]+)/.exec(nm);
    if (m1 && m1[1]) return m1[1];

    const m2 = /\bU[a-f0-9]{32}\b/i.exec(nm);
    if (m2 && m2[0]) return m2[0];
  }

  return null;
}

async function kommoSearchContactByQuery(r, query) {
  // query должен быть коротким и без спецсимволов
  const q = String(query || "").trim();
  if (!q) return null;

  const resp = await kommoRequest(r, "GET", "/api/v4/contacts", {
    params: { query: q, limit: 5 },
  });

  const items = resp.data?._embedded?.contacts || [];
  if (!Array.isArray(items) || items.length === 0) return null;
  return items[0];
}

async function kommoCreateContact(r, lineUserId, displayName) {
  const safeName = displayName ? String(displayName).trim() : "";
  const name = safeName
    ? `LINE_UID_${lineUserId} | ${safeName}`
    : `LINE_UID_${lineUserId}`;

  const payload = [
    {
      name: name.slice(0, 250),
      _embedded: {
        tags: buildKommoTags(lineUserId),
      },
    },
  ];

  const resp = await kommoRequest(r, "POST", "/api/v4/contacts", { data: payload });
  const created = Array.isArray(resp.data) ? resp.data[0] : null;
  return created || null;
}

async function kommoUpdateContactNameIfNeeded(r, contact, lineUserId, displayName) {
  if (!contact?.id) return contact;
  const safeName = displayName ? String(displayName).trim() : "";
  if (!safeName) return contact;

  const desired = `LINE_UID_${lineUserId} | ${safeName}`.slice(0, 250);
  const current = String(contact.name || "");

  // если current уже содержит displayName — не трогаем
  if (current.includes(safeName)) return contact;

  // если current не содержит LINE_UID — не трогаем (чтобы не ломать чужие контакты)
  if (!current.includes(`LINE_UID_${lineUserId}`)) return contact;

  try {
    const resp = await kommoRequest(r, "PATCH", `/api/v4/contacts/${contact.id}`, {
      data: { name: desired },
    });
    return resp.data || contact;
  } catch (e) {
    warn(r, "[KOMMO] Failed to patch contact name; continue with old name");
    return contact;
  }
}

async function findOrCreateKommoContact(r, lineUserId, displayName) {
  // Ищем контакт по lineUserId
  log(r, "[KOMMO] Search contact by query (lineUserId):", { query: lineUserId });

  let contact = null;
  try {
    contact = await kommoSearchContactByQuery(r, lineUserId);
  } catch (e) {
    // fallback: попробуем по LINE_UID_
    warn(r, "[KOMMO] search by raw userId failed; fallback to LINE_UID_");
    try {
      contact = await kommoSearchContactByQuery(r, `LINE_UID_${lineUserId}`);
    } catch (_) {
      contact = null;
    }
  }

  if (contact?.id) {
    log(r, "[KOMMO] Found existing contact:", { id: contact.id, name: contact.name });
    contact = await kommoUpdateContactNameIfNeeded(r, contact, lineUserId, displayName);
    return contact;
  }

  log(r, "[KOMMO] No contact found; creating new contact...");
  const created = await kommoCreateContact(r, lineUserId, displayName);
  if (created?.id) {
    log(r, "[KOMMO] Contact created:", { id: created.id, name: created.name });
  } else {
    warn(r, "[KOMMO] Contact create returned no id:", created);
  }
  return created;
}

async function kommoFindExistingLeadForContact(r, contactId) {
  const pipelineId = getKommoPipelineId();
  const params = {
    limit: 1,
    // фильтр по контакту
    "filter[contacts][id]": contactId,
  };
  if (pipelineId) params["filter[pipeline_id]"] = pipelineId;

  log(r, "[KOMMO] Searching lead by contactId:", { contactId, pipelineId });

  const resp = await kommoRequest(r, "GET", "/api/v4/leads", { params });
  const leads = resp.data?._embedded?.leads || [];
  if (!Array.isArray(leads) || leads.length === 0) return null;
  return leads[0];
}

async function kommoCreateLeadForContact(r, contactId, displayName, lineUserId) {
  const pipelineId = getKommoPipelineId();
  const leadName = displayName ? `[LINE] ${displayName}` : `[LINE] ${lineUserId}`;

  const payload = [
    {
      name: leadName.slice(0, 250),
      ...(pipelineId ? { pipeline_id: pipelineId } : {}),
      _embedded: {
        contacts: [{ id: contactId }],
        tags: buildKommoTags(lineUserId),
      },
    },
  ];

  log(r, "[KOMMO] Creating new lead:", { leadName, pipelineId, contactId });
  const resp = await kommoRequest(r, "POST", "/api/v4/leads", { data: payload });
  const created = Array.isArray(resp.data) ? resp.data[0] : null;
  return created || null;
}

async function findOrCreateLeadForContact(r, contactId, displayName, lineUserId) {
  const existing = await kommoFindExistingLeadForContact(r, contactId);
  if (existing?.id) {
    log(r, "[KOMMO] Using existing lead:", { id: existing.id, name: existing.name });
    return existing;
  }

  const created = await kommoCreateLeadForContact(r, contactId, displayName, lineUserId);
  if (created?.id) {
    log(r, "[KOMMO] Lead created:", { id: created.id, name: created.name });
  } else {
    warn(r, "[KOMMO] Lead create returned no id:", created);
  }
  return created;
}

async function kommoAddNoteToLead(r, leadId, text) {
  const payload = [
    {
      entity_id: leadId,
      note_type: "common",
      params: { text: String(text || "").slice(0, 5000) },
    },
  ];

  log(r, "[KOMMO] Adding note to lead:", { leadId, textPreview: String(text || "").slice(0, 80) });
  const resp = await kommoRequest(r, "POST", "/api/v4/leads/notes", { data: payload });
  log(r, "[KOMMO] Note created, status:", resp.status);
  return true;
}

/** -------------------- LINE -> KOMMO webhook -------------------- */
app.post("/line/webhook", express.text({ type: "*/*" }), async (req, res) => {
  const r = rid();
  const signature = req.header("x-line-signature");

  if (!verifyLineSignature(req.body, signature)) {
    err(r, "[LINE] Bad signature");
    return res.status(401).json({ ok: false, error: "Bad signature" });
  }

  let data;
  try {
    data = JSON.parse(req.body);
  } catch (e) {
    err(r, "[LINE] Invalid JSON:", e.message);
    return res.status(400).json({ ok: false, error: "Invalid JSON" });
  }

  const events = Array.isArray(data?.events) ? data.events : [];
  if (events.length === 0) {
    log(r, "[LINE] No events");
    return res.json({ ok: true, message: "no events" });
  }

  // быстро отвечаем LINE
  res.json({ ok: true });

  // обработка асинхронно
  setImmediate(async () => {
    try {
      const token = getKommoToken();
      const subdomain = getKommoSubdomain();
      if (!token || !subdomain) {
        warn(r, "[KOMMO] Missing env for Kommo, skip processing LINE->Kommo", {
          KOMMO_SUBDOMAIN: !!subdomain,
          KOMMO_ACCESS_TOKEN_or_API_KEY: !!token,
        });
        return;
      }

      for (const ev of events) {
        if (
          ev?.type === "message" &&
          ev?.message?.type === "text" &&
          typeof ev?.message?.text === "string"
        ) {
          const lineUserId = ev?.source?.userId || ev?.source?.groupId || ev?.source?.roomId;
          const text = ev.message.text.trim();

          if (!lineUserId) {
            warn(r, "[LINE] No userId/groupId/roomId in event.source; skip");
            continue;
          }

          log(r, "[LINE] Incoming message:", { lineUserId, text });

          // 1) профиль LINE (displayName)
          const profile = await lineGetProfile(r, lineUserId);
          const displayName = profile?.displayName ? String(profile.displayName) : null;
          log(r, "[LINE] Profile displayName:", displayName || "(none)");

          // 2) контакт Kommo
          let contact;
          try {
            contact = await findOrCreateKommoContact(r, lineUserId, displayName);
          } catch (e) {
            err(r, "[KOMMO] findOrCreateKommoContact failed; stop this event");
            continue;
          }

          if (!contact?.id) {
            err(r, "[KOMMO] contactId missing after create/find; stop this event");
            continue;
          }

          // 3) 1 лид на контакт
          let lead;
          try {
            lead = await findOrCreateLeadForContact(r, contact.id, displayName, lineUserId);
          } catch (e) {
            err(r, "[KOMMO] findOrCreateLeadForContact failed; stop this event");
            continue;
          }

          if (!lead?.id) {
            err(r, "[KOMMO] leadId missing after create/find; stop this event");
            continue;
          }

          // 4) добавляем note с текстом клиента (а НЕ в name)
          const noteText = displayName
            ? `${displayName} (LINE): ${text}`
            : `LINE message (${lineUserId}): ${text}`;

          try {
            await kommoAddNoteToLead(r, lead.id, noteText);
          } catch (e) {
            err(r, "[KOMMO] add note failed");
          }
        } else {
          log(r, "[LINE] Skip non-text event:", ev?.type || "unknown");
        }
      }
    } catch (e) {
      err(r, "[LINE] Handler crashed:", e.message);
    }
  });
});

/** -------------------- KOMMO -> LINE webhook (Emfy) -------------------- */
function setCors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

function extractKommoIds(parsed) {
  const leadId =
    parsed["this_item[id]"] ||
    parsed["leads[add][0][id]"] ||
    parsed["leads[status][0][id]"] ||
    parsed["leads[update][0][id]"] ||
    parsed["leads[0][id]"];

  const contactId =
    parsed["this_item[_embedded][contacts][0][id]"] ||
    parsed["this_item[contacts][0][id]"] ||
    parsed["contacts[add][0][id]"] ||
    parsed["contacts[update][0][id]"] ||
    parsed["contacts[0][id]"];

  return {
    leadId: leadId ? Number(leadId) : null,
    contactId: contactId ? Number(contactId) : null,
  };
}

function extractKommoReplyText(parsed) {
  // Самые частые варианты ключей (Emfy/Kommo могут отличаться)
  const candidates = [
    "note[text]",
    "note[params][text]",
    "note[0][params][text]",
    "message[text]",
    "message",
    "text",
    "reply",
    "reply_text",
    "comment",
    "note_text",
  ];

  for (const k of candidates) {
    const v = parsed[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }

  // fallback: найдём любой ключ, где есть "text" и значение похоже на сообщение
  for (const [k, v] of Object.entries(parsed)) {
    if (!k) continue;
    if (!/text/i.test(k)) continue;
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (!t) continue;
    if (t.length > 5000) continue;
    return t;
  }

  return null;
}

async function kommoGetContact(r, contactId) {
  const resp = await kommoRequest(r, "GET", `/api/v4/contacts/${contactId}`);
  return resp.data || null;
}

async function kommoGetLead(r, leadId) {
  const resp = await kommoRequest(r, "GET", `/api/v4/leads/${leadId}`);
  return resp.data || null;
}

async function resolveLineUserIdFromKommo(r, { leadId, contactId }) {
  // 1) если есть contactId — берём контакт
  if (contactId) {
    try {
      const c = await kommoGetContact(r, contactId);
      const uid = extractLineUserIdFromTagsOrName(c);
      if (uid) return uid;
    } catch (e) {
      warn(r, "[KOMMO] Cannot load contact to resolve LINE userId");
    }
  }

  // 2) если есть leadId — берём лид, потом его контакты
  if (leadId) {
    try {
      const lead = await kommoGetLead(r, leadId);
      const uidFromLead = extractLineUserIdFromTagsOrName(lead);
      if (uidFromLead) return uidFromLead;

      const contacts = lead?._embedded?.contacts || [];
      const first = Array.isArray(contacts) ? contacts[0] : null;
      const cid = first?.id ? Number(first.id) : null;
      if (cid) {
        const c = await kommoGetContact(r, cid);
        const uid = extractLineUserIdFromTagsOrName(c);
        if (uid) return uid;
      }
    } catch (e) {
      warn(r, "[KOMMO] Cannot load lead/contacts to resolve LINE userId");
    }
  }

  return null;
}

app.all("/kommo/webhook", express.text({ type: "*/*" }), async (req, res) => {
  const r = rid();
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();

  // всегда JSON, чтобы Emfy не ругался
  res.set("Content-Type", "application/json");

  try {
    const raw = typeof req.body === "string" ? req.body : "";
    const parsed = raw ? querystring.parse(raw) : {};

    const ids = extractKommoIds(parsed);
    log(r, "[KOMMO] Webhook received:", {
      method: req.method,
      leadId: ids.leadId,
      contactId: ids.contactId,
      keys: Object.keys(parsed).slice(0, 25), // первые ключи для ориентира
    });

    const replyText = extractKommoReplyText(parsed);

    // Сразу отвечаем Emfy (быстро)
    res.json({ ok: true });

    // Дальше — асинхронно
    setImmediate(async () => {
      try {
        if (!replyText) {
          log(r, "[KOMMO] No reply text in webhook -> nothing to send to LINE");
          return;
        }

        // анти-зацикливание: наши входящие notes назад не шлём
        if (/^\s*LINE message/i.test(replyText) || /\(LINE\):/.test(replyText)) {
          log(r, "[KOMMO] Looks like incoming LINE note -> skip sending back");
          return;
        }

        const token = getKommoToken();
        const subdomain = getKommoSubdomain();
        if (!token || !subdomain) {
          warn(r, "[KOMMO] Missing Kommo creds -> cannot resolve LINE userId for sending");
          return;
        }

        const lineUserId = await resolveLineUserIdFromKommo(r, ids);
        if (!lineUserId) {
          warn(r, "[KOMMO] Could not resolve LINE userId (no LINE_UID tag/name).");
          return;
        }

        log(r, "[LINE] Sending message to user:", { lineUserId, textPreview: replyText.slice(0, 80) });
        await linePushMessage(r, lineUserId, replyText);
      } catch (e) {
        err(r, "[KOMMO->LINE] async handler crashed:", e.message);
      }
    });
  } catch (e) {
    err(r, "[KOMMO] /kommo/webhook error:", e.message);
    // даже при ошибке отдаём JSON
    res.status(200).json({ ok: true });
  }
});

/** -------------------- startup -------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const ktoken = getKommoToken();
  console.log("line-kommo-bridge is running on port", PORT);
  console.log("ENV snapshot:", {
    KOMMO_SUBDOMAIN: !!process.env.KOMMO_SUBDOMAIN,
    KOMMO_ACCESS_TOKEN_or_API_KEY: !!ktoken,
    KOMMO_TOKEN_MASK: maskToken(ktoken),
    KOMMO_PIPELINE_ID: process.env.KOMMO_PIPELINE_ID || null,
    LINE_CHANNEL_SECRET: !!process.env.LINE_CHANNEL_SECRET,
    LINE_CHANNEL_ACCESS_TOKEN: !!process.env.LINE_CHANNEL_ACCESS_TOKEN,
    LINE_TOKEN_MASK: maskToken(process.env.LINE_CHANNEL_ACCESS_TOKEN),
  });
});
