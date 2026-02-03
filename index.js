// index.js – LINE <-> Kommo bridge с расширенными логами
// Версия 2026-02-03

const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios');

const app = express();

// ---------- Конфиг из переменных окружения ----------

const PORT = process.env.PORT || 10000;

// LINE
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || '';
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';

// Kommo
const KOMMO_BASE_URL = process.env.KOMMO_BASE_URL || '';          // например: https://andriecas.kommo.com
const KOMMO_ACCESS_TOKEN = process.env.KOMMO_ACCESS_TOKEN || '';  // рабочий access-token
const KOMMO_DEFAULT_PIPELINE_ID = process.env.KOMMO_DEFAULT_PIPELINE_ID
  ? Number(process.env.KOMMO_DEFAULT_PIPELINE_ID)
  : undefined;
const KOMMO_DEFAULT_STATUS_ID = process.env.KOMMO_DEFAULT_STATUS_ID
  ? Number(process.env.KOMMO_DEFAULT_STATUS_ID)
  : undefined;

// ---------- Общие утилиты логирования ----------

function log(title, payload) {
  const time = new Date().toISOString();
  if (payload !== undefined) {
    console.log(`[${time}] ${title}`, JSON.stringify(payload, null, 2));
  } else {
    console.log(`[${time}] ${title}`);
  }
}

function logWarn(title, payload) {
  const time = new Date().toISOString();
  if (payload !== undefined) {
    console.warn(`[${time}] ⚠️ ${title}`, JSON.stringify(payload, null, 2));
  } else {
    console.warn(`[${time}] ⚠️ ${title}`);
  }
}

function logError(title, err) {
  const time = new Date().toISOString();
  if (!err) {
    console.error(`[${time}] ❌ ${title}`);
    return;
  }

  if (err.response) {
    console.error(
      `[${time}] ❌ ${title} – HTTP ${err.response.status}`,
      JSON.stringify(err.response.data, null, 2)
    );
  } else {
    console.error(`[${time}] ❌ ${title} – ${err.message || err}`);
  }
}

// ---------- Настройка body-parser, чтобы сохранить "сырое" тело для подписи LINE ----------

app.use(
  bodyParser.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);

// ---------- Axios-клиент для Kommo ----------

let kommoClient = null;

