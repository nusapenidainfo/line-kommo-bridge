// index.js
// Связка:
// 1) LINE webhook -> Kommo:
//    - получить displayName из LINE
//    - найти/создать контакт по тегу LINE_UID_<userId>
//    - найти/создать "чат-лид" (тег LINE_CHAT) и писать сообщения в notes
// 2) Kommo webhook (Emfy Webhooks) -> отправка текста ответа в LINE (push)
// + Диагностика: /status, /debug/env, /debug/kommo, /debug/line

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const querystring = require("querystring");

const app = express();

/** -------------------- Логи -------------------- */
function nowIso() {
  return new Date().toISOString();
}
function rid() {
  return Math.random().toString(36).slice(2, 10);
}
function log(r, ...args) {
  console.log(`[${nowIso()}] [RID:${r}]`, ...args);
}
function warn(r, ...args) {
  console.warn(`[${nowIso()}] [RID:${r}] ⚠️`, ...args);
}
function errlog(r, ...args) {
  console.error(`[${nowIso()}] [RID:${r}] ❌`, ...args);
}

/** -------------------- ENV helpers -------------------- */
function mask(s) {
  if (!s || typeof s !== "string") return "";
  if (s.length <= 8) return "***";
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}
function getKommoToken() {
  return process.env.KOMMO_ACCESS_TOKEN || process.env.KOMMO_API_KEY || "";
}
function getKommoSubdomain() {
  return process.env.KOMMO_SUBDOMAIN || "";
}
function getLineAccessToken() {
  return process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
}
function getLineChannelSecret() {
  return process.env.LINE_CHANNEL_SECRET || "";
}
function getKommoPipelineId() {
  const v = process.env.KOMMO_PIPELINE_ID;
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** -------------------- Root + status + debug -------------------- */
app.get("/", (req, res) => {
  res.json({ ok: true, service: "line-kommo-bridge", ts: nowIso() });
});

app.get("/status", (req, res) => {
  res.json({
    ok: true,
    service: "line-kommo-bridge",
    timestamp: nowIso(),
  });
});

app.get("/debug/env", (req, res) => {
  const kommoToken = getKommoToken();
  const lineToken = getLineAccessToken();
  res.json({
    ok: true,
    KOMMO_SUBDOMAIN: !!getKommoSubdomain(),
    KOMMO_ACCESS_TOKEN_or_API_KEY: !!kommoToken,
    KOMMO_TOKEN_MASK: kommoToken ? mask(kommoToken) : "",
    LINE_CHANNEL_SECRET: !!getLineChannelSecret(),
    LINE_CHANNEL_ACCESS_TOKEN: !!lineToken,
    LINE_TOKEN_MASK: lineToken ? mask(lineToken) : "",
    KOMMO_PIPELINE_ID: process.env.KOMMO_PIPELINE_ID || "",
    ts: nowIso(),
  });
});

app.get("/debug/kommo", async (req, res) => {
  const r = rid();
  try {
    const subdomain = getKommoSubdomain();
    const token = getKommoToken();
    if (!subdomain || !token) {
      return res.status(400).json({
        ok: false,
        error: "Missing KOMMO_SUBDOMAIN or KOMMO_ACCESS_TOKEN/KOMMO_API_KEY",
      });
    }
    const url = `https://${subdomain}.kommo.com/api/v4/account`;
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
    });
    log(r, "[DEBUG/KOMMO] account ok:", resp.status);
    res.json({
      ok: true,
      status: resp.status,
      account_id: resp.data?.id,
      name: resp.data?.name,
    });
  } catch (e) {
    errlog(r, "[DEBUG/KOMMO] failed:", e.response?.status, e.message);
    res.status(500).json({
      ok: false,
      status: e.response?.status || null,
      error: e.response?.data || e.message,
    });
  }
});

