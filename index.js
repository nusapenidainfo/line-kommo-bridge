// index.js
// LINE <-> Kommo bridge
//
// ENV (Render):
// - KOMMO_SUBDOMAIN
// - KOMMO_ACCESS_TOKEN
// - KOMMO_PIPELINE_ID (optional)
// - KOMMO_STATUS_ID (optional)
// - KOMMO_LINE_REPLY_FIELD_ID      (879213)
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

function getLineReplyFieldId() {
  return toInt(process.env.KOMMO_LINE_REPLY_FIELD_ID);
}

const TAG_LINE = "LINE";
const TAG_LINE_CHAT = "LINE_CHAT";

const TAG_LINE_UID_PREFIX = "LINE_UID_"; // legacy
const TAG_LINE_CHATID_PREFIX = "LINE_CHATID_";
const TAG_LINE_USERID_PREFIX = "LINE_USERID_";

// -------------------- in-memory debug state --------------------
const STATE = {
  lastLineWebhook: null,
  lastKommoWebhook: null,
};

// -------------------- routes --------------------
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
    if (!sub || !tok) return res.status(400).json({ ok: false, error: "Kommo env is missing" });

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
  if (!secret) return true;
  if (!signature) return false;

  try {
    const hash = crypto.createHmac("sha256", secret).update(bodyString).digest("base64");
    return hash === signature;
  } catch {
    return false;
  }
}

// -------------------- LINE ids --------------------
function getLineIdsFromEvent(ev) {
  const source = ev?.source || {};
  const userId = source.userId || null;
  const groupId = source.groupId || null;
  const roomId = source.roomId || null;

  const chatId = groupId || roomId || userId || "unknown";
  const kind = groupId ? "group" : roomId ? "room" : userId ? "user" : "unknown";
  return { chatId, userId, kind };
}

// -------------------- LINE API --------------------
async function getLineProfile(ids, rid) {
  const tok = getLineToken();
  if (!tok) return null;

  try {
    if (ids.kind === "user" && ids.userId) {
      const url = `https://api.line.me/v2/bot/profile/${encodeURIComponent(ids.userId)}`;
      const r = await axios.get(url, { headers: { Authorization: `Bearer ${tok}` }, timeout: 10000 });
      return r.data || null;
    }
    if (ids.kind === "group" && ids.chatId && ids.userId) {
      const url = `https://api.line.me/v2/bot/group/${encodeURIComponent(ids.chatId)}/member/${encodeURIComponent(ids.userId)}`;
      const r = await axios.get(url, { headers: { Authorization: `Bearer ${tok}` }, timeout: 10000 });
      return r.data || null;
    }
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
    errlog(rid, "LINE token missing");
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
  return sub ? `https://${sub}.kommo.com/api/v4` : "";
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

// -------------------- Tag extract --------------------
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

async function getKommoContactById(contactId, rid) {
  return await kommoGet(`/contacts/${contactId}`, { with: "tags" }, rid);
}

async function getKommoLeadById(leadId, rid) {
  return await kommoGet(`/leads/${leadId}`, { with: "contacts,tags" }, rid);
}

// -------------------- Kommo: lead/notes --------------------
async function addLeadNote(leadId, text, rid) {
  const payload = [{ entity_id: leadId, note_type: "common", params: { text } }];
  log(rid, "[KOMMO] add note:", { leadId, textPreview: String(text).slice(0, 80) });
  return await kommoPost("/leads/notes", payload, rid);
}

// -------------------- LINE Reply extract (payload) --------------------
function extractLineReplyFromPayload(parsed, rid) {
  const fieldId = getLineReplyFieldId();
  const keys = Object.keys(parsed || {});

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
      log(rid, `[CF] LINE Reply found in payload by field_id ${fieldId}`);
      return { text: val.trim(), fieldId: fid };
    }

    if (!fieldId) {
      const n = String(fname).toLowerCase().replace(/[\s_-]/g, "");
      if (n.includes("linereply")) return { text: val.trim(), fieldId: fid };
    }
  }

  return null;
}

// -------------------- LINE Reply extract (lead API) --------------------
function extractLineReplyFromLeadData(leadData, rid) {
  const fieldId = getLineReplyFieldId();
  if (!fieldId) return null;

  const cfs = leadData?.custom_fields_values;
  if (!Array.isArray(cfs)) return null;

  const cf = cfs.find((x) => toInt(x?.field_id) === fieldId);
  const val = cf?.values?.[0]?.value;

  if (isNonEmptyString(val)) {
    log(rid, `[CF] LINE Reply found in lead API by field_id ${fieldId}`);
    return { text: String(val).trim(), fieldId };
  }

  return null;
}

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
    log(rid, "[KOMMO] LINE Reply cleared:", { leadId, fieldId });
  } catch (e) {
    warn(rid, "[KOMMO] Could not clear LINE Reply:", e?.response?.status ? `HTTP ${e.response.status}` : e.message);
  }
}

