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
// - KOMMO_LINE_REPLY_FIELD_ID      (ID of the custom text field "LINE Reply" in leads)  -> 879213
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
const TAG_LINE_UID_PREFIX = "LINE_UID_"; // legacy
const TAG_LINE_CHATID_PREFIX = "LINE_CHATID_"; // new
const TAG_LINE_USERID_PREFIX = "LINE_USERID_"; // new

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
      ok: false,
      rid,
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
      ok: false,
      rid,
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

  // если секрет не задан — пропускаем проверку
  if (!secret) return true;

  // если секрет задан — подпись обязательна
  if (!signature) return false;

  try {
    const hash = crypto.createHmac("sha256", secret).update(bodyString).digest("base64");
    return hash === signature;
  } catch {
    return false;
  }
}

// -------------------- LINE: ids --------------------
function getLineIdsFromEvent(ev) {
  const source = ev?.source || {};
  const userId = source.userId || null;
  const groupId = source.groupId || null;
  const roomId = source.roomId || null;

  // chatId = куда отвечать push-сообщением
  const chatId = groupId || roomId || userId || "unknown";
  const kind = groupId ? "group" : roomId ? "room" : userId ? "user" : "unknown";

  return { chatId, userId, kind };
}

// -------------------- LINE API --------------------
async function getLineProfile(ids, rid) {
  const tok = getLineToken();
  if (!tok) return null;

  try {
    // 1:1
    if (ids.kind === "user" && ids.userId) {
      const url = `https://api.line.me/v2/bot/profile/${encodeURIComponent(ids.userId)}`;
      const r = await axios.get(url, { headers: { Authorization: `Bearer ${tok}` }, timeout: 10000 });
      return r.data || null;
    }

    // group member profile (если есть userId)
    if (ids.kind === "group" && ids.chatId && ids.userId) {
      const url = `https://api.line.me/v2/bot/group/${encodeURIComponent(ids.chatId)}/member/${encodeURIComponent(ids.userId)}`;
      const r = await axios.get(url, { headers: { Authorization: `Bearer ${tok}` }, timeout: 10000 });
      return r.data || null;
    }

    // room member profile
    if (ids.kind === "room" && ids.chatId && ids.userId) {
      const url = `https://api.line.me/v2/bot/room/${encodeURIComponent(ids.chatId)}/member/${encodeURIComponent(ids.userId)}`;
      const r = await axios.get(url, { headers: { Authorization: `Bearer ${tok}` }, timeout: 10000 });
      return r.data || null;
    }

    return null;
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

function extractLineChatIdFromTags(tagsArr) {
  const tags = Array.isArray(tagsArr) ? tagsArr : [];
  for (const t of tags) {
    const n = t?.name || "";
    if (n.startsWith(TAG_LINE_CHATID_PREFIX)) return n.slice(TAG_LINE_CHATID_PREFIX.length);
  }
  for (const t of tags) {
    const n = t?.name || "";
    if (n.startsWith(TAG_LINE_UID_PREFIX)) return n.slice(TAG_LINE_UID_PREFIX.length);
  }
  for (const t of tags) {
    const n = t?.name || "";
    if (n.startsWith(TAG_LINE_USERID_PREFIX)) return n.slice(TAG_LINE_USERID_PREFIX.length);
  }
  return null;
}

function extractLineChatIdFromContact(contact) {
  const tags = contact?._embedded?.tags || [];
  return extractLineChatIdFromTags(tags);
}

async function findKommoContactByLineChatId(chatId, rid) {
  const q1 = `${TAG_LINE_CHATID_PREFIX}${chatId}`;
  log(rid, "[KOMMO] find contact by query:", q1);
  const data1 = await kommoGet("/contacts", { query: q1, limit: 10, with: "tags" }, rid);
  const contacts1 = data1?._embedded?.contacts || [];
  if (contacts1.length) return contacts1.find((c) => contactHasTag(c, q1)) || contacts1[0];

  // legacy
  const q2 = `${TAG_LINE_UID_PREFIX}${chatId}`;
  log(rid, "[KOMMO] find contact by query (legacy):", q2);
  const data2 = await kommoGet("/contacts", { query: q2, limit: 10, with: "tags" }, rid);
  const contacts2 = data2?._embedded?.contacts || [];
  if (contacts2.length) return contacts2.find((c) => contactHasTag(c, q2)) || contacts2[0];

  return null;
}

async function createKommoContactFromLine(ids, profile, rid) {
  const displayName = profile?.displayName || `LINE ${ids.userId || ids.chatId}`;
  const name = `[LINE] ${displayName}`.slice(0, 250);

  const tags = [{ name: TAG_LINE }];

  if (ids.chatId && ids.chatId !== "unknown") tags.push({ name: `${TAG_LINE_CHATID_PREFIX}${ids.chatId}` });
  if (ids.userId) tags.push({ name: `${TAG_LINE_USERID_PREFIX}${ids.userId}` });

  // legacy for backward compatibility
  if (ids.chatId && ids.chatId !== "unknown") tags.push({ name: `${TAG_LINE_UID_PREFIX}${ids.chatId}` });

  const payload = [{ name, _embedded: { tags } }];
  log(rid, "[KOMMO] creating contact:", { name, tags: tags.map((t) => t.name) });
  const created = await kommoPost("/contacts", payload, rid);
  return (Array.isArray(created) ? created[0] : null) || null;
}

async function ensureKommoContact(ids, profile, rid) {
  let contact = null;

  try {
    if (ids.chatId && ids.chatId !== "unknown") {
      contact = await findKommoContactByLineChatId(ids.chatId, rid);
    }
  } catch (e) {
    errlog(rid, "[KOMMO] Error searching contacts:", e?.response?.status ? `HTTP ${e.response.status}` : e.message);
  }

  if (!contact) {
    try {
      contact = await createKommoContactFromLine(ids, profile, rid);
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

async function createLineChatLead(contactId, profile, ids, rid) {
  const displayName = profile?.displayName || `LINE ${ids.userId || ids.chatId}`;
  const pipelineId = toInt(process.env.KOMMO_PIPELINE_ID);
  const statusId = toInt(process.env.KOMMO_STATUS_ID);

  const leadName = `[LINE] ${displayName}`.slice(0, 250);
  const tags = [{ name: TAG_LINE }, { name: TAG_LINE_CHAT }];

  if (ids.chatId && ids.chatId !== "unknown") tags.push({ name: `${TAG_LINE_CHATID_PREFIX}${ids.chatId}` });
  if (ids.userId) tags.push({ name: `${TAG_LINE_USERID_PREFIX}${ids.userId}` });

  const lead = {
    name: leadName,
    _embedded: { contacts: [{ id: contactId }], tags },
  };
  if (pipelineId) lead.pipeline_id = pipelineId;
  if (statusId) lead.status_id = statusId;

  const created = await kommoPost("/leads", [lead], rid);
  return (Array.isArray(created) ? created[0] : null) || null;
}

async function ensureLineChatLead(contactId, profile, ids, rid) {
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
    const newLead = await createLineChatLead(contactId, profile, ids, rid);
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
  // по id обычно возвращаются custom_fields_values без дополнительных with,
  // но contacts/tags полезны
  return await kommoGet(`/leads/${leadId}`, { with: "contacts,tags" }, rid);
}

// -------------------- Читаем кастомное поле LINE Reply из webhook payload --------------------
function extractLineReplyFromCustomFields(parsed, rid) {
  const fieldId = getLineReplyFieldId();
  const keys = Object.keys(parsed || {});

  // --- querystring формат ---
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

    if (fieldId && fid === fieldId) {
      log(rid, `[CF] Found LINE Reply by field_id ${fieldId}:`, val);
      return { text: val.trim(), fieldId: fid };
    }

    if (!fieldId) {
      const nameL = String(fname).toLowerCase().replace(/[\s_-]/g, "");
      if (nameL.includes("linereply")) {
        log(rid, `[CF] Found LINE Reply by field_name "${fname}":`, val);
        return { text: val.trim(), fieldId: fid };
      }
    }
  }

  // --- flat keys ---
  for (const k of keys) {
    const kl = k.toLowerCase().replace(/[\s_\[\]]/g, "");
    if (kl.includes("linereply")) {
      const v = parsed[k];
      if (isNonEmptyString(v)) {
        log(rid, `[CF] Found LINE Reply by flat key "${k}":`, v);
        return { text: v.trim(), fieldId: null };
      }
    }
  }

  return null;
}

// -------------------- ВАЖНОЕ: fallback чтение LINE Reply из Kommo API по leadId --------------------
function extractLineReplyFromLeadData(leadData, rid) {
  const fieldId = getLineReplyFieldId();
  if (!fieldId) return null;

  const cfs = leadData?.custom_fields_values;
  if (!Array.isArray(cfs)) return null;

  const cf = cfs.find((x) => toInt(x?.field_id) === fieldId);
  const val = cf?.values?.[0]?.value;

  if (isNonEmptyString(val)) {
    log(rid, `[CF] Found LINE Reply in lead API (field_id ${fieldId}):`, val);
    return { text: String(val).trim(), fieldId };
  }

  return null;
}

// Очищаем поле LINE Reply после отправки
async function clearLineReplyField(leadId, fieldId, rid) {
  if (!leadId || !fieldId) return;
  try {
    await kommoPatch(
      "/leads",
      [
        {
          id: toInt(leadId),
          custom_fields_values: [{ field_id: fieldId, values: [{ value: "" }] }],
        },
      ],
      rid
    );
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
        rid,
        at: isoNow(),
        eventsCount: data.events.length,
        firstEventType: data.events[0]?.type || null,
      };

      log(rid, "LINE events count:", data.events.length);

      for (const ev of data.events) {
        const evType = ev?.type;
        const msgType = ev?.message?.type;

        if (evType !== "message" || msgType !== "text") continue;

        const text = (ev.message.text || "").trim();
        if (!text) continue;

        const ids = getLineIdsFromEvent(ev);
        log(rid, "✅ New LINE text:", { kind: ids.kind, chatId: ids.chatId, userId: ids.userId, text });

        const profile = await getLineProfile(ids, rid);
        const contact = await ensureKommoContact(ids, profile, rid);
        if (!contact?.id) {
          warn(rid, "⚠️ Kommo contact missing -> stop");
          continue;
        }

        const lead = await ensureLineChatLead(contact.id, profile, ids, rid);
        if (!lead?.id) {
          warn(rid, "⚠️ leadId missing -> stop");
          continue;
        }

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
  const leadId =
    parsed["leads[add][0][id]"] ||
    parsed["this_item[id]"] ||
    parsed["lead[id]"] ||
    parsed["lead_id"] ||
    parsed["id"] ||
    null;

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

  // быстро отвечаем, чтобы Emfy не таймаутился
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
        rid,
        at: isoNow(),
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

      // 1) сначала пробуем достать LINE Reply из payload
      let cfResult = extractLineReplyFromCustomFields(parsed, rid);

      // если Emfy не передал поле — читаем напрямую из Kommo по leadId
      let leadData = null;
      if ((!cfResult?.text || !isNonEmptyString(cfResult.text)) && leadId) {
        // маленькая задержка на случай если ты нажал кнопку сразу после Save
        await sleep(300);

        try {
          leadData = await getKommoLeadById(leadId, rid);
          const fromLead = extractLineReplyFromLeadData(leadData, rid);
          if (fromLead?.text) cfResult = fromLead;
        } catch (e) {
          errlog(rid, "[KOMMO] Failed to fetch lead for LINE Reply:", e?.response?.status ? `HTTP ${e.response.status}` : e.message);
        }
      }

      if (!cfResult?.text) {
        log(rid, "No LINE Reply text (payload + lead API) -> skip");
        return;
      }

      const replyText = cfResult.text.trim();
      log(rid, "✅ LINE Reply text:", replyText);

      // если contactId нет — пытаемся взять из лида
      if (!contactId && leadId) {
        try {
          if (!leadData) leadData = await getKommoLeadById(leadId, rid);
          const embContacts = leadData?._embedded?.contacts || [];
          if (embContacts.length > 0) {
            contactId = String(embContacts[0].id);
            log(rid, "[KOMMO] Resolved contactId from lead:", contactId);
          }
        } catch (e) {
          errlog(rid, "[KOMMO] Failed to resolve contactId from lead:", e?.response?.status ? `HTTP ${e.response.status}` : e.message);
        }
      }

      // 2) находим куда слать в LINE (chatId) — сначала из контакта
      let lineChatId = null;

      if (contactId) {
        try {
          const contact = await getKommoContactById(contactId, rid);
          lineChatId = extractLineChatIdFromContact(contact);
          if (lineChatId) log(rid, "LINE chatId from contact tags:", lineChatId);
        } catch (e) {
          warn(rid, "Failed to fetch Kommo contact:", e?.response?.status ? `HTTP ${e.response.status}` : e.message);
        }
      }

      // 3) если вдруг контакта нет — пробуем достать chatId из тегов лида (мы их создаём)
      if (!lineChatId && leadId) {
        try {
          if (!leadData) leadData = await getKommoLeadById(leadId, rid);
          const leadTags = leadData?._embedded?.tags || [];
          lineChatId = extractLineChatIdFromTags(leadTags);
          if (lineChatId) log(rid, "LINE chatId from lead tags:", lineChatId);
        } catch (e) {
          warn(rid, "Could not read lead tags:", e.message);
        }
      }

      if (!lineChatId) {
        warn(rid, "No LINE chatId found -> cannot send");
        return;
      }

      log(rid, "🚀 Sending to LINE:", { to: lineChatId, text: replyText });

      const sendResult = await sendLinePush(lineChatId, replyText, rid);

      if (sendResult.ok) {
        // чистим поле
        const fieldId = cfResult.fieldId || getLineReplyFieldId();
        if (fieldId && leadId) {
          await clearLineReplyField(leadId, fieldId, rid);
        }

        // пишем note
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
