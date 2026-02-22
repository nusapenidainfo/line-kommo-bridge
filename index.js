// index.js
// LINE <-> Kommo bridge (diagnostic + stable)
// 1) LINE webhook -> Kommo: find/create Contact, find/create 1 "chat lead" per contact, add NOTE with client message
// 2) Kommo webhook (Emfy/Webhooks addon) -> LINE: extract reply text, find LINE userId via contact tags, push to LINE
//
// ВАЖНО: быстрый ответ Kommo webhook'у (JSON) -> чтобы не было "The response must be in JSON format" / timeout
//
// ENV (Render):
// - KOMMO_SUBDOMAIN                (e.g. andriecas)
// - KOMMO_ACCESS_TOKEN             (preferred)  OR  KOMMO_API_KEY (fallback)  // long-lived token
// - KOMMO_PIPELINE_ID              (optional, but recommended) e.g. 3153064
// - KOMMO_STATUS_ID                (optional)
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
    ],
    ts: isoNow(),
  });
});

app.get("/status", (req, res) => {
  res.json({
    ok: true,
    service: "line-kommo-bridge",
    timestamp: isoNow(),
  });
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
    ts: isoNow(),
  });
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

    res.json({
      ok: true,
      status: r.status,
      account_id: r.data?.id,
      name: r.data?.name,
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

app.get("/debug/line", async (req, res) => {
  const rid = makeRid();
  try {
    const tok = getLineToken();
    if (!tok) {
      return res.status(400).json({ ok: false, error: "LINE token missing" });
    }

    const url = "https://api.line.me/v2/bot/info";
    const r = await axios.get(url, {
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
  if (!secret || !signature) {
    // если нет секрета/подписи — пропускаем (но в проде лучше иметь)
    return true;
  }
  try {
    const hash = crypto
      .createHmac("sha256", secret)
      .update(bodyString)
      .digest("base64");
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
    const url = `https://api.line.me/v2/bot/profile/${encodeURIComponent(
      lineUserId
    )}`;
    const r = await axios.get(url, {
      headers: { Authorization: `Bearer ${tok}` },
      timeout: 10000,
    });
    const profile = r.data || null;
    if (profile) {
      log(rid, "👤 LINE profile:", {
        userId: profile.userId,
        displayName: profile.displayName,
        statusMessage: profile.statusMessage || null,
      });
    }
    return profile;
  } catch (e) {
    warn(
      rid,
      "Could not fetch LINE profile:",
      e?.response?.status
        ? `HTTP ${e.response.status}`
        : e.message
    );
    return null;
  }
}

async function sendLinePush(to, text, rid) {
  const tok = getLineToken();
  if (!tok) {
    errlog(rid, "LINE_CHANNEL_ACCESS_TOKEN missing -> cannot send");
    return { ok: false, error: "LINE token missing" };
  }

  const payload = {
    to,
    messages: [{ type: "text", text }],
  };

  try {
    const r = await axios.post(
      "https://api.line.me/v2/bot/message/push",
      payload,
      {
        headers: {
          Authorization: `Bearer ${tok}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      }
    );
    log(rid, "✅ LINE push sent:", { to, status: r.status });
    return { ok: true };
  } catch (e) {
    const details = e?.response?.data ? JSON.stringify(e.response.data) : e.message;
    errlog(
      rid,
      "❌ LINE push error:",
      e?.response?.status ? `HTTP ${e.response.status}` : "",
      details
    );
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
  const tok = getKommoToken();
  return {
    Authorization: `Bearer ${tok}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function kommoGet(path, params, rid) {
  const base = kommoBaseUrl();
  const tok = getKommoToken();
  if (!base || !tok) throw new Error("KOMMO creds missing");

  const url = `${base}${path}`;
  const r = await axios.get(url, {
    headers: kommoHeaders(),
    params: params || {},
    timeout: 15000,
  });
  return r.data;
}

async function kommoPost(path, data, rid) {
  const base = kommoBaseUrl();
  const tok = getKommoToken();
  if (!base || !tok) throw new Error("KOMMO creds missing");

  const url = `${base}${path}`;
  const r = await axios.post(url, data, {
    headers: kommoHeaders(),
    timeout: 15000,
  });
  return r.data;
}

async function kommoPatch(path, data, rid) {
  const base = kommoBaseUrl();
  const tok = getKommoToken();
  if (!base || !tok) throw new Error("KOMMO creds missing");

  const url = `${base}${path}`;
  const r = await axios.patch(url, data, {
    headers: kommoHeaders(),
    timeout: 15000,
  });
  return r.data;
}

// ---------- Kommo: Contact find/create ----------
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
  log(rid, "[KOMMO] find contact by query(tag):", q);

  const data = await kommoGet(
    "/contacts",
    {
      query: q,
      limit: 10,
      with: "tags",
    },
    rid
  );

  const contacts = data?._embedded?.contacts || [];
  if (!contacts.length) return null;

  // выбираем контакт, где реально есть нужный тег
  const exact = contacts.find((c) => contactHasTag(c, q)) || contacts[0];
  return exact;
}

async function createKommoContactFromLine(lineUserId, profile, rid) {
  const displayName = profile?.displayName || `LINE ${lineUserId}`;
  const name = `[LINE] ${displayName}`.slice(0, 250);

  const tags = [
    { name: TAG_LINE },
    { name: `${TAG_LINE_UID_PREFIX}${lineUserId}` },
  ];

  const payload = [
    {
      name,
      _embedded: { tags },
    },
  ];

  log(rid, "[KOMMO] creating contact:", { name, tags: tags.map((t) => t.name) });

  const created = await kommoPost("/contacts", payload, rid);
  const contact = Array.isArray(created) ? created[0] : null;
  return contact || null;
}

async function ensureKommoContact(lineUserId, profile, rid) {
  let contact = null;

  try {
    contact = await findKommoContactByLineUserId(lineUserId, rid);
  } catch (e) {
    errlog(
      rid,
      "[KOMMO] Error searching contacts:",
      e?.response?.status ? `HTTP ${e.response.status}` : e.message,
      e?.response?.data ? JSON.stringify(e.response.data) : ""
    );
  }

  if (!contact) {
    try {
      contact = await createKommoContactFromLine(lineUserId, profile, rid);
      log(rid, "✅ Kommo contact created:", {
        id: contact?.id || null,
        name: contact?.name || null,
      });
    } catch (e) {
      errlog(
        rid,
        "[KOMMO] Failed to create contact:",
        e?.response?.status ? `HTTP ${e.response.status}` : e.message,
        e?.response?.data ? JSON.stringify(e.response.data) : ""
      );
      return null;
    }
  } else {
    log(rid, "[KOMMO] contact found:", { id: contact.id, name: contact.name });

    // обновим имя, если есть displayName и контакт выглядит как старый
    const displayName = profile?.displayName;
    if (displayName && typeof displayName === "string") {
      const desired = `[LINE] ${displayName}`.slice(0, 250);
      if (contact.name !== desired) {
        try {
          await kommoPatch(
            "/contacts",
            [{ id: contact.id, name: desired }],
            rid
          );
          log(rid, "[KOMMO] contact name updated:", desired);
        } catch (e) {
          warn(
            rid,
            "[KOMMO] could not update contact name:",
            e?.response?.status ? `HTTP ${e.response.status}` : e.message
          );
        }
      }
    }
  }

  return contact;
}

// ---------- Kommo: Lead find/create ----------
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

  // pipeline фильтр (если задан)
  const pipelineId = toInt(process.env.KOMMO_PIPELINE_ID);
  if (pipelineId) {
    params["filter[pipeline_id]"] = pipelineId;
  }

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
    _embedded: {
      contacts: [{ id: contactId }],
      tags,
    },
  };

  if (pipelineId) lead.pipeline_id = pipelineId;
  if (statusId) lead.status_id = statusId;

  const payload = [lead];

  log(rid, "[KOMMO] creating LINE_CHAT lead:", {
    leadName,
    pipelineId: pipelineId || null,
    statusId: statusId || null,
    contactId,
  });

  const created = await kommoPost("/leads", payload, rid);
  const newLead = Array.isArray(created) ? created[0] : null;
  return newLead || null;
}

async function ensureLineChatLead(contactId, profile, lineUserId, rid) {
  let leads = [];
  try {
    leads = await findLeadsByContact(contactId, rid);
  } catch (e) {
    errlog(
      rid,
      "[KOMMO] Error searching leads:",
      e?.response?.status ? `HTTP ${e.response.status}` : e.message,
      e?.response?.data ? JSON.stringify(e.response.data) : ""
    );
  }

  if (leads.length) {
    // приоритет: lead с тегом LINE_CHAT
    const chatLead = leads.find((l) => leadHasTag(l, TAG_LINE_CHAT));
    const picked = chatLead || leads[0];
    log(rid, "[KOMMO] using existing lead:", {
      id: picked.id,
      name: picked.name,
      hasLineChat: !!chatLead,
    });
    return picked;
  }

  // если нет — создаём
  try {
    const newLead = await createLineChatLead(contactId, profile, lineUserId, rid);
    log(rid, "✅ LINE_CHAT lead created:", {
      id: newLead?.id || null,
      name: newLead?.name || null,
    });
    return newLead;
  } catch (e) {
    errlog(
      rid,
      "[KOMMO] Failed to create lead:",
      e?.response?.status ? `HTTP ${e.response.status}` : e.message,
      e?.response?.data ? JSON.stringify(e.response.data) : ""
    );
    return null;
  }
}

// ---------- Kommo: add note to lead ----------
async function addLeadNote(leadId, text, rid) {
  const payload = [
    {
      entity_id: leadId,
      note_type: "common",
      params: { text },
    },
  ];

  log(rid, "[KOMMO] add note:", { leadId, textPreview: String(text).slice(0, 80) });

  const r = await kommoPost("/leads/notes", payload, rid);
  return r;
}

// ---------- Kommo: fetch contact by id (for Kommo->LINE mapping) ----------
async function getKommoContactById(contactId, rid) {
  const data = await kommoGet(`/contacts/${contactId}`, { with: "tags" }, rid);
  return data || null;
}

// -------------------- LINE webhook --------------------
// raw text to verify signature
app.post("/line/webhook", express.text({ type: "*/*" }), (req, res) => {
  const rid = makeRid();
  const signature = req.header("x-line-signature") || "";

  // Быстро отвечаем LINE
  res.json({ ok: true });

  // В фоне обрабатываем
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

      // сохраняем для /debug/last-line
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

        log(rid, "LINE event:", {
          type: evType,
          msgType,
          mode: ev?.mode,
          timestamp: ev?.timestamp,
        });

        if (evType !== "message" || msgType !== "text") {
          continue;
        }

        const text = (ev.message.text || "").trim();
        if (!text) continue;

        const source = ev.source || {};
        const lineUserId =
          source.userId || source.groupId || source.roomId || "unknown";

        log(rid, "✅ New LINE text:", { lineUserId, text });

        // 1) LINE profile (displayName)
        const profile = await getLineProfile(lineUserId, rid);

        // 2) ensure Kommo contact
        const contact = await ensureKommoContact(lineUserId, profile, rid);
        if (!contact?.id) {
          warn(rid, "⚠️ Kommo contact is missing -> stop");
          continue;
        }

        // 3) ensure 1 lead (LINE_CHAT)
        const lead = await ensureLineChatLead(contact.id, profile, lineUserId, rid);
        if (!lead?.id) {
          warn(rid, "⚠️ leadId missing -> stop");
          continue;
        }

        // 4) add note with client message
        const displayName = profile?.displayName || "Client";
        const noteText = `${displayName}: ${text}`;
        await addLeadNote(lead.id, noteText, rid);

        log(rid, "✅ Done LINE->Kommo:", {
          contactId: contact.id,
          leadId: lead.id,
        });
      }
    } catch (e) {
      errlog(rid, "Unhandled error in LINE webhook:", e.message);
    }
  });
});

// -------------------- Kommo webhook (Emfy/Webhooks addon) --------------------
function setCors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

// достаём leadId/contactId из максимально разных вариантов ключей
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
    parsed["this_item[_embedded][contacts][0]"] ||
    parsed["this_item[main_contact][id]"] ||
    parsed["contacts[add][0][id]"] ||
    parsed["contact[id]"] ||
    parsed["contact_id"] ||
    parsed["this_item[_embedded][contacts][0][id]"] ||
    null;

  return { leadId: leadId ? String(leadId) : null, contactId: contactId ? String(contactId) : null };
}

function looksLikeSystemText(t) {
  const s = String(t || "").toLowerCase();
  if (!s) return true;
  // типичные системные строки, которые не надо отправлять в LINE
  return (
    s.includes("the value of the field") ||
    s.includes("tags added") ||
    s.includes("lead created") ||
    s.includes("contact created") ||
    s.includes("is set to") ||
    s.includes("was changed") ||
    s.includes("pipeline") ||
    s.includes("robot")
  );
}

function extractReplyTextFromKommo(parsed) {
  // частые варианты от разных виджетов/вебхуков
  const candidates = [
    "reply_text",
    "reply",
    "text",
    "message",
    "message[text]",
    "msg",
    "comment",
    "comment[text]",
    "note[text]",
    "note[params][text]",
    "note[params][comment]",
    "this_item[text]",
    "this_item[params][text]",
  ];

  for (const k of candidates) {
    if (isNonEmptyString(parsed[k]) && !looksLikeSystemText(parsed[k])) {
      return String(parsed[k]).trim();
    }
  }

  // fallback: ищем любой ключ, который заканчивается на [text]
  const keys = Object.keys(parsed || {});
  for (const k of keys) {
    if (!k.endsWith("[text]")) continue;
    const v = parsed[k];
    if (isNonEmptyString(v) && !looksLikeSystemText(v)) {
      return String(v).trim();
    }
  }

  return null;
}

app.all("/kommo/webhook", express.text({ type: "*/*" }), (req, res) => {
  const rid = makeRid();
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // ВАЖНО: быстро отдать JSON, чтобы Kommo/Emfy не ругались
  res.json({ ok: true });

  setImmediate(async () => {
    try {
      const raw = typeof req.body === "string" ? req.body : "";
      let parsed = {};
      // иногда приходит JSON
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
        rawPreview: String(raw).slice(0, 300),
      };

      log(rid, "==== Kommo webhook ====");
      log(rid, "method:", req.method);
      log(rid, "keysCount:", keys.length);
      log(rid, "keysPreview:", keys.slice(0, 40));

      const { leadId, contactId } = extractIdsFromKommo(parsed);
      log(rid, "Extracted IDs:", { leadId, contactId });

      const replyText = extractReplyTextFromKommo(parsed);
      if (!replyText) {
        log(rid, "Kommo webhook without reply text -> skip sending to LINE");
        return;
      }

      log(rid, "✅ Reply text detected:", replyText);

      // Нужен contactId, чтобы найти LINE_UID_* тег
      if (!contactId) {
        warn(rid, "contactId missing -> cannot map to LINE user");
        return;
      }

      // получаем контакт и вытаскиваем LINE userId из тега
      let contact;
      try {
        contact = await getKommoContactById(contactId, rid);
      } catch (e) {
        errlog(
          rid,
          "Failed to fetch Kommo contact:",
          e?.response?.status ? `HTTP ${e.response.status}` : e.message,
          e?.response?.data ? JSON.stringify(e.response.data) : ""
        );
        return;
      }

      const lineUserId = extractLineUserIdFromContact(contact);
      if (!lineUserId) {
        warn(rid, "No LINE userId found in contact tags -> cannot send");
        return;
      }

      // отправляем в LINE
      await sendLinePush(lineUserId, replyText, rid);

      // (опционально) логируем в Kommo, что отправили в LINE
      if (leadId) {
        try {
          await addLeadNote(toInt(leadId), `Sent to LINE: ${replyText}`, rid);
        } catch (e) {
          warn(
            rid,
            "Could not add 'Sent to LINE' note:",
            e?.response?.status ? `HTTP ${e.response.status}` : e.message
          );
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
