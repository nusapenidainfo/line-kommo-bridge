// index.js
// Связка:
// 1) LINE webhook -> Kommo: найти/создать контакт (по LINE_UID tag) + найти/создать "активный" лид + добавить note с текстом
// 2) Kommo webhook (Emfy Webhooks) -> наш сервер -> отправить текст ответа в LINE (push)
// + Диагностика: /status, /debug/env, /debug/kommo, /debug/line
//
// ВАЖНО по env:
// LINE_CHANNEL_SECRET (для проверки подписи)
// LINE_CHANNEL_ACCESS_TOKEN (long-lived token для Messaging API)
// KOMMO_SUBDOMAIN
// KOMMO_ACCESS_TOKEN (рекомендуется) или KOMMO_API_KEY (старое имя, тоже поддерживаем)
// (опционально) KOMMO_PIPELINE_ID - если хотите всегда создавать лид в конкретной воронке

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const querystring = require("querystring");

const app = express();

/** -------------------- Утилиты логов -------------------- */
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
  // Поддерживаем 2 варианта, чтобы не ломалось при переименованиях env
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
  // НЕ показываем секреты, только факт наличия
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
  if (!secret || !signature) {
    // Если секрет/подпись не заданы — не блокируем (для диагностики),
    // но лучше всегда держать секрет включённым.
    return true;
  }
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