app.get("/debug/line", async (req, res) => {
  const r = rid();
  try {
    const token = getLineAccessToken();
    if (!token) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing LINE_CHANNEL_ACCESS_TOKEN" });
    }
    const url = "https://api.line.me/v2/bot/info";
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
    });
    log(r, "[DEBUG/LINE] bot info ok:", resp.status);
    res.json({ ok: true, status: resp.status, bot: resp.data });
  } catch (e) {
    errlog(r, "[DEBUG/LINE] failed:", e.response?.status, e.message);
    res.status(500).json({
      ok: false,
      status: e.response?.status || null,
      error: e.response?.data || e.message,
    });
  }
});

/** -------------------- LINE signature -------------------- */
function verifyLineSignature(bodyString, signature) {
  const secret = getLineChannelSecret();
  if (!secret || !signature) return true;
  try {
    const hash = crypto
      .createHmac("sha256", secret)
      .update(bodyString)
      .digest("base64");
    return hash === signature;
  } catch (_) {
    return false;
  }
}

/** -------------------- LINE API -------------------- */
async function fetchLineProfile(r, userId) {
  const token = getLineAccessToken();
  if (!token) return null;
  try {
    const url = `https://api.line.me/v2/bot/profile/${encodeURIComponent(
      userId
    )}`;
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
    });
    return resp.data || null;
  } catch (e) {
    warn(
      r,
      "[LINE] profile fetch failed:",
      e.response?.status,
      JSON.stringify(e.response?.data || e.message)
    );
    return null;
  }
}

async function sendLinePush(r, to, text) {
  const token = getLineAccessToken();
  if (!token) return { ok: false, error: "missing_line_token" };

  const url = "https://api.line.me/v2/bot/message/push";
  const payload = { to, messages: [{ type: "text", text: String(text || "") }] };

  try {
    const resp = await axios.post(url, payload, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      timeout: 10000,
    });
    log(r, "[LINE] push sent:", resp.status, "to", to);
    return { ok: true, status: resp.status };
  } catch (e) {
    errlog(
      r,
      "[LINE] push error:",
      e.response?.status,
      JSON.stringify(e.response?.data || e.message)
    );
    return { ok: false, status: e.response?.status || null, error: e.response?.data || e.message };
  }
}

/** -------------------- Kommo API helper -------------------- */
function kommoBaseUrl() {
  const sub = getKommoSubdomain();
  return sub ? `https://${sub}.kommo.com/api/v4` : "";
}

async function kommoRequest(r, method, path, { params, data } = {}) {
  const token = getKommoToken();
  const base = kommoBaseUrl();
  if (!base || !token) throw new Error("KOMMO creds missing");

  const url = `${base}${path}`;
  try {
    const resp = await axios({
      method,
      url,
      params,
      data,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeout: 15000,
    });
    return resp;
  } catch (e) {
    const status = e.response?.status;
    const payload = e.response?.data || e.message;
    errlog(r, `[KOMMO] ${method} ${path} failed:`, status, JSON.stringify(payload));
    throw e;
  }
}

/** -------------------- Kommo business logic -------------------- */
const TAG_LINE = "LINE";
const TAG_LINE_CHAT = "LINE_CHAT";

function lineUidTag(lineUserId) {
  return `LINE_UID_${lineUserId}`;
}

function leadHasTag(lead, tagName) {
  const tags = lead?._embedded?.tags || [];
  return tags.some((t) => t?.name === tagName);
}

async function findKommoContactByLineUid(r, lineUserId) {
  const tag = lineUidTag(lineUserId);

  // query должен быть строкой!
  try {
    const resp = await kommoRequest(r, "GET", "/contacts", {
      params: { query: tag, limit: 50 },
    });
    const list = resp.data?._embedded?.contacts || [];
    if (list.length > 0) return list[0];
  } catch (_) {}

  try {
    const resp = await kommoRequest(r, "GET", "/contacts", {
      params: { "filter[query]": tag, limit: 50 },
    });
    const list = resp.data?._embedded?.contacts || [];
    if (list.length > 0) return list[0];
  } catch (_) {}

  return null;
}

