// index.js
// LINE <-> Kommo bridge
// 1) LINE webhook -> Kommo: find/create Contact, find/create 1 "chat lead" per contact, add NOTE with client message
// 2) Kommo webhook (Emfy button) -> LINE: reads custom field "LINE Reply", sends to LINE, clears the field
//
// ENV (Render):
// - KOMMO_SUBDOMAIN                (e.g. andriecas)
// - KOMMO_ACCESS_TOKEN             (long-lived token)
// - KOMMO_PIPELINE_ID              (optional) e.g. 3153064
// - KOMMO_STATUS_ID                (optional)
// - KOMMO_LINE_REPLY_FIELD_ID      (ID of the custom text field "LINE Reply" in leads)
// - LINE_CHANNEL_SECRET
// - LINE_CHANNEL_ACCESS_TOKEN

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const querystring = require("querystring");

const app = express();

// -------------------- helpers --------------------
function isoNow() {
  return new Date().toISOString();
}

function makeRid() {
  return Math.random().toString(36).slice(2, 10);
}

function maskToken(t) {
  if (!t || typeof t !== "string") return null;
  if (t.length <= 8) return "***";
  return `${t.slice(0, 4)}...${t.slice(-4)}`;
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function log(rid, ...args) {
  console.log(`[${isoNow()}] [RID:${rid}]`, ...args);
}

function warn(rid, ...args) {
  console.warn(`[${isoNow()}] [RID:${rid}]`, ...args);
}

function errlog(rid, ...args) {
  console.error(`[${isoNow()}] [RID:${rid}]`, ...args);
}

// -------------------- ENV --------------------
function getKommoToken() {
  return process.env.KOMMO_ACCESS_TOKEN || process.env.KOMMO_API_KEY || "";
}

function getKommoSubdomain() {
  return process.env.KOMMO_SUBDOMAIN || "";
}

function getLineToken() {
  return process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
}

function getLineSecret() {
  return process.env.LINE_CHANNEL_SECRET || "";
}

// ID кастомного поля "LINE Reply" в лидах Kommo
function getLineReplyFieldId() {
  return toInt(process.env.KOMMO_LINE_REPLY_FIELD_ID);
}

const TAG_LINE = "LINE";
const TAG_LINE_CHAT = "LINE_CHAT";
const TAG_LINE_UID_PREFIX = "LINE_UID_";

// -------------------- in-memory debug state --------------------
const STATE = {
  lastLineWebhook: null,
  lastKommoWebhook: null,
};

// -------------------- routes: basic --------------------
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "line-kommo-bridge",
    endpoints: [
      "/status",
      "/line/webhook",
      "/kommo/webhook",
      "/debug/env",
      "/debug/kommo",
      "/debug/line",
      "/debug/last-line",
      "/debug/last-kommo",
      "/debug/fields",
    ],
    ts: isoNow(),
  });
});

app.get("/status", (req, res) => {
  res.json({ ok: true, service: "line-kommo-bridge", timestamp: isoNow() });
});

app.get("/debug/env", (req, res) => {
  const kommoToken = getKommoToken();
  const lineToken = getLineToken();
  res.json({
    ok: true,
    KOMMO_SUBDOMAIN: !!getKommoSubdomain(),
    KOMMO_ACCESS_TOKEN_or_API_KEY: !!kommoToken,
    KOMMO_TOKEN_MASK: maskToken(kommoToken),
    LINE_CHANNEL_SECRET: !!getLineSecret(),
    LINE_CHANNEL_ACCESS_TOKEN: !!lineToken,
    LINE_TOKEN_MASK: maskToken(lineToken),
    KOMMO_PIPELINE_ID: process.env.KOMMO_PIPELINE_ID || null,
    KOMMO_STATUS_ID: process.env.KOMMO_STATUS_ID || null,
    KOMMO_LINE_REPLY_FIELD_ID: process.env.KOMMO_LINE_REPLY_FIELD_ID || null,
    ts: isoNow(),
  });
});