// -------------------- LINE webhook (incoming) --------------------
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
      if (!data || !Array.isArray(data.events)) return;

      STATE.lastLineWebhook = {
        rid,
        at: isoNow(),
        eventsCount: data.events.length,
        firstEventType: data.events[0]?.type || null,
      };

      for (const ev of data.events) {
        if (ev?.type !== "message" || ev?.message?.type !== "text") continue;

        const text = (ev.message.text || "").trim();
        if (!text) continue;

        const ids = getLineIdsFromEvent(ev);
        const profile = await getLineProfile(ids, rid);

        // ВАЖНО: для простоты оставляем существующую логику контактов/лидов как у тебя,
        // так как текущая проблема у тебя именно на Kommo->LINE.
        // (Если захочешь — добавим умное объединение контактов по телефону из текста.)

        // Найдём/создадим контакт по LINE chatId (тег)
        const contact = await ensureKommoContactByLineTag(ids, profile, rid);
        if (!contact?.id) continue;

        const lead = await ensureLineChatLeadByContact(contact.id, profile, ids, rid);
        if (!lead?.id) continue;

        const displayName = profile?.displayName || "Client";
        await addLeadNote(lead.id, `${displayName}: ${text}`, rid);
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
    parsed["leads[update][0][id]"] ||
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
  res.json({ ok: true });

  setImmediate(async () => {
    const extracted = {
      leadId: null,
      contactId: null,
      replyTextFound: false,
      replyTextSource: null,
      lineChatId: null,
      sendOk: false,
      sendError: null,
      reasonStop: null,
    };

    try {
      const raw = typeof req.body === "string" ? req.body : "";
      let parsed = {};

      const maybeJson = safeJsonParse(raw);
      if (maybeJson && typeof maybeJson === "object") parsed = maybeJson;
      else parsed = querystring.parse(raw);

      const keys = Object.keys(parsed || {});
      let { leadId, contactId } = extractIdsFromKommo(parsed);

      extracted.leadId = leadId;
      extracted.contactId = contactId;

      STATE.lastKommoWebhook = {
        rid,
        at: isoNow(),
        method: req.method,
        keysCount: keys.length,
        keysPreview: keys.slice(0, 60),
        rawPreview: String(raw).slice(0, 900),
        extracted,
      };

      log(rid, "==== Kommo webhook ====");
      log(rid, "leadId/contactId:", { leadId, contactId });

      if (!leadId) {
        extracted.reasonStop = "leadId missing in payload";
        warn(rid, extracted.reasonStop);
        return;
      }

      // 1) Берём LINE Reply из payload
      let cfResult = extractLineReplyFromPayload(parsed, rid);
      if (cfResult?.text) {
        extracted.replyTextFound = true;
        extracted.replyTextSource = "payload";
      }

      // 2) Если нет — читаем лид через API и берём LINE Reply оттуда (самый надёжный путь)
      let leadData = null;
      if (!cfResult?.text) {
        // небольшой буфер: иногда кликают сразу после Save
        await sleep(300);

        try {
          leadData = await getKommoLeadById(leadId, rid);
          cfResult = extractLineReplyFromLeadData(leadData, rid);
          if (cfResult?.text) {
            extracted.replyTextFound = true;
            extracted.replyTextSource = "lead_api";
          }
        } catch (e) {
          extracted.reasonStop = "failed to fetch lead from Kommo API";
          errlog(rid, extracted.reasonStop, e?.response?.status ? `HTTP ${e.response.status}` : e.message);
          return;
        }
      }

      if (!cfResult?.text) {
        extracted.reasonStop = "LINE Reply empty (payload + lead_api)";
        log(rid, extracted.reasonStop);
        return;
      }

      const replyText = cfResult.text.trim();
      log(rid, "✅ LINE Reply text:", replyText);

      // Если contactId не пришёл — достанем через lead API
      if (!contactId) {
        try {
          if (!leadData) leadData = await getKommoLeadById(leadId, rid);
          const embContacts = leadData?._embedded?.contacts || [];
          if (embContacts.length > 0) {
            contactId = String(embContacts[0].id);
            extracted.contactId = contactId;
            log(rid, "Resolved contactId from lead:", contactId);
          }
        } catch {}
      }

      // ---- Находим lineChatId максимально надёжно ----
      let lineChatId = null;

      // A) из тегов лида
      try {
        if (!leadData) leadData = await getKommoLeadById(leadId, rid);
        const leadTags = leadData?._embedded?.tags || [];
        lineChatId = extractLineChatIdFromTags(leadTags);
        if (lineChatId) log(rid, "LINE chatId from lead tags:", lineChatId);
      } catch {}

      // B) из контакта (если есть contactId)
      if (!lineChatId && contactId) {
        try {
          const c = await getKommoContactById(contactId, rid);
          lineChatId = extractLineChatIdFromTags(c?._embedded?.tags || []);
          if (lineChatId) log(rid, "LINE chatId from main contact:", lineChatId);
        } catch (e) {
          warn(rid, "Failed to fetch main contact:", e.message);
        }
      }

      // C) если у лида несколько контактов — проверим все
      if (!lineChatId) {
        try {
          if (!leadData) leadData = await getKommoLeadById(leadId, rid);
          const embContacts = leadData?._embedded?.contacts || [];
          for (const ct of embContacts) {
            const cid = ct?.id ? String(ct.id) : null;
            if (!cid) continue;
            try {
              const c = await getKommoContactById(cid, rid);
              const found = extractLineChatIdFromTags(c?._embedded?.tags || []);
              if (found) {
                lineChatId = found;
                log(rid, "LINE chatId from another contact:", { contactId: cid, lineChatId });
                break;
              }
            } catch {}
          }
        } catch {}
      }

      if (!lineChatId) {
        extracted.reasonStop = "No LINE chatId found in lead tags / contacts tags";
        warn(rid, extracted.reasonStop);
        return;
      }

      extracted.lineChatId = lineChatId;

      // ---- Отправляем в LINE ----
      log(rid, "🚀 Sending to LINE:", { to: lineChatId, text: replyText });
      const sendResult = await sendLinePush(lineChatId, replyText, rid);

      if (!sendResult.ok) {
        extracted.sendOk = false;
        extracted.sendError = sendResult.error || "unknown";
        extracted.reasonStop = "LINE push failed";
        return;
      }

      extracted.sendOk = true;

      // ---- Очищаем LINE Reply + пишем note ----
      const fieldId = cfResult.fieldId || getLineReplyFieldId();
      if (fieldId) await clearLineReplyField(leadId, fieldId, rid);

      try {
        await addLeadNote(toInt(leadId), `[LINE sent] ${replyText}`, rid);
      } catch {}

    } catch (e) {
      extracted.reasonStop = "Unhandled error";
      errlog(rid, "Unhandled error in /kommo/webhook:", e.message);
    } finally {
      // обновим extracted в debug объекте (чтобы сразу видеть результат)
      if (STATE.lastKommoWebhook && STATE.lastKommoWebhook.rid === rid) {
        STATE.lastKommoWebhook.extracted = extracted;
      }
    }
  });
});