async function createKommoContactForLine(r, { lineUserId, displayName }) {
  const uid = lineUidTag(lineUserId);
  const safeName = displayName ? String(displayName).trim() : "";
  const contactName = safeName ? `[LINE] ${safeName}` : `[LINE] ${lineUserId}`;

  const payload = [
    {
      name: contactName.slice(0, 250),
      _embedded: {
        tags: [{ name: TAG_LINE }, { name: uid }],
      },
    },
  ];

  const resp = await kommoRequest(r, "POST", "/contacts", { data: payload });
  return Array.isArray(resp.data) ? resp.data[0] : null;
}

async function updateKommoContactNameIfNeeded(r, contact, displayName) {
  if (!contact?.id || !displayName) return;
  const desired = `[LINE] ${String(displayName).trim()}`.slice(0, 250);
  if (String(contact.name || "") === desired) return;

  try {
    await kommoRequest(r, "PATCH", "/contacts", {
      data: [{ id: contact.id, name: desired }],
    });
    log(r, "[KOMMO] contact name updated:", contact.id, "->", desired);
  } catch (_) {
    warn(r, "[KOMMO] contact name update failed:", contact.id);
  }
}

async function findLineChatLeadForContact(r, contactId) {
  if (!contactId) return null;

  const pipelineId = getKommoPipelineId();

  // берём лиды по контакту, подтягиваем tags
  const params = {
    limit: 50,
    order: "updated_at:desc",
    with: "contacts,tags",
    "filter[contacts][id]": contactId,
  };

  const resp = await kommoRequest(r, "GET", "/leads", { params });
  const leads = resp.data?._embedded?.leads || [];
  if (!Array.isArray(leads) || leads.length === 0) return null;

  // 1) сначала ищем незакрытый лид с тегом LINE_CHAT
  let candidate = leads.find((l) => !l.closed_at && leadHasTag(l, TAG_LINE_CHAT));

  // 2) если pipelineId задан — ограничим поиск по pipeline
  if (!candidate && pipelineId) {
    candidate = leads.find(
      (l) => !l.closed_at && leadHasTag(l, TAG_LINE_CHAT) && Number(l.pipeline_id) === pipelineId
    );
  }

  return candidate || null;
}

async function createLineChatLead(r, { contactId, displayName, lineUserId }) {
  const pipelineId = getKommoPipelineId();

  const leadName = displayName
    ? `[LINE] ${String(displayName).trim()}`
    : `[LINE] ${lineUserId}`;

  const lead = {
    name: leadName.slice(0, 250),
    _embedded: {
      contacts: [{ id: contactId }],
      tags: [{ name: TAG_LINE }, { name: TAG_LINE_CHAT }],
    },
  };

  if (pipelineId) lead.pipeline_id = pipelineId;

  const resp = await kommoRequest(r, "POST", "/leads", { data: [lead] });
  return Array.isArray(resp.data) ? resp.data[0] : null;
}

async function addLeadNote(r, leadId, noteText) {
  const payload = [
    {
      entity_id: leadId,
      note_type: "common",
      params: { text: String(noteText || "") },
    },
  ];
  const resp = await kommoRequest(r, "POST", "/leads/notes", { data: payload });
  return resp.status;
}