// Помогает найти ID кастомного поля "LINE Reply"
app.get("/debug/fields", async (req, res) => {
  const rid = makeRid();
  try {
    const data = await kommoGet("/leads/custom_fields", {}, rid);
    const fields = data?._embedded?.custom_fields || [];
    res.json({
      ok: true,
      count: fields.length,
      fields: fields.map((f) => ({ id: f.id, name: f.name, type: f.type })),
      rid,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      rid,
      error: e?.response?.status
        ? `HTTP ${e.response.status}: ${JSON.stringify(e.response.data)}`
        : e.message,
    });
  }
});

app.get("/debug/kommo", async (req, res) => {
  const rid = makeRid();
  try {
    const sub = getKommoSubdomain();
    const tok = getKommoToken();
    if (!sub || !tok) {
      return res.status(400).json({ ok: false, error: "Kommo env is missing" });
    }
    const url = `https://${sub}.kommo.com/api/v4/account`;
    const r = await axios.get(url, {
      headers: { Authorization: `Bearer ${tok}`, Accept: "application/json" },
      timeout: 10000,
    });
    res.json({ ok: true, status: r.status, account_id: r.data?.id, name: r.data?.name, rid });
  } catch (e) {
    res.status(500).json({
      ok: false, rid,
      error: e?.response?.status
        ? `HTTP ${e.response.status}: ${JSON.stringify(e.response.data)}`
        : e.message,
    });
  }
});

app.get("/debug/line", async (req, res) => {
  const rid = makeRid();
  try {
    const tok = getLineToken();
    if (!tok) return res.status(400).json({ ok: false, error: "LINE token missing" });
    const r = await axios.get("https://api.line.me/v2/bot/info", {
      headers: { Authorization: `Bearer ${tok}` },
      timeout: 10000,
    });
    res.json({ ok: true, status: r.status, bot: r.data, rid });
  } catch (e) {
    res.status(500).json({
      ok: false, rid,
      error: e?.response?.status
        ? `HTTP ${e.response.status}: ${JSON.stringify(e.response.data)}`
        : e.message,
    });
  }
});

app.get("/debug/last-line", (req, res) => {
  res.json({ ok: true, lastLineWebhook: STATE.lastLineWebhook || null, ts: isoNow() });
});

app.get("/debug/last-kommo", (req, res) => {
  res.json({ ok: true, lastKommoWebhook: STATE.lastKommoWebhook || null, ts: isoNow() });
});

// -------------------- LINE signature verify --------------------
function verifyLineSignature(bodyString, signature) {
  const secret = getLineSecret();
  if (!secret || !signature) return true;
  try {
    const hash = crypto.createHmac("sha256", secret).update(bodyString).digest("base64");
    return hash === signature;
  } catch {
    return false;
  }
}

// -------------------- LINE API --------------------
async function getLineProfile(lineUserId, rid) {
  const tok = getLineToken();
  if (!tok) return null;
  try {
    const url = `https://api.line.me/v2/bot/profile/${encodeURIComponent(lineUserId)}`;
    const r = await axios.get(url, {
      headers: { Authorization: `Bearer ${tok}` },
      timeout: 10000,
    });
    const profile = r.data || null;
    if (profile) {
      log(rid, "👤 LINE profile:", {
        userId: profile.userId,
        displayName: profile.displayName,
      });
    }
    return profile;
  } catch (e) {
    warn(rid, "Could not fetch LINE profile:", e?.response?.status ? `HTTP ${e.response.status}` : e.message);
    return null;
  }
}

async function sendLinePush(to, text, rid) {
  const tok = getLineToken();
  if (!tok) {
    errlog(rid, "LINE_CHANNEL_ACCESS_TOKEN missing -> cannot send");
    return { ok: false, error: "LINE token missing" };
  }
  const payload = { to, messages: [{ type: "text", text }] };
  try {
    const r = await axios.post("https://api.line.me/v2/bot/message/push", payload, {
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      timeout: 10000,
    });
    log(rid, "✅ LINE push sent:", { to, status: r.status });
    return { ok: true };
  } catch (e) {
    const details = e?.response?.data ? JSON.stringify(e.response.data) : e.message;
    errlog(rid, "❌ LINE push error:", e?.response?.status ? `HTTP ${e.response.status}` : "", details);
    return { ok: false, error: details };
  }
}

// -------------------- KOMMO API --------------------
function kommoBaseUrl() {
  const sub = getKommoSubdomain();
  if (!sub) return "";
  return `https://${sub}.kommo.com/api/v4`;
}