if (KOMMO_BASE_URL && KOMMO_ACCESS_TOKEN) {
  kommoClient = axios.create({
    baseURL: KOMMO_BASE_URL,
    timeout: 8000,
    headers: {
      Authorization: `Bearer ${KOMMO_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
} else {
  logWarn('KOMMO_BASE_URL или KOMMO_ACCESS_TOKEN не заданы. Интеграция с Kommo будет отключена.');
}

// ---------- Стартовая информация ----------

log('Запуск line-kommo-bridge', {
  PORT,
  has_LINE_CHANNEL_SECRET: !!LINE_CHANNEL_SECRET,
  has_LINE_CHANNEL_ACCESS_TOKEN: !!LINE_CHANNEL_ACCESS_TOKEN,
  KOMMO_BASE_URL,
  has_KOMMO_ACCESS_TOKEN: !!KOMMO_ACCESS_TOKEN,
  KOMMO_DEFAULT_PIPELINE_ID,
  KOMMO_DEFAULT_STATUS_ID,
});

// ---------- Помощники LINE ----------

function isValidLineSignature(req) {
  if (!LINE_CHANNEL_SECRET) {
    logWarn('LINE_CHANNEL_SECRET не задан; проверка подписи LINE отключена (debug режим).');
    return true;
  }

  const signature = req.headers['x-line-signature'];
  if (!signature) {
    logWarn('Заголовок x-line-signature отсутствует');
    return false;
  }

  const body = req.rawBody || JSON.stringify(req.body || {});
  const hash = crypto
    .createHmac('sha256', LINE_CHANNEL_SECRET)
    .update(body)
    .digest('base64');

  const ok = signature === hash;

  if (!ok) {
    logWarn('Подпись LINE не совпадает', { signature, expected: hash });
  }

  return ok;
}

async function getLineProfile(userId) {
  if (!LINE_CHANNEL_ACCESS_TOKEN) {
    logWarn('LINE_CHANNEL_ACCESS_TOKEN не задан; не можем получить профиль пользователя LINE');
    return null;
  }

  try {
    const res = await axios.get(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
      timeout: 5000,
    });
    log('Получен профиль LINE пользователя', { userId, profile: res.data });
    return res.data;
  } catch (err) {
    logError('Ошибка при получении профиля LINE', err);
    return null;
  }
}

async function sendLineTextMessage(userId, text) {
  if (!LINE_CHANNEL_ACCESS_TOKEN) {
    logWarn('LINE_CHANNEL_ACCESS_TOKEN не задан; не можем отправить сообщение в LINE');
    return;
  }

  const body = {
    to: userId,
    messages: [
      {
        type: 'text',
        text,
      },
    ],
  };

  try {
    await axios.post('https://api.line.me/v2/bot/message/push', body, {
      headers: {
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 8000,
    });
    log('Сообщение отправлено в LINE', { userId, text });
  } catch (err) {
    logError('Ошибка при отправке сообщения в LINE', err);
  }
}

// ---------- Помощники Kommo ----------

async function kommoGet(path, params) {
  if (!kommoClient) {
    logWarn('kommoGet вызван, но Kommo-клиент не настроен');
    return null;
  }
  try {
    const res = await kommoClient.get(path, { params });
    log(`Kommo GET ${path} ok`, { params });
    return res.data;
  } catch (err) {
    logError(`Kommo GET ${path} ошибка`, err);
    return null;
  }
}

async function kommoPost(path, data) {
  if (!kommoClient) {
    logWarn('kommoPost вызван, но Kommo-клиент не настроен');
    return null;
  }
  try {
    const res = await kommoClient.post(path, data);
    log(`Kommo POST ${path} ok`);
    return res.data;
  } catch (err) {
    logError(`Kommo POST ${path} ошибка`, err);
    return null;
  }
}

// Поиск/создание контакта Kommo для lineUserId
async function findOrCreateKommoContact(lineUserId, displayName) {
  if (!kommoClient) {
    logWarn('Команда findOrCreateKommoContact пропущена – нет Kommo-кредов');
    return null;
  }

  const searchQuery = lineUserId;

  // 1) Поиск контакта по lineUserId (через query)
  const searchData = await kommoGet('/api/v4/contacts', {
    query: searchQuery,
    limit: 1,
  });

  const existingContacts =
    searchData && searchData._embedded && searchData._embedded.contacts
      ? searchData._embedded.contacts
      : [];

  if (existingContacts.length > 0) {
    const contact = existingContacts[0];
    log('Найден существующий контакт Kommo для LINE пользователя', {
      lineUserId,
      contactId: contact.id,
      name: contact.name,
    });
    return contact;
  }

  // 2) Контакт не найден – создаём
  const name =
    displayName != null && displayName !== ''
      ? `[LINE] ${displayName} (${lineUserId})`
      : `LINE ${lineUserId}`;

  const contactPayload = [
    {
      name,
      tags: [{ name: 'LINE' }],
    },
  ];

  const createdData = await kommoPost('/api/v4/contacts', contactPayload);

  const createdContacts =
    createdData && createdData._embedded && createdData._embedded.contacts
      ? createdData._embedded.contacts
      : [];

  if (!createdContacts.length) {
    logWarn('Не удалось создать контакт Kommo', { lineUserId, name });
    return null;
  }

  const newContact = createdContacts[0];
  log('Создан контакт Kommo для LINE пользователя', {
    lineUserId,
    contactId: newContact.id,
    name: newContact.name,
  });

  return newContact;
}

// Поиск/создание лида Kommo для контакта
async function findOrCreateKommoLead(lineUserId, contactId, displayName) {
  if (!kommoClient) {
    logWarn('Команда findOrCreateKommoLead пропущена – нет Kommo-кредов');
    return null;
  }

  const searchQuery = lineUserId;

  const searchData = await kommoGet('/api/v4/leads', {
    query: searchQuery,
    limit: 1,
  });

  const existingLeads =
    searchData && searchData._embedded && searchData._embedded.leads
      ? searchData._embedded.leads
      : [];

  if (existingLeads.length > 0) {
    const lead = existingLeads[0];
    log('Используем существующий лид Kommo для контакта', {
      lineUserId,
      contactId,
      leadId: lead.id,
      leadName: lead.name,
    });
    return lead;
  }

  const leadName =
    displayName != null && displayName !== ''
      ? `[LINE] ${displayName} (${lineUserId})`
      : `LINE чат ${lineUserId}`;

  const leadPayload = [
    {
      name: leadName,
      pipeline_id: KOMMO_DEFAULT_PIPELINE_ID,
      status_id: KOMMO_DEFAULT_STATUS_ID,
      _embedded: {
        contacts: [{ id: contactId }],
      },
      tags: [{ name: 'LINE' }],
    },
  ];

  const createdData = await kommoPost('/api/v4/leads', leadPayload);

  const createdLeads =
    createdData && createdData._embedded && createdData._embedded.leads
      ? createdData._embedded.leads
      : [];

  if (!createdLeads.length) {
    logWarn('Не удалось создать лид Kommo', { lineUserId, contactId, leadName });
    return null;
  }

  const newLead = createdLeads[0];
  log('Лид Kommo создан из LINE', {
    lineUserId,
    contactId,
    leadId: newLead.id,
    leadName: newLead.name,
  });

  return newLead;
}

// Добавление заметки в лид с текстом сообщения из LINE
async function addNoteToLeadFromLineMessage(leadId, text, displayName, lineUserId) {
  if (!kommoClient) {
    logWarn('addNoteToLeadFromLineMessage пропущен – нет Kommo-кредов');
    return;
  }

  const header = displayName
    ? `LINE сообщение от ${displayName}`
    : `LINE сообщение от ${lineUserId}`;

  const noteText = `${header}:\n${text}`;

  const payload = [
    {
      entity_id: leadId,
      note_type: 'common',
      params: { text: noteText },
    },
  ];

  await kommoPost('/api/v4/leads/notes', payload);
  log('Заметка добавлена в лид Kommo', { leadId, text: noteText });
}

// ---------- Обработка событий LINE ----------

async function handleLineEvent(event) {
  log('Обрабатываем событие LINE', event);

  if (!event) return;

  if (event.type !== 'message') {
    log('Событие не message, пропускаем', { type: event.type });
    return;
  }

  if (!event.message || event.message.type !== 'text') {
    log('Сообщение не текстовое, пропускаем', {
      messageType: event.message && event.message.type,
    });
    return;
  }

  const lineUserId = event.source && event.source.userId;
  const text = event.message.text;

  if (!lineUserId) {
    logWarn('В событии LINE нет userId, пропускаем');
    return;
  }

  log('Новый текст из LINE', { lineUserId, text });

  // Получаем профиль (display name)
  const profile = await getLineProfile(lineUserId);
  const displayName = profile && profile.displayName;

  // Контакт в Kommo
  const contact = await findOrCreateKommoContact(lineUserId, displayName);
  if (!contact) {
    logWarn('Не удалось получить/создать контакт Kommo; дальше не идём');
    return;
  }

  // Лид в Kommo
  const lead = await findOrCreateKommoLead(lineUserId, contact.id, displayName);
  if (!lead) {
    logWarn('Не удалось получить/создать лид Kommo; заметку не создаём');
    return;
  }

  // Заметка с текстом сообщения
  await addNoteToLeadFromLineMessage(lead.id, text, displayName, lineUserId);
}

// ---------- Маршрут Webhook от LINE ----------

app.post('/line/webhook', (req, res) => {
  log('➡️  Входящий запрос от LINE на /line/webhook', {
    method: req.method,
    url: req.url,
    headers: {
      'user-agent': req.headers['user-agent'],
      'content-type': req.headers['content-type'],
      'x-line-signature': req.headers['x-line-signature'],
    },
    body: req.body,
  });

  if (!isValidLineSignature(req)) {
    // Подпись невалидна – отвечаем 401, чтобы увидеть проблему
    return res.status(401).send('Invalid LINE signature');
  }

  // Всегда быстро отвечаем LINE, чтобы не было таймаута
  res.status(200).json({ ok: true });

  if (!req.body || !Array.isArray(req.body.events)) {
    logWarn('LINE webhook без events', req.body);
    return;
  }

  // Обрабатываем события асинхронно
  for (const event of req.body.events) {
    handleLineEvent(event).catch((err) => {
      logError('Ошибка при обработке события LINE', err);
    });
  }
});

// ---------- Маршрут Webhook от Kommo (ответы операторов в LINE) ----------
// Сейчас этот маршрут в основном логирующий и возвращает JSON,
// чтобы Kommo не ругался "The response must be in JSON format".
// Логи помогут позже настроить полноценную отправку сообщения в LINE.

app.post('/kommo/webhook', (req, res) => {
  log('📥 Входящий webhook от Kommo на /kommo/webhook', {
    method: req.method,
    url: req.url,
    headers: {
      'user-agent': req.headers['user-agent'],
      'content-type': req.headers['content-type'],
    },
    body: req.body,
  });

  // Здесь мы пока НИЧЕГО не отправляем в LINE, только логируем.
  // Важно: всегда отвечаем JSON, чтобы Kommo был доволен.
  res.json({ ok: true, message: 'Webhook received. Currently logging only.' });
});

// ---------- Health-маршрут и fallback ----------

app.get('/', (req, res) => {
  res.send('line-kommo-bridge is running');
});

app.all('*', (req, res) => {
  logWarn('Запрос к неизвестному пути', {
    method: req.method,
    url: req.url,
    body: req.body,
  });
  res.status(404).json({ ok: false, error: 'Not found' });
});

// ---------- Старт сервера ----------

app.listen(PORT, () => {
  console.log(`line-kommo-bridge is running on port ${PORT}`);
  console.log('=> Your service is live 🎉');
});