/** -------------------- LINE webhook business handler -------------------- */
async function handleLineTextMessage(r, { lineUserId, text }) {
  log(r, "✅ New LINE text:", { lineUserId, text });

  // 1) LINE profile
  const profile = await fetchLineProfile(r, lineUserId);
  const displayName = profile?.displayName ? String(profile.displayName) : "";
  if (profile) {
    log(r, "👤 LINE profile:", {
      userId: profile.userId,
      displayName: profile.displayName,
      statusMessage: profile.statusMessage,
    });
  }

  // 2) Kommo creds check
  const subdomain = getKommoSubdomain();
  const token = getKommoToken();
  if (!subdomain || !token) {
    warn(r, "KOMMO creds missing -> skip Kommo", {
      KOMMO_SUBDOMAIN: !!subdomain,
      KOMMO_TOKEN: !!token,
    });
    return;
  }

  // 3) contact
  const uidTag = lineUidTag(lineUserId);
  log(r, "[KOMMO] find contact by tag:", uidTag);

  let contact = await findKommoContactByLineUid(r, lineUserId);
  if (!contact) {
    log(r, "[KOMMO] contact not found -> create");
    contact = await createKommoContactForLine(r, { lineUserId, displayName });
    log(r, "[KOMMO] contact created:", { id: contact?.id || null, name: contact?.name || null });
  } else {
    log(r, "[KOMMO] contact found:", { id: contact.id, name: contact.name });
    await updateKommoContactNameIfNeeded(r, contact, displayName);
  }

  const contactId = contact?.id;
  if (!contactId) {
    warn(r, "[KOMMO] contactId missing -> stop");
    return;
  }

  // 4) LINE_CHAT lead only (не цепляемся к booking лидам!)
  let lead = await findLineChatLeadForContact(r, contactId);
  if (!lead) {
    log(r, "[KOMMO] no LINE_CHAT lead -> create new chat lead");
    lead = await createLineChatLead(r, { contactId, displayName, lineUserId });
    log(r, "[KOMMO] LINE_CHAT lead created:", { id: lead?.id || null, name: lead?.name || null });
  } else {
    log(r, "[KOMMO] using LINE_CHAT lead:", { id: lead.id, name: lead.name });
  }

  const leadId = lead?.id;
  if (!leadId) {
    warn(r, "[KOMMO] leadId missing -> stop");
    return;
  }

  // 5) note into lead feed
  const header = displayName ? `LINE message from ${displayName}` : `LINE message`;
  const noteText =
    `${header}\n` +
    `LINE userId: ${lineUserId}\n` +
    `---\n` +
    `${String(text || "").trim()}`;

  const st = await addLeadNote(r, leadId, noteText);
  log(r, "[KOMMO] note added:", { leadId, status: st });
}

/** -------------------- LINE webhook handler -------------------- */
// ВАЖНО: отвечаем LINE быстро, обработку делаем async, чтобы не ловить timeout.
app.post("/line/webhook", express.raw({ type: "*/*" }), async (req, res) => {
  const r = rid();
  const signature = req.header("x-line-signature");
  const bodyString = Buffer.isBuffer(req.body)
    ? req.body.toString("utf8")
    : String(req.body || "");

  log(r, "➡️ /line/webhook", {
    contentType: req.header("content-type"),
    len: bodyString.length,
    hasSignature: !!signature,
  });

  if (!verifyLineSignature(bodyString, signature)) {
    errlog(r, "Bad LINE signature");
    return res.status(401).send("Bad signature");
  }

  let data;
  try {
    data = JSON.parse(bodyString);
  } catch (e) {
    errlog(r, "Cannot parse LINE JSON:", e.message);
    return res.status(400).send("Invalid JSON");
  }

  const events = Array.isArray(data?.events) ? data.events : [];
  log(r, "LINE events count:", events.length);

  // ACK сразу
  res.json({ ok: true });

  // обработка в фоне
  setImmediate(async () => {
    for (const ev of events) {
      try {
        const type = ev?.type;
        const msgType = ev?.message?.type;
        const source = ev?.source || {};
        const lineUserId =
          source.userId || source.groupId || source.roomId || "unknown";

        log(r, "LINE event:", { type, msgType, lineUserId, mode: ev?.mode, timestamp: ev?.timestamp });

        if (type === "message" && msgType === "text") {
          const text = ev?.message?.text || "";
          await handleLineTextMessage(r, { lineUserId, text });
        } else {
          log(r, "Skip non-text LINE event");
        }
      } catch (e) {
        errlog(r, "Error processing LINE event:", e.message);
      }
    }
  });
});

/** -------------------- Kommo webhook handler (Emfy) -------------------- */
function setCors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

function parseKommoBody(raw, contentType) {
  const s = typeof raw === "string" ? raw : String(raw || "");
  if ((contentType || "").includes("application/json")) {
    try {
      return JSON.parse(s);
    } catch (_) {
      return { _raw: s };
    }
  }
  return querystring.parse(s);
}