function kommoHeaders() {
  return {
    Authorization: `Bearer ${getKommoToken()}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function kommoGet(path, params, rid) {
  const base = kommoBaseUrl();
  if (!base || !getKommoToken()) throw new Error("KOMMO creds missing");
  const r = await axios.get(`${base}${path}`, {
    headers: kommoHeaders(),
    params: params || {},
    timeout: 15000,
  });
  return r.data;
}

async function kommoPost(path, data, rid) {
  const base = kommoBaseUrl();
  if (!base || !getKommoToken()) throw new Error("KOMMO creds missing");
  const r = await axios.post(`${base}${path}`, data, {
    headers: kommoHeaders(),
    timeout: 15000,
  });
  return r.data;
}

async function kommoPatch(path, data, rid) {
  const base = kommoBaseUrl();
  if (!base || !getKommoToken()) throw new Error("KOMMO creds missing");
  const r = await axios.patch(`${base}${path}`, data, {
    headers: kommoHeaders(),
    timeout: 15000,
  });
  return r.data;
}

// -------------------- Kommo helpers --------------------
function contactHasTag(contact, tagName) {
  const tags = contact?._embedded?.tags || [];
  return tags.some((t) => t?.name === tagName);
}

function extractLineUserIdFromContact(contact) {
  const tags = contact?._embedded?.tags || [];
  for (const t of tags) {
    const n = t?.name || "";
    if (n.startsWith(TAG_LINE_UID_PREFIX)) {
      return n.slice(TAG_LINE_UID_PREFIX.length);
    }
  }
  return null;
}

async function findKommoContactByLineUserId(lineUserId, rid) {
  const q = `${TAG_LINE_UID_PREFIX}${lineUserId}`;
  log(rid, "[KOMMO] find contact by query:", q);
  const data = await kommoGet("/contacts", { query: q, limit: 10, with: "tags" }, rid);
  const contacts = data?._embedded?.contacts || [];
  if (!contacts.length) return null;
  return contacts.find((c) => contactHasTag(c, q)) || contacts[0];
}

async function createKommoContactFromLine(lineUserId, profile, rid) {
  const displayName = profile?.displayName || `LINE ${lineUserId}`;
  const name = `[LINE] ${displayName}`.slice(0, 250);
  const tags = [{ name: TAG_LINE }, { name: `${TAG_LINE_UID_PREFIX}${lineUserId}` }];
  const payload = [{ name, _embedded: { tags } }];
  log(rid, "[KOMMO] creating contact:", { name });
  const created = await kommoPost("/contacts", payload, rid);
  return (Array.isArray(created) ? created[0] : null) || null;
}

async function ensureKommoContact(lineUserId, profile, rid) {
  let contact = null;
  try {
    contact = await findKommoContactByLineUserId(lineUserId, rid);
  } catch (e) {
    errlog(rid, "[KOMMO] Error searching contacts:", e?.response?.status ? `HTTP ${e.response.status}` : e.message);
  }

  if (!contact) {
    try {
      contact = await createKommoContactFromLine(lineUserId, profile, rid);
      log(rid, "✅ Kommo contact created:", { id: contact?.id, name: contact?.name });
    } catch (e) {
      errlog(rid, "[KOMMO] Failed to create contact:", e?.response?.status ? `HTTP ${e.response.status}` : e.message);
      return null;
    }
  } else {
    log(rid, "[KOMMO] contact found:", { id: contact.id, name: contact.name });
    const displayName = profile?.displayName;
    if (displayName) {
      const desired = `[LINE] ${displayName}`.slice(0, 250);
      if (contact.name !== desired) {
        try {
          await kommoPatch("/contacts", [{ id: contact.id, name: desired }], rid);
          log(rid, "[KOMMO] contact name updated:", desired);
        } catch (e) {
          warn(rid, "[KOMMO] could not update contact name:", e.message);
        }
      }
    }
  }
  return contact;
}

function leadHasTag(lead, tagName) {
  const tags = lead?._embedded?.tags || [];
  return tags.some((t) => t?.name === tagName);
}

async function findLeadsByContact(contactId, rid) {
  const params = {
    "filter[contacts][id]": contactId,
    limit: 50,
    with: "contacts,tags",
    "order[updated_at]": "desc",
  };
  const pipelineId = toInt(process.env.KOMMO_PIPELINE_ID);
  if (pipelineId) params["filter[pipeline_id]"] = pipelineId;
  const data = await kommoGet("/leads", params, rid);
  return data?._embedded?.leads || [];
}

async function createLineChatLead(contactId, profile, lineUserId, rid) {
  const displayName = profile?.displayName || `LINE ${lineUserId}`;
  const pipelineId = toInt(process.env.KOMMO_PIPELINE_ID);
  const statusId = toInt(process.env.KOMMO_STATUS_ID);
  const leadName = `[LINE] ${displayName}`.slice(0, 250);
  const tags = [{ name: TAG_LINE }, { name: TAG_LINE_CHAT }];
  const lead = {
    name: leadName,
    _embedded: { contacts: [{ id: contactId }], tags },
  };
  if (pipelineId) lead.pipeline_id = pipelineId;
  if (statusId) lead.status_id = statusId;
  const created = await kommoPost("/leads", [lead], rid);
  return (Array.isArray(created) ? created[0] : null) || null;
}

async function ensureLineChatLead(contactId, profile, lineUserId, rid) {
  let leads = [];
  try {
    leads = await findLeadsByContact(contactId, rid);
  } catch (e) {
    errlog(rid, "[KOMMO] Error searching leads:", e?.response?.status ? `HTTP ${e.response.status}` : e.message);
  }

  if (leads.length) {
    const chatLead = leads.find((l) => leadHasTag(l, TAG_LINE_CHAT));
    const picked = chatLead || leads[0];
    log(rid, "[KOMMO] using existing lead:", { id: picked.id, name: picked.name });
    return picked;
  }

  try {
    const newLead = await createLineChatLead(contactId, profile, lineUserId, rid);
    log(rid, "✅ LINE_CHAT lead created:", { id: newLead?.id, name: newLead?.name });
    return newLead;
  } catch (e) {
    errlog(rid, "[KOMMO] Failed to create lead:", e?.response?.status ? `HTTP ${e.response.status}` : e.message);
    return null;
  }
}

async function addLeadNote(leadId, text, rid) {
  const payload = [{ entity_id: leadId, note_type: "common", params: { text } }];
  log(rid, "[KOMMO] add note:", { leadId, textPreview: String(text).slice(0, 80) });
  return await kommoPost("/leads/notes", payload, rid);
}

async function getKommoContactById(contactId, rid) {
  return await kommoGet(`/contacts/${contactId}`, { with: "tags" }, rid);
}

async function getKommoLeadById(leadId, rid) {
  return await kommoGet(`/leads/${leadId}`, { with: "contacts,tags,custom_fields" }, rid);
}

// -------------------- Читаем кастомное поле LINE Reply из лида --------------------
// Emfy передаёт кастомные поля двумя способами:
// 1) this_item[custom_fields_values][N][field_id] + this_item[custom_fields_values][N][values][0][value]
// 2) В виде JSON если это JSON-вебхук
function extractLineReplyFromCustomFields(parsed, rid) {
  const fieldId = getLineReplyFieldId();

  // --- Способ 1: querystring-формат от Emfy ---
  // this_item[custom_fields_values][0][field_id] = 12345
  // this_item[custom_fields_values][0][values][0][value] = "текст"
  // Ищем по fieldId если он задан, иначе ищем поле с именем LINE_Reply/LINE Reply
  const keys = Object.keys(parsed || {});

  // Собираем индексы кастомных полей
  const cfIndexes = new Set();
  for (const k of keys) {
    const m = k.match(/^this_item\[custom_fields_values\]\[(\d+)\]/);
    if (m) cfIndexes.add(m[1]);
  }

  for (const idx of cfIndexes) {
    const fid = toInt(parsed[`this_item[custom_fields_values][${idx}][field_id]`]);
    const fname = parsed[`this_item[custom_fields_values][${idx}][field_name]`] || "";
    const val = parsed[`this_item[custom_fields_values][${idx}][values][0][value]`];

    if (!isNonEmptyString(val)) continue;

    // Если fieldId задан — ищем точное совпадение
    if (fieldId && fid === fieldId) {
      log(rid, `[CF] Found LINE Reply by field_id ${fieldId}:`, val);
      return { text: val.trim(), cfIndex: idx, fieldId: fid };
    }

    // Иначе ищем по названию поля
    if (!fieldId) {
      const nameL = fname.toLowerCase().replace(/[\s_-]/g, "");
      if (nameL.includes("linereply") || nameL.includes("lineответ") || nameL.includes("lineмесс")) {
        log(rid, `[CF] Found LINE Reply by field_name "${fname}":`, val);
        return { text: val.trim(), cfIndex: idx, fieldId: fid };
      }
    }
  }

  // --- Способ 2: прямые ключи для известных имён полей ---
  // иногда Emfy делает ключ типа: this_item[LINE Reply] или this_item[line_reply]
  for (const k of keys) {
    const kl = k.toLowerCase().replace(/[\s_\[\]]/g, "");
    if (kl.includes("linereply") || kl.includes("lineответ")) {
      const v = parsed[k];
      if (isNonEmptyString(v)) {
        log(rid, `[CF] Found LINE Reply by flat key "${k}":`, v);
        return { text: v.trim(), cfIndex: null, fieldId: null };
      }
    }
  }

  return null;
}

// Очищаем поле LINE Reply после отправки (чтобы не слать дубли)
async function clearLineReplyField(leadId, fieldId, rid) {
  if (!leadId || !fieldId) return;
  try {
    await kommoPatch("/leads", [
      {
        id: toInt(leadId),
        custom_fields_values: [
          { field_id: fieldId, values: [{ value: "" }] },
        ],
      },
    ], rid);
    log(rid, "[KOMMO] LINE Reply field cleared:", { leadId, fieldId });
  } catch (e) {
    warn(rid, "[KOMMO] Could not clear LINE Reply field:", e?.response?.status ? `HTTP ${e.response.status}` : e.message);
  }
}

// -------------------- LINE webhook --------------------
app.post("/line/webhook", express.text({ type: "*/*" }), (req, res) => {
  const rid = makeRid();
  const signature = req.header("x-line-signature") || "";
  res.json({ ok: true });

  setImmediate(async () => {
    try {
      const raw = req.body || "";
      if (!verifyLineSignature(raw, signature)) {
        errlog(rid, "Bad LINE signature");
        return;
      }

      const data = safeJsonParse(raw);
      if (!data || !Array.isArray(data.events)) {
        warn(rid, "LINE webhook: no events / invalid JSON");
        return;
      }

      STATE.lastLineWebhook = {
        rid, at: isoNow(),
        eventsCount: data.events.length,
        firstEventType: data.events[0]?.type || null,
      };

      log(rid, "LINE events count:", data.events.length);

      for (const ev of data.events) {
        const evType = ev?.type;
        const msgType = ev?.message?.type;
        log(rid, "LINE event:", { type: evType, msgType, mode: ev?.mode });

        if (evType !== "message" || msgType !== "text") continue;

        const text = (ev.message.text || "").trim();
        if (!text) continue;

        const source = ev.source || {};
        const lineUserId = source.userId || source.groupId || source.roomId || "unknown";
        log(rid, "✅ New LINE text:", { lineUserId, text });

        const profile = await getLineProfile(lineUserId, rid);
        const contact = await ensureKommoContact(lineUserId, profile, rid);
        if (!contact?.id) { warn(rid, "⚠️ Kommo contact missing -> stop"); continue; }

        const lead = await ensureLineChatLead(contact.id, profile, lineUserId, rid);
        if (!lead?.id) { warn(rid, "⚠️ leadId missing -> stop"); continue; }

        const displayName = profile?.displayName || "Client";
        await addLeadNote(lead.id, `${displayName}: ${text}`, rid);

        log(rid, "✅ Done LINE->Kommo:", { contactId: contact.id, leadId: lead.id });
      }
    } catch (e) {
      errlog(rid, "Unhandled error in LINE webhook:", e.message);
    }
  });
});

// -------------------- Kommo webhook (Emfy button) --------------------
function setCors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

function extractIdsFromKommo(parsed) {
  // Emfy sends this_item[id] for the lead
  const leadId =
    parsed["leads[add][0][id]"] ||
    parsed["this_item[id]"] ||
    parsed["lead[id]"] ||
    parsed["lead_id"] ||
    parsed["id"] ||
    null;

  // Contact id
  const contactId =
    parsed["this_item[_embedded][contacts][0][id]"] ||
    parsed["this_item[main_contact][id]"] ||
    parsed["contacts[add][0][id]"] ||
    parsed["contact[id]"] ||
    parsed["contact_id"] ||
    null;

  return {
    leadId: leadId ? String(leadId) : null,
    contactId: contactId ? String(contactId) : null,
  };
}

app.all("/kommo/webhook", express.text({ type: "*/*" }), (req, res) => {
  const rid = makeRid();
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();

  // Быстро отдаём JSON чтобы Emfy не ругался на timeout
  res.json({ ok: true });

  setImmediate(async () => {
    try {
      const raw = typeof req.body === "string" ? req.body : "";
      let parsed = {};
      const maybeJson = safeJsonParse(raw);
      if (maybeJson && typeof maybeJson === "object") {
        parsed = maybeJson;
      } else {
        parsed = querystring.parse(raw);
      }

      const keys = Object.keys(parsed || {});
      STATE.lastKommoWebhook = {
        rid, at: isoNow(),
        method: req.method,
        keysCount: keys.length,
        keysPreview: keys.slice(0, 50),
        rawPreview: String(raw).slice(0, 500),
      };

      log(rid, "==== Kommo webhook ====");
      log(rid, "method:", req.method, "keysCount:", keys.length);
      log(rid, "keysPreview:", keys.slice(0, 40));

      let { leadId, contactId } = extractIdsFromKommo(parsed);
      log(rid, "Extracted IDs:", { leadId, contactId });

      // ---- Читаем текст из кастомного поля LINE Reply ----
      const cfResult = extractLineReplyFromCustomFields(parsed, rid);

      if (!cfResult?.text) {
        log(rid, "No LINE Reply text in custom fields -> skip");
        return;
      }

      const replyText = cfResult.text;
      log(rid, "✅ LINE Reply text:", replyText);

      // Если нет contactId — достаём через лид
      if (!contactId && leadId) {
        try {
          const leadData = await getKommoLeadById(leadId, rid);
          const embContacts = leadData?._embedded?.contacts || [];
          if (embContacts.length > 0) {
            contactId = String(embContacts[0].id);
            log(rid, "[KOMMO] Resolved contactId from lead:", contactId);
          }
        } catch (e) {
          errlog(rid, "[KOMMO] Failed to fetch lead:", e?.response?.status ? `HTTP ${e.response.status}` : e.message);
        }
      }

      if (!contactId) {
        warn(rid, "contactId missing -> cannot map to LINE user");
        return;
      }

      // Получаем контакт -> LINE userId из тега
      let contact;
      try {
        contact = await getKommoContactById(contactId, rid);
      } catch (e) {
        errlog(rid, "Failed to fetch Kommo contact:", e?.response?.status ? `HTTP ${e.response.status}` : e.message);
        return;
      }

      const lineUserId = extractLineUserIdFromContact(contact);
      if (!lineUserId) {
        warn(rid, "No LINE userId in contact tags -> cannot send");
        return;
      }

      log(rid, "🚀 Sending to LINE user:", lineUserId, "text:", replyText);

      // Отправляем в LINE
      const sendResult = await sendLinePush(lineUserId, replyText, rid);

      if (sendResult.ok) {
        // Очищаем поле LINE Reply чтобы не слать дубли при следующем триггере
        const fieldId = cfResult.fieldId || getLineReplyFieldId();
        if (fieldId && leadId) {
          await clearLineReplyField(leadId, fieldId, rid);
        }

        // Логируем в лид
        if (leadId) {
          try {
            await addLeadNote(toInt(leadId), `[LINE sent] ${replyText}`, rid);
          } catch (e) {
            warn(rid, "Could not add 'LINE sent' note:", e.message);
          }
        }
      }

    } catch (e) {
      errlog(rid, "Unhandled error in /kommo/webhook:", e.message);
    }
  });
});

// -------------------- start --------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`line-kommo-bridge is running on port ${PORT}`);
});
