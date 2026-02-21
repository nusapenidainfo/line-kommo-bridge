// index.js
// Диагностическая версия LINE ↔ Kommo bridge
// 1) Подробно логирует, какие ENV-переменные реально видит Node
// 2) Принимает вебхук из LINE и, если есть креды Kommo, создаёт/находит контакт и лид и пишет note
// 3) Вебхук из Kommo пока только логируется и отвечает JSON { ok: true }

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

// ======================= БАЗОВАЯ НАСТРОЙКА =======================

const app = express();
app.use(bodyParser.json());

function logTs(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

// Читаем ENV-переменные (важно: имена должны совпадать с тем, что задано в Render)
const PORT = process.env.PORT || 10000;

const LINE_CHANNEL_TOKEN = process.env.LINE_CHANNEL_TOKEN || "";
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || ""; // пока не используем, но логируем

const KOMMO_BASE_URL = process.env.KOMMO_BASE_URL || "";
const KOMMO_ACCESS_TOKEN = process.env.KOMMO_ACCESS_TOKEN || "";
const KOMMO_PIPELINE_ID = process.env.KOMMO_PIPELINE_ID || "";
const KOMMO_STATUS_ID = process.env.KOMMO_STATUS_ID || "";
const KOMMO_TAG_ID_LINE = process.env.KOMMO_TAG_ID_LINE || ""; // может быть пустой

// Удобные ф-ции для диагностического вывода
function lenOr0(value) {
  if (!value) return 0;
  return String(value).length;
}

function shortValue(value) {
  if (!value) return "(empty)";
  const s = String(value);
  if (s.length <= 8) return "*".repeat(s.length);
  return `${s.slice(0, 4)}***${s.slice(-4)}`;
}

// Проверяем, считаем ли мы, что креды Kommo заданы
const hasKommoCreds =
  !!KOMMO_BASE_URL && !!KOMMO_ACCESS_TOKEN && !!KOMMO_PIPELINE_ID && !!KOMMO_STATUS_ID;

// Диагностический дамп конфига при старте
logTs("=== CONFIG DUMP START ===");
logTs("[CONFIG] PORT =", PORT);
logTs("[CONFIG] LINE_CHANNEL_TOKEN length =", lenOr0(LINE_CHANNEL_TOKEN));
logTs("[CONFIG] LINE_CHANNEL_SECRET length =", lenOr0(LINE_CHANNEL_SECRET));

logTs("[CONFIG] KOMMO_BASE_URL =", KOMMO_BASE_URL || "(empty)");
logTs("[CONFIG] KOMMO_ACCESS_TOKEN length =", lenOr0(KOMMO_ACCESS_TOKEN));
logTs("[CONFIG] KOMMO_PIPELINE_ID =", KOMMO_PIPELINE_ID || "(empty)");
logTs("[CONFIG] KOMMO_STATUS_ID =", KOMMO_STATUS_ID || "(empty)");
logTs("[CONFIG] KOMMO_TAG_ID_LINE =", KOMMO_TAG_ID_LINE || "(empty)");

logTs("[CONFIG] hasKommoCreds =", hasKommoCreds);
if (!hasKommoCreds) {
  logTs(
    "[WARN] Kommo creds are incomplete. LINE сообщения будут приниматься, но в Kommo не отправятся."
  );
}
logTs("=== CONFIG DUMP END ===");

// Общий axios-клиент для Kommo (используем только если hasKommoCreds = true)
const kommo = axios.create({
  baseURL: KOMMO_BASE_URL.replace(/\/+$/, ""), // убираем хвостовой слэш на всякий случай
  headers: KOMMO_ACCESS_TOKEN
    ? {
        Authorization: `Bearer ${KOMMO_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      }
    : {},
  timeout: 15000,
});

// ======================= ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =======================

// Тянем профиль пользователя из LINE по его userId
async function getLineUserProfile(lineUserId) {
  if (!LINE_CHANNEL_TOKEN) {
    logTs(
      "[WARN] LINE_CHANNEL_TOKEN не задан — профиль LINE получить не можем. Вернём только userId."
    );
    return { userId: lineUserId, displayName: null };
  }

  try {
    const url = `https://api.line.me/v2/bot/profile/${encodeURIComponent(lineUserId)}`;
    const res = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${LINE_CHANNEL_TOKEN}`,
      },
      timeout: 10000,
    });

    return {
      userId: lineUserId,
      displayName: res.data.displayName || null,
      pictureUrl: res.data.pictureUrl || null,
      statusMessage: res.data.statusMessage || null,
      language: res.data.language || null,
      raw: res.data,
    };
  } catch (err) {
    logTs("[ERROR] Не удалось получить профиль LINE:", err.message);
    if (err.response) {
      logTs(
        "[ERROR] LINE profile response:",
        err.response.status,
        JSON.stringify(err.response.data, null, 2)
      );
    }
    // Даже если профиль не получили, продолжаем только с userId
    return { userId: lineUserId, displayName: null };
  }
}

// Универсальный лог ошибок Kommo
function logKommoError(prefix, error) {
  if (!error) {
    logTs(prefix, "Unknown error");
    return;
  }
  if (error.response) {
    logTs(
      prefix,
      "HTTP",
      error.response.status,
      JSON.stringify(error.response.data, null, 2)
    );
  } else {
    logTs(prefix, error.message || String(error));
  }
}

// ======================= РАБОТА С KOMMO =======================

// 1. Ищем или создаём контакт по LINE userId
async function findOrCreateKommoContact(lineUserId, profile) {
  if (!hasKommoCreds) {
    logTs(
      "[WARN] findOrCreateKommoContact вызван, но hasKommoCreds = false — пропускаем шаг работы с Kommo."
    );
    return null;
  }

  const searchQuery = lineUserId; // будем искать по userId в имени
  const contactName = `[LINE] ${
    profile && profile.displayName ? profile.displayName : "LINE user"
  } (${lineUserId})`;

  try {
    // Сначала пробуем найти контакт
    logTs(
      "[KOMMO] Поиск контакта по query (lineUserId):",
      JSON.stringify({ query: searchQuery })
    );

    const searchRes = await kommo.get("/api/v4/contacts", {
      params: { query: searchQuery, limit: 1 },
    });

    const existing = searchRes.data && Array.isArray(searchRes.data._embedded?.contacts)
      ? searchRes.data._embedded.contacts[0]
      : null;

    if (existing) {
      logTs("[KOMMO] Найден существующий контакт:", {
        id: existing.id,
        name: existing.name,
      });
      return { id: existing.id, name: existing.name };
    }

    // Контакт не найден — создаём новый
    const tags = [];

    // Базовый LINE-тег, если задан ID
    const lineTagId = KOMMO_TAG_ID_LINE && Number(KOMMO_TAG_ID_LINE);
    if (!Number.isNaN(lineTagId) && lineTagId > 0) {
      tags.push({ id: lineTagId });
    }

    // На всякий случай даём тег по имени "LINE" и персональный тег с userId
    tags.push({ name: "LINE" });
    tags.push({ name: `LINE_UID_${lineUserId}` });

    const contactPayload = [
      {
        name: contactName,
        _embedded: {
          tags,
        },
      },
    ];

    logTs("[KOMMO] Создаём новый контакт:", JSON.stringify(contactPayload, null, 2));

    const createRes = await kommo.post("/api/v4/contacts", contactPayload);

    const created =
      createRes.data && Array.isArray(createRes.data._embedded?.contacts)
        ? createRes.data._embedded.contacts[0]
        : null;

    if (!created) {
      logTs("[ERROR] Ответ Kommo на создание контакта без данных _embedded.contacts");
      return null;
    }

    logTs("[KOMMO] Контакт создан:", { id: created.id, name: created.name });
    return { id: created.id, name: created.name };
  } catch (err) {
    logKommoError("[ERROR] Ошибка при поиске/создании контакта Kommo:", err);
    return null;
  }
}

// 2. Ищем или создаём лид для контакта
async function findOrCreateKommoLead(contact, profile, lastText) {
  if (!hasKommoCreds) return null;
  if (!contact || !contact.id) {
    logTs("[WARN] findOrCreateKommoLead: контакт не задан, пропускаем.");
    return null;
  }

  try {
    logTs("[KOMMO] Ищем лиды по contact_id:", contact.id);
    const leadsRes = await kommo.get("/api/v4/leads", {
      params: {
        "filter[contacts][id]": contact.id,
        limit: 1,
      },
    });

    const existing =
      leadsRes.data && Array.isArray(leadsRes.data._embedded?.leads)
        ? leadsRes.data._embedded.leads[0]
        : null;

    if (existing) {
      logTs("[KOMMO] Используем существующий лид:", {
        id: existing.id,
        name: existing.name,
        status_id: existing.status_id,
        pipeline_id: existing.pipeline_id,
      });
      return { id: existing.id, name: existing.name };
    }

    // Лид не найден — создаём
    const leadName =
      lastText && lastText.trim().length > 0
        ? lastText.trim().slice(0, 60)
        : `[LINE] ${profile && profile.displayName ? profile.displayName : "New lead"}`;

    const leadPayload = [
      {
        name: leadName,
        pipeline_id: Number(KOMMO_PIPELINE_ID),
        status_id: Number(KOMMO_STATUS_ID),
        _embedded: {
          contacts: [{ id: contact.id }],
          tags: [{ name: "LINE" }],
        },
      },
    ];

    logTs("[KOMMO] Создаём новый лид:", JSON.stringify(leadPayload, null, 2));

    const createRes = await kommo.post("/api/v4/leads", leadPayload);

    const created =
      createRes.data && Array.isArray(createRes.data._embedded?.leads)
        ? createRes.data._embedded.leads[0]
        : null;

    if (!created) {
      logTs("[ERROR] Ответ Kommo на создание лида без данных _embedded.leads");
      return null;
    }

    logTs("[KOMMO] Лид создан:", { id: created.id, name: created.name });
    return { id: created.id, name: created.name };
  } catch (err) {
    logKommoError("[ERROR] Ошибка при поиске/создании лида:", err);
    return null;
  }
}

// 3. Добавляем note с текстом сообщения LINE в лид
async function addLineMessageNoteToLead(leadId, lineUserId, text) {
  if (!hasKommoCreds) return;
  if (!leadId) {
    logTs("[WARN] addLineMessageNoteToLead: leadId пустой, note не создаём.");
    return;
  }

  const finalText =
    text && text.trim().length > 0
      ? text.trim()
      : "(пустое сообщение или неизвестный текст)";

  const note = [
    {
      entity_id: Number(leadId),
      note_type: "common",
      params: {
        text: `LINE message (${lineUserId}): ${finalText}`,
      },
    },
  ];

  try {
    logTs("[KOMMO] Добавляем note к лиду:", JSON.stringify(note, null, 2));
    const res = await kommo.post("/api/v4/leads/notes", note);
    logTs("[KOMMO] Note создан, статус:", res.status);
  } catch (err) {
    logKommoError("[ERROR] Ошибка при создании note для лида:", err);
  }
}

// ======================= ОБРАБОТКА ВЕБХУКА ИЗ LINE =======================

async function handleLineWebhook(req, res) {
  try {
    const body = req.body;
    // Базовый лог — чтобы точно видеть, что вебхук приходит
    logTs("[LINE] Входящий вебхук:", JSON.stringify(body, null, 2));

    if (!body || !Array.isArray(body.events) || body.events.length === 0) {
      logTs("[LINE] Нет events в теле вебхука.");
      return res.status(200).json({ ok: true, message: "no events" });
    }

    // Берём только первое событие для простоты
    const event = body.events[0];

    if (!event || event.type !== "message" || !event.message || event.message.type !== "text") {
      logTs("[LINE] Событие не text-message, пропускаем.");
      return res.status(200).json({ ok: true, message: "ignored event type" });
    }

    const lineUserId = event.source && event.source.userId ? event.source.userId : null;
    const text = event.message && event.message.text ? event.message.text : "";

    logTs("[LINE] Новый текст из LINE {", `lineUserId: '${lineUserId}'`, `text: '${text}'`, "}");

    if (!lineUserId) {
      logTs("[ERROR] В событии LINE нет source.userId — не можем связать с контактом.");
      return res.status(200).json({ ok: false, reason: "no userId" });
    }

    // Тянем профиль пользователя из LINE
    const profile = await getLineUserProfile(lineUserId);
    logTs("[LINE] Получен профиль LINE пользователя:", JSON.stringify(profile, null, 2));

    if (!hasKommoCreds) {
      logTs(
        "[WARN] Команда findOrCreateKommoContact пропущена – нет Kommo-кредов. Детали:",
        {
          KOMMO_BASE_URL: KOMMO_BASE_URL || "(empty)",
          KOMMO_ACCESS_TOKEN_length: lenOr0(KOMMO_ACCESS_TOKEN),
          KOMMO_PIPELINE_ID: KOMMO_PIPELINE_ID || "(empty)",
          KOMMO_STATUS_ID: KOMMO_STATUS_ID || "(empty)",
        }
      );
      // Для LINE возвращаем 200, чтобы вебхук считался обработанным
      return res.status(200).json({ ok: true, message: "no kommo creds" });
    }

    // 1) Контакт
    const contact = await findOrCreateKommoContact(lineUserId, profile);
    if (!contact || !contact.id) {
      logTs("[ERROR] Не удалось получить/создать контакт Kommo; дальше не идём.");
      return res.status(200).json({ ok: false, reason: "no contact" });
    }

    // 2) Лид
    const lead = await findOrCreateKommoLead(contact, profile, text);
    if (!lead || !lead.id) {
      logTs("[ERROR] Не удалось получить/создать лид Kommo; дальше не идём.");
      return res.status(200).json({ ok: false, reason: "no lead" });
    }

    // 3) Note с текстом сообщения
    await addLineMessageNoteToLead(lead.id, lineUserId, text);

    return res.status(200).json({ ok: true });
  } catch (err) {
    logTs("[ERROR] Общая ошибка обработчика LINE вебхука:", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// ======================= ОБРАБОТКА ВЕБХУКА ИЗ KOMMO =======================

// ВАЖНО: этот обработчик пока только логирует запрос и возвращает JSON,
// НО НЕ отправляет сообщение в LINE. Это сделано, чтобы не усложнять диагностику.
// Как только убедимся, что LINE → Kommo работает, добавим обратно логику Kommo → LINE.

async function handleKommoWebhook(req, res) {
  try {
    const body = req.body;
    logTs("[KOMMO WEBHOOK] Входящий вебхук из Kommo:", JSON.stringify(body, null, 2));

    // Здесь пока ничего не делаем, просто возвращаем корректный JSON-ответ,
    // чтобы Kommo не ругался: "The response must be in JSON format"
    return res.status(200).json({ ok: true });
  } catch (err) {
    logTs("[ERROR] Ошибка в обработчике Kommo вебхука:", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// ======================= РОУТЫ =======================

app.get("/", (req, res) => {
  res.send("line-kommo-bridge is running");
});

app.post("/line/webhook", handleLineWebhook);
app.post("/kommo/webhook", handleKommoWebhook);

// ======================= СТАРТ СЕРВЕРА =======================

app.listen(PORT, () => {
  logTs(`line-kommo-bridge is running on port ${PORT}`);
  logTs("Your service is live 🎉");
});