/** -------------------- LINE API -------------------- */
async function fetchLineProfile(r, userId) {
  const token = getLineAccessToken();
  if (!token) {
    warn(r, "[LINE] Missing LINE_CHANNEL_ACCESS_TOKEN, skip profile fetch");
    return null;
  }
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
  if (!token) {
    warn(r, "[LINE] Missing LINE_CHANNEL_ACCESS_TOKEN, cannot send");
    return { ok: false, error: "missing_line_token" };
  }
  const url = "https://api.line.me/v2/bot/message/push";
  const payload = {
    to,
    messages: [{ type: "text", text: String(text || "") }],
  };

  try {
    const resp = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
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
    return {
      ok: false,
      status: e.response?.status || null,
      error: e.response?.data || e.message,
    };
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
  if (!base || !token) {
    throw new Error("KOMMO_SUBDOMAIN or KOMMO_ACCESS_TOKEN/KOMMO_API_KEY is missing");
  }

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
// Мы идентифицируем LINE пользователя через tag: LINE_UID_<lineUserId>
function lineUidTag(lineUserId) {
  return `LINE_UID_${lineUserId}`;
}

// Поиск контакта по tag через query.
// Важно: query должен быть строкой, не объектом (это частая причина 400).
async function findKommoContactByLineUid(r, lineUserId) {
  const tag = lineUidTag(lineUserId);

  // пробуем query=
  try {
    const resp = await kommoRequest(r, "GET", "/contacts", {
      params: { query: tag, limit: 50 },
    });
    const list = resp.data?._embedded?.contacts || [];
    if (list.length > 0) return list[0];
  } catch (_) {
    // fallback ниже
  }

  // fallback: filter[query]
  try {
    const resp = await kommoRequest(r, "GET", "/contacts", {
      params: { "filter[query]": tag, limit: 50 },
    });
    const list = resp.data?._embedded?.contacts || [];
    if (list.length > 0) return list[0];
  } catch (_) {
    // no more
  }

  return null;
}

async function createKommoContactForLine(r, { lineUserId, displayName }) {
  const tagUid = lineUidTag(lineUserId);
  const safeName = displayName ? String(displayName).trim() : "";
  const contactName = safeName ? `[LINE] ${safeName}` : `[LINE] ${lineUserId}`;

  const payload = [
    {
      name: contactName.slice(0, 250),
      _embedded: {
        tags: [{ name: "LINE" }, { name: tagUid }],
      },
    },
  ];

  const resp = await kommoRequest(r, "POST", "/contacts", { data: payload });
  const created = Array.isArray(resp.data) ? resp.data[0] : null;
  return created;
}

async function updateKommoContactNameIfNeeded(r, contactId, desiredName) {
  if (!contactId || !desiredName) return;
  const payload = [{ id: contactId, name: desiredName.slice(0, 250) }];
  try {
    await kommoRequest(r, "PATCH", "/contacts", { data: payload });
    log(r, "[KOMMO] contact name updated:", contactId, "->", desiredName);
  } catch (e) {
    warn(r, "[KOMMO] contact name update failed:", contactId);
  }
}

// Найти "активный" лид по contactId (берём самый свежий незакрытый)
async function findActiveLeadForContact(r, contactId) {
  if (!contactId) return null;

  // Пробуем стандартный фильтр
  const tryList = async (params) => {
    const resp = await kommoRequest(r, "GET", "/leads", { params });
    return resp.data?._embedded?.leads || [];
  };

  let leads = [];
  try {
    leads = await tryList({
      limit: 50,
      order: "updated_at:desc",
      "filter[contacts][id]": contactId,
    });
  } catch (_) {
    // fallback формат массива
    try {
      leads = await tryList({
        limit: 50,
        order: "updated_at:desc",
        "filter[contacts][id][]": contactId,
      });
    } catch (_) {
      leads = [];
    }
  }

  if (!Array.isArray(leads) || leads.length === 0) return null;

  // выбираем незакрытый
  const active = leads.find((l) => !l.closed_at);
  return active || leads[0];
}

function extractServiceNameFromText(text) {
  // если текст из формы содержит строку "Service:" — используем для названия лида
  const s = String(text || "");
  const m = s.match(/^\s*Service:\s*(.+)\s*$/im);
  if (m && m[1]) return m[1].trim().slice(0, 60);
  return "";
}

async function createLeadForContact(r, { contactId, displayName, text }) {
  const pipelineId = process.env.KOMMO_PIPELINE_ID ? Number(process.env.KOMMO_PIPELINE_ID) : null;
  const service = extractServiceNameFromText(text);
  const baseName = displayName ? `[LINE] ${displayName}` : `[LINE] ${contactId}`;
  const leadName = service ? `${baseName} — ${service}` : baseName;

  const lead = {
    name: leadName.slice(0, 250),
    _embedded: {
      contacts: [{ id: contactId }],
      tags: [{ name: "LINE" }],
    },
  };

  if (pipelineId && Number.isFinite(pipelineId)) {
    lead.pipeline_id = pipelineId;
  }

  const resp = await kommoRequest(r, "POST", "/leads", { data: [lead] });
  const created = Array.isArray(resp.data) ? resp.data[0] : null;
  return created;
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

/** -------------------- LINE webhook handler -------------------- */
async function handleLineTextMessage(r, { lineUserId, text }) {
  log(r, "✅ New LINE text:", { lineUserId, text });

  // 1) Профиль LINE (displayName)
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
    warn(r, "KOMMO creds missing -> skip Kommo part", {
      KOMMO_SUBDOMAIN: !!subdomain,
      KOMMO_TOKEN: !!token,
    });
    return;
  }

  // 3) Найти/создать контакт по tag LINE_UID_<id>
  const uidTag = lineUidTag(lineUserId);
  log(r, "[KOMMO] find contact by tag:", uidTag);

  let contact = await findKommoContactByLineUid(r, lineUserId);
  if (!contact) {
    log(r, "[KOMMO] contact not found -> create");
    contact = await createKommoContactForLine(r, { lineUserId, displayName });
    log(r, "[KOMMO] contact created:", {
      id: contact?.id || null,
      name: contact?.name || null,
    });
  } else {
    log(r, "[KOMMO] contact found:", {
      id: contact.id,
      name: contact.name,
    });

    // обновим имя контакта на displayName (если есть)
    if (displayName) {
      const desired = `[LINE] ${displayName}`.slice(0, 250);
      if (String(contact.name || "") !== desired) {
        await updateKommoContactNameIfNeeded(r, contact.id, desired);
      }
    }
  }

  const contactId = contact?.id;
  if (!contactId) {
    warn(r, "[KOMMO] contactId missing -> cannot continue");
    return;
  }

  // 4) Найти активный лид по контакту, иначе создать
  let lead = await findActiveLeadForContact(r, contactId);
  if (!lead) {
    log(r, "[KOMMO] no active lead -> create new lead for contact:", contactId);
    lead = await createLeadForContact(r, { contactId, displayName, text });
    log(r, "[KOMMO] lead created:", {
      id: lead?.id || null,
      name: lead?.name || null,
    });
  } else {
    log(r, "[KOMMO] using existing lead:", {
      id: lead.id,
      name: lead.name,
      closed_at: lead.closed_at,
    });
  }

  const leadId = lead?.id;
  if (!leadId) {
    warn(r, "[KOMMO] leadId missing -> cannot add note");
    return;
  }

  // 5) Добавить note (сообщение клиента) — это то, что будет видно в ленте лида
  const header = displayName
    ? `LINE message from ${displayName}`
    : `LINE message`;
  const noteText =
    `${header}\n` +
    `LINE userId: ${lineUserId}\n` +
    `---\n` +
    `${String(text || "").trim()}`;

  const st = await addLeadNote(r, leadId, noteText);
  log(r, "[KOMMO] note added:", { leadId, status: st });
}

app.post("/line/webhook", express.raw({ type: "*/*" }), async (req, res) => {
  const r = rid();
  const signature = req.header("x-line-signature");
  const bodyString = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body || "");

  // ЛОГ: факт прихода вебхука
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

  for (const ev of events) {
    try {
      const type = ev?.type;
      const msgType = ev?.message?.type;
      const source = ev?.source || {};
      const lineUserId = source.userId || source.groupId || source.roomId || "unknown";

      // Покажем базовые поля события (очень полезно для диагностики)
      log(r, "LINE event:", {
        type,
        msgType,
        lineUserId,
        mode: ev?.mode,
        timestamp: ev?.timestamp,
      });

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

  res.json({ ok: true });
});

/** -------------------- Kommo webhook handler (Emfy) -------------------- */
function setCors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

function parseKommoBody(raw, contentType) {
  const s = typeof raw === "string" ? raw : String(raw || "");

  // если прислали JSON
  if ((contentType || "").includes("application/json")) {
    try {
      return JSON.parse(s);
    } catch (_) {
      return { _raw: s };
    }
  }

  // чаще всего x-www-form-urlencoded
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
  // стараемся достать leadId/contactId максимально гибко
  const leadIdStr =
    extractFirstString(parsed, [
      "this_item[id]",
      "leads[add][0][id]",
      "leads[update][0][id]",
      "leads[status][0][id]",
      "leads[0][id]",
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
  // Здесь мы пытаемся понять, где Emfy/Kommo прислал текст,
  // который нужно отправить в LINE.
  //
  // ВАЖНО: у вас сейчас часто приходят системные события без текста — мы их игнорируем.
  // Если вы используете кнопку/виджет "LINE Reply", обычно она передаёт поле text/message/reply_text.
  //
  // Мы ищем сразу несколько возможных ключей.
  const candidates = [
    "reply_text",
    "reply",
    "message",
    "text",
    "note[text]",
    "note_text",
    "this_item[text]",
    "this_item[note][text]",
    "this_item[note][0][text]",
    "chat[text]",
  ];

  const t = extractFirstString(parsed, candidates);
  return t;
}

async function fetchKommoContactTags(r, contactId) {
  if (!contactId) return [];
  try {
    const resp = await kommoRequest(r, "GET", `/contacts/${contactId}`);
    const tags = resp.data?._embedded?.tags || [];
    return tags.map((t) => t?.name).filter(Boolean);
  } catch (e) {
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

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const contentType = req.header("content-type") || "";
    const rawBody = req.body || "";
    const parsed = parseKommoBody(rawBody, contentType);

    // Логи: метод, content-type, длина
    log(r, "➡️ /kommo/webhook", {
      method: req.method,
      contentType,
      rawLen: typeof rawBody === "string" ? rawBody.length : String(rawBody).length,
    });

    // Короткий список ключей — супер важно для диагностики
    const keys = parsed && typeof parsed === "object" ? Object.keys(parsed) : [];
    log(r, "Kommo parsed keys (first 40):", keys.slice(0, 40));

    const { leadId, contactId } = extractKommoIds(parsed);
    log(r, "Extracted IDs:", { leadId, contactId });

    const replyText = extractReplyTextFromKommo(parsed);
    if (!replyText) {
      log(r, "Kommo webhook without reply text (system event?) -> skip sending to LINE");
      return res.json({ ok: true, skipped: true, reason: "no_reply_text", leadId, contactId });
    }

    // Достаем lineUserId из контакта по tag LINE_UID_
    const subdomain = getKommoSubdomain();
    const token = getKommoToken();
    if (!subdomain || !token) {
      warn(r, "Kommo creds missing -> cannot map contact to LINE userId");
      return res.json({ ok: false, error: "kommo_creds_missing", leadId, contactId });
    }

    const tags = await fetchKommoContactTags(r, contactId);
    const lineUserId = extractLineUserIdFromTags(tags);

    if (!lineUserId) {
      warn(r, "No LINE userId found in contact tags -> cannot send");
      return res.json({
        ok: false,
        error: "no_line_userId_in_contact_tags",
        leadId,
        contactId,
        replyText,
      });
    }

    log(r, "Sending reply to LINE:", { lineUserId, replyText });
    const sendRes = await sendLinePush(r, lineUserId, replyText);

    res.json({
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
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** -------------------- Start -------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`line-kommo-bridge is running on port ${PORT}`);
});