function extractFirstString(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function extractKommoIds(parsed) {
  const leadIdStr =
    extractFirstString(parsed, [
      "this_item[id]",
      "leads[add][0][id]",
      "leads[update][0][id]",
      "leads[status][0][id]",
      "lead_id",
      "leadId",
    ]) || "";

  const contactIdStr =
    extractFirstString(parsed, [
      "this_item[_embedded][contacts][0][id]",
      "contacts[add][0][id]",
      "contacts[update][0][id]",
      "contact_id",
      "contactId",
    ]) || "";

  const leadId = leadIdStr ? Number(leadIdStr) : null;
  const contactId = contactIdStr ? Number(contactIdStr) : null;

  return { leadId, contactId };
}

function extractReplyTextFromKommo(parsed) {
  const candidates = [
    "reply_text",
    "reply",
    "message",
    "text",
    "note[text]",
    "note_text",
    "this_item[text]",
    "chat[text]",
  ];
  return extractFirstString(parsed, candidates);
}

async function fetchLeadFirstContactId(r, leadId) {
  if (!leadId) return null;
  try {
    const resp = await kommoRequest(r, "GET", `/leads/${leadId}`, {
      params: { with: "contacts,tags" },
    });
    const contacts = resp.data?._embedded?.contacts || [];
    const first = contacts[0]?.id;
    return first ? Number(first) : null;
  } catch (_) {
    return null;
  }
}

async function fetchContactTags(r, contactId) {
  if (!contactId) return [];
  try {
    const resp = await kommoRequest(r, "GET", `/contacts/${contactId}`);
    const tags = resp.data?._embedded?.tags || [];
    return tags.map((t) => t?.name).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function extractLineUserIdFromTags(tags) {
  if (!Array.isArray(tags)) return "";
  const t = tags.find((x) => typeof x === "string" && x.startsWith("LINE_UID_"));
  return t ? t.replace("LINE_UID_", "") : "";
}

app.all("/kommo/webhook", express.text({ type: "*/*" }), async (req, res) => {
  const r = rid();
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const contentType = req.header("content-type") || "";
    const rawBody = req.body || "";
    const parsed = parseKommoBody(rawBody, contentType);

    log(r, "➡️ /kommo/webhook", {
      method: req.method,
      contentType,
      rawLen: typeof rawBody === "string" ? rawBody.length : String(rawBody).length,
    });

    const keys = parsed && typeof parsed === "object" ? Object.keys(parsed) : [];
    log(r, "Kommo parsed keys (first 40):", keys.slice(0, 40));

    let { leadId, contactId } = extractKommoIds(parsed);
    log(r, "Extracted IDs:", { leadId, contactId });

    const replyText = extractReplyTextFromKommo(parsed);
    if (!replyText) {
      log(r, "Kommo webhook without reply text -> skip sending to LINE");
      return res.json({ ok: true, skipped: true, reason: "no_reply_text", leadId, contactId });
    }

    // fallback: если contactId не пришёл — попробуем достать через lead
    if (!contactId && leadId) {
      contactId = await fetchLeadFirstContactId(r, leadId);
      log(r, "Fallback contactId from lead:", contactId);
    }

    if (!contactId) {
      warn(r, "No contactId -> cannot map to LINE userId");
      return res.json({ ok: false, error: "contactId_missing", leadId, replyText });
    }

    const tags = await fetchContactTags(r, contactId);
    const lineUserId = extractLineUserIdFromTags(tags);

    if (!lineUserId) {
      warn(r, "No LINE userId in contact tags -> cannot send");
      return res.json({ ok: false, error: "no_line_userId_in_tags", leadId, contactId, replyText });
    }

    log(r, "Sending reply to LINE:", { lineUserId, preview: replyText.slice(0, 200) });
    const sendRes = await sendLinePush(r, lineUserId, replyText);

    return res.json({
      ok: true,
      leadId,
      contactId,
      lineUserId,
      sent: sendRes.ok,
      lineStatus: sendRes.status || null,
    });
  } catch (e) {
    errlog(r, "Error in /kommo/webhook:", e.message);
    setCors(res);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/** -------------------- Start -------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`line-kommo-bridge is running on port ${PORT}`);
});