// -------------------- Kommo: contact+lead ensure (минимально как у тебя) --------------------
async function kommoFindContactByTag(tagExact, rid) {
  const data = await kommoGet("/contacts", { query: tagExact, limit: 10, with: "tags" }, rid);
  const contacts = data?._embedded?.contacts || [];
  if (!contacts.length) return null;
  return contacts.find((c) => (c?._embedded?.tags || []).some((t) => t?.name === tagExact)) || contacts[0];
}

async function ensureKommoContactByLineTag(ids, profile, rid) {
  const chatId = ids?.chatId || "unknown";
  if (chatId === "unknown") return null;

  const tag1 = `${TAG_LINE_CHATID_PREFIX}${chatId}`;
  const tagLegacy = `${TAG_LINE_UID_PREFIX}${chatId}`;

  let contact = await kommoFindContactByTag(tag1, rid);
  if (!contact) contact = await kommoFindContactByTag(tagLegacy, rid);

  if (contact) return contact;

  const displayName = profile?.displayName || `LINE ${chatId}`;
  const name = `[LINE] ${displayName}`.slice(0, 250);

  const tags = [
    { name: TAG_LINE },
    { name: `${TAG_LINE_CHATID_PREFIX}${chatId}` },
    { name: `${TAG_LINE_UID_PREFIX}${chatId}` },
  ];

  if (ids?.userId) tags.push({ name: `${TAG_LINE_USERID_PREFIX}${ids.userId}` });

  const created = await kommoPost("/contacts", [{ name, _embedded: { tags } }], rid);
  return (Array.isArray(created) ? created[0] : null) || null;
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
  const displayName = profile?.displayName || `LINE ${ids?.chatId || ""}`;
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

async function ensureLineChatLeadByContact(contactId, profile, ids, rid) {
  let leads = await findLeadsByContact(contactId, rid);
  if (leads.length) {
    const chatLead = leads.find((l) => leadHasTag(l, TAG_LINE_CHAT));
    return chatLead || leads[0];
  }
  return await createLineChatLead(contactId, profile, ids, rid);
}

// -------------------- start --------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`line-kommo-bridge is running on port ${PORT}`);
});
