// index.js — LINE <-> Kommo bridge v2
// Делает три вещи:
// 1) При новом сообщении из LINE создаёт/находит контакт и ОДИН активный лид,
//    добавляя в лид заметку с текстом сообщения.
// 2) По вебхуку из Kommo шлёт в LINE красивый автоответ по этому лиду.
// 3) Контакт называется по displayName из LINE, но с техпометкой [Uxxxx] для связи.

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;

// ---------------------- Middleware ----------------------

// Для LINE нужен сырой текст тела, чтобы проверить подпись
app.use('/line/webhook', express.text({ type: '*/*' }));

// Kommo Webhooks присылает x-www-form-urlencoded
app.use('/kommo/webhook', express.urlencoded({ extended: true }));

// Всё остальное — JSON (на будущее)
app.use(express.json());

// ---------------------- Общие утилиты ----------------------

function getKommoConfig() {
  const subdomain = process.env.KOMMO_SUBDOMAIN;
  const apiKey = process.env.KOMMO_API_KEY;

  if (!subdomain || !apiKey) {
    console.warn(
      '⚠️ KOMMO_SUBDOMAIN или KOMMO_API_KEY не заданы. Все запросы в Kommo будут падать.'
    );
  }

  return { subdomain, apiKey };
}

async function kommoRequest(method, path, { params, data } = {}) {
  const { subdomain, apiKey } = getKommoConfig();
  if (!subdomain || !apiKey) {
    throw new Error('Missing KOMMO_SUBDOMAIN or KOMMO_API_KEY env vars');
  }

  const url = `https://${subdomain}.kommo.com${path}`;

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  const resp = await axios({
    method,
    url,
    headers,
    params,
    data,
  });

  return resp;
}

// ---------------------- LINE utils ----------------------

function verifyLineSignature(rawBody, signature) {
  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  if (!channelSecret) {
    console.warn(
      '⚠️ LINE_CHANNEL_SECRET не задан, подпись LINE не проверяется (используется только для отладки).'
    );
    return true;
  }
  if (!signature) {
    console.warn('⚠️ Нет X-Line-Signature, запрос отклонён.');
    return false;
  }

  const hmac = crypto.createHmac('sha256', channelSecret);
  hmac.update(rawBody);
  const digest = hmac.digest('base64');

  return digest === signature;
}

async function getLineProfile(userId) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    console.warn(
      '⚠️ LINE_CHANNEL_ACCESS_TOKEN не задан, не могу получить профиль пользователя LINE.'
    );
    return null;
  }

  try {
    const resp = await axios.get(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    return resp.data; // { displayName, userId, pictureUrl, statusMessage }
  } catch (err) {
    console.warn(
      'Не удалось получить профиль LINE',
      err.response?.data || err.message
    );
    return null;
  }
}

async function sendLineMessage(to, text) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    console.warn(
      '⚠️ LINE_CHANNEL_ACCESS_TOKEN не задан, не могу отправить сообщение в LINE.'
    );
    return;
  }

  const payload = {
    to,
    messages: [
      {
        type: 'text',
        text,
      },
    ],
  };

  try {
    const resp = await axios.post(
      'https://api.line.me/v2/bot/message/push',
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log('✅ sendLineMessage OK', resp.data || '');
  } catch (err) {
    console.error(
      '❌ Ошибка при отправке сообщения в LINE',
      err.response?.data || err.message
    );
  }
}

// ---------------------- Вспомогательные парсеры ----------------------

function extractLineUserIdFromString(str) {
  if (!str || typeof str !== 'string') return null;
  // LINE userId обычно начинается с U и состоит из ~32 hex символов
  const match = /(U[0-9a-f]{10,})/i.exec(str);
  return match ? match[1] : null;
}

function extractLineUserIdFromContact(contact) {
  if (!contact || typeof contact !== 'object') return null;

  // 1) Ищем тег вида LINE_UID_Uxxxx
  const tags = contact._embedded?.tags || [];
  for (const tag of tags) {
    if (!tag || typeof tag.name !== 'string') continue;
    const m = /^LINE_UID_(U[0-9a-f]{10,})/i.exec(tag.name);
    if (m) return m[1];
  }

  // 2) Имя контакта (мы туда тоже кладём [Uxxxx])
  const fromName = extractLineUserIdFromString(contact.name);
  if (fromName) return fromName;

  // 3) На всякий случай ещё пары полей
  const fromFirst = extractLineUserIdFromString(contact.first_name);
  if (fromFirst) return fromFirst;
  const fromLast = extractLineUserIdFromString(contact.last_name);
  if (fromLast) return fromLast;

  return null;
}

// ---------------------- Контакты Kommo ----------------------

async function findContactByLineUserId(lineUserId) {
  try {
    const resp = await kommoRequest('get', '/api/v4/contacts', {
      params: {
        query: lineUserId,
        limit: 1,
      },
    });

    const list = resp.data?._embedded?.contacts || [];
    const contact = list[0];
    if (contact) {
      console.log(
        'Используем существующий контакт Kommo для LINE пользователя',
        lineUserId,
        '→ contactId',
        contact.id
      );
      return contact;
    }
  } catch (err) {
    console.error(
      '❌ Ошибка поиска контакта по LINE userId',
      err.response?.data || err.message
    );
  }

  return null;
}

async function createContactForLineUser(lineUserId, profile) {
  const displayName = profile?.displayName || 'LINE user';
  // Красивое имя для менеджера, но с техпометкой [Uxxxx] в конце
  const contactName = `${displayName} [${lineUserId}]`;

  const payload = [
    {
      name: contactName,
      tags: [
        { name: 'LINE' },
        { name: `LINE_UID_${lineUserId}` }, // техтег, чтобы можно было парсить userId из тегов
      ],
    },
  ];

  try {
    console.log('Создаём контакт в Kommo для LINE пользователя', {
      lineUserId,
      contactName,
    });
    await kommoRequest('post', '/api/v4/contacts', { data: payload });
  } catch (err) {
    console.error(
      '❌ Ошибка при создании контакта в Kommo',
      err.response?.data || err.message
    );
    throw err;
  }

  // После создания ещё раз ищем контакт, чтобы получить его объект и id
  const contact = await findContactByLineUserId(lineUserId);
  if (!contact) {
    throw new Error('Контакт был создан, но его не удалось найти.');
  }

  console.log('✅ Контакт Kommo для LINE пользователя создан', {
    lineUserId,
    contactId: contact.id,
  });

  return contact;
}

async function getOrCreateContact(lineUserId, profile) {
  const existing = await findContactByLineUserId(lineUserId);
  if (existing) return existing;
  return createContactForLineUser(lineUserId, profile);
}

// ---------------------- Лиды Kommo ----------------------

function isLeadClosed(lead) {
  const statusId = Number(lead.status_id);
  // 142 / 143 — стандартные «успешно / неуспешно реализовано»
  if (statusId === 142 || statusId === 143) return true;
  if (lead.is_deleted) return true;
  return false;
}

async function findLastLeadForContact(contactId) {
  try {
    const resp = await kommoRequest('get', '/api/v4/leads', {
      params: {
        'filter[contacts][id][]': contactId,
        'order[created_at]': 'desc',
        limit: 1,
      },
    });

    const list = resp.data?._embedded?.leads || [];
    const lead = list[0];

    if (lead) {
      console.log('Последний лид по контакту', contactId, '→', {
        id: lead.id,
        name: lead.name,
        status_id: lead.status_id,
      });
      return lead;
    }
  } catch (err) {
    console.error(
      '❌ Ошибка поиска лида по контакту',
      err.response?.data || err.message
    );
  }

  return null;
}

function buildLeadName(lineUserId, text, profile) {
  const cleanText = (text || '').trim();
  const shortText = cleanText ? cleanText.slice(0, 80) : 'New request from LINE';
  const displayName = profile?.displayName;
  const base = displayName ? `${displayName}: ${shortText}` : shortText;
  return `${base} [${lineUserId}]`;
}

async function createLeadForLineMessage(contactId, lineUserId, text, profile) {
  const leadName = buildLeadName(lineUserId, text, profile);

  const payload = [
    {
      name: leadName,
      tags: [{ name: 'LINE' }],
      _embedded: {
        contacts: [{ id: contactId }],
      },
    },
  ];

  try {
    console.log('Создаём лид в Kommo из LINE сообщения', {
      contactId,
      lineUserId,
      leadName,
    });
    await kommoRequest('post', '/api/v4/leads', { data: payload });
  } catch (err) {
    console.error(
      '❌ Ошибка при создании лида в Kommo',
      err.response?.data || err.message
    );
    throw err;
  }

  const lead = await findLastLeadForContact(contactId);
  if (!lead) {
    throw new Error('Лид был создан, но его не удалось найти.');
  }

  console.log('✅ Лид Kommo создан из LINE', {
    lineUserId,
    leadId: lead.id,
    contactId,
  });

  return lead;
}

async function findOrCreateLeadForContact(contactId, lineUserId, text, profile) {
  const lastLead = await findLastLeadForContact(contactId);

  if (lastLead && !isLeadClosed(lastLead)) {
    console.log('Используем существующий ОТКРЫТЫЙ лид для LINE пользователя', {
      lineUserId,
      leadId: lastLead.id,
    });
    return { lead: lastLead, created: false };
  }

  const newLead = await createLeadForLineMessage(
    contactId,
    lineUserId,
    text,
    profile
  );
  return { lead: newLead, created: true };
}

async function addNoteToLeadFromLineMessage(leadId, lineUserId, text, profile) {
  const displayName = profile?.displayName || 'LINE user';
  const noteText =
    text && text.trim()
      ? `LINE (${displayName}): ${text}`
      : `New message from LINE user ${displayName}`;

  const payload = [
    {
      entity_id: leadId,
      note_type: 'common',
      params: {
        text: noteText,
      },
    },
  ];

  try {
    console.log('Добавляем заметку в лид из LINE сообщения', {
      leadId,
      lineUserId,
    });
    await kommoRequest('post', '/api/v4/leads/notes', { data: payload });
  } catch (err) {
    console.error(
      '❌ Ошибка при добавлении заметки к лиду',
      err.response?.data || err.message
    );
  }
}

// ---------------------- Обработка входящих LINE сообщений ----------------------

async function processLineMessage(lineUserId, text) {
  console.log('➡️ Новое сообщение из LINE:', { lineUserId, text });

  const profile = await getLineProfile(lineUserId);
  const contact = await getOrCreateContact(lineUserId, profile);
  const { lead, created } = await findOrCreateLeadForContact(
    contact.id,
    lineUserId,
    text,
    profile
  );

  await addNoteToLeadFromLineMessage(lead.id, lineUserId, text, profile);

  console.log('✅ Сообщение LINE обработано', {
    lineUserId,
    contactId: contact.id,
    leadId: lead.id,
    leadCreated: created,
  });
}

// ---------------------- LINE webhook ----------------------

app.post('/line/webhook', (req, res) => {
  const rawBody = req.body || '';
  const signature = req.get('X-Line-Signature');

  if (!verifyLineSignature(rawBody, signature)) {
    console.warn('❌ Проверка подписи LINE не пройдена.');
    return res.status(403).send('Invalid signature');
  }

  let bodyJson;
  try {
    bodyJson = JSON.parse(rawBody);
  } catch (err) {
    console.error('❌ Не удалось распарсить JSON из LINE webhook', err.message);
    return res.status(200).end();
  }

  const events = Array.isArray(bodyJson.events) ? bodyJson.events : [];

  // Быстро отвечаем LINE, а реальную работу делаем асинхронно
  res.status(200).end();

  (async () => {
    for (const event of events) {
      try {
        if (
          event.type !== 'message' ||
          !event.message ||
          event.message.type !== 'text'
        ) {
          continue;
        }

        const lineUserId = event.source && event.source.userId;
        const text = event.message.text || '';

        if (!lineUserId) {
          console.warn('⚠️ LINE event без userId, пропускаем.');
          continue;
        }

        await processLineMessage(lineUserId, text);
      } catch (err) {
        console.error(
          '❌ Ошибка при обработке LINE event',
          err.response?.data || err.message
        );
      }
    }
  })().catch((err) =>
    console.error('❌ Неожиданная ошибка в обработчике LINE событий', err)
  );
});

// ---------------------- Kommo webhook (ответ в LINE) ----------------------

function extractLeadIdFromKommoBody(body) {
  if (!body || typeof body !== 'object') return null;

  if (body['this_item[id]']) return body['this_item[id]'];
  if (body['leads[add][0][id]']) return body['leads[add][0][id]'];
  if (body['leads[status][0][id]']) return body['leads[status][0][id]'];

  for (const [key, value] of Object.entries(body)) {
    if (!value) continue;
    if (/leads.*\[id]$/i.test(key)) {
      return value;
    }
  }

  return null;
}

function extractContactIdFromKommoBody(body) {
  if (!body || typeof body !== 'object') return null;

  if (body['this_item[_embedded][contacts][0][id]']) {
    return body['this_item[_embedded][contacts][0][id]'];
  }

  for (const [key, value] of Object.entries(body)) {
    if (!value) continue;
    if (/contacts.*\[0]\[id]$/i.test(key)) {
      return value;
    }
  }

  return null;
}

function composeReplyText(lead) {
  const id = lead?.id || lead?.leadId;
  const name = lead?.name;
  let aboutPart = '';

  if (name && !/^Lead #/i.test(name)) {
    aboutPart = ` about "${name}"`;
  }

  const idPart = id ? ` (request ID: ${id})` : '';

  return (
    'Thank you for your message! We have received your request' +
    aboutPart +
    '. Our team from Nusa Penida info will contact you via LINE as soon as possible.' +
    idPart
  );
}

async function handleKommoWebhook(body) {
  console.log('➡️ Kommo webhook body:', body);

  let leadId = extractLeadIdFromKommoBody(body);
  let contactId = extractContactIdFromKommoBody(body);

  console.log('Извлекли из Kommo webhook →', { leadId, contactId });

  let lead = null;

  if (leadId) {
    try {
      const resp = await kommoRequest('get', `/api/v4/leads/${leadId}`, {
        params: { with: 'contacts' },
      });
      lead = resp.data;

      if (!contactId) {
        const contacts = lead._embedded?.contacts || [];
        if (contacts[0]?.id) {
          contactId = contacts[0].id;
        }
      }

      console.log('Загрузили лид из Kommo', {
        leadId: lead.id,
        leadName: lead.name,
        contactId,
      });
    } catch (err) {
      console.error(
        '❌ Ошибка загрузки лида из Kommo',
        err.response?.data || err.message
      );
    }
  }

  let contact = null;
  if (contactId) {
    try {
      const resp = await kommoRequest('get', `/api/v4/contacts/${contactId}`);
      contact = resp.data;
      console.log('Загрузили контакт из Kommo', {
        contactId: contact.id,
        contactName: contact.name,
      });
    } catch (err) {
      console.error(
        '❌ Ошибка загрузки контакта из Kommo',
        err.response?.data || err.message
      );
    }
  }

  const lineUserIdFromContact = extractLineUserIdFromContact(contact);
  const lineUserIdFromLead = extractLineUserIdFromString(lead?.name);
  const lineUserId = lineUserIdFromContact || lineUserIdFromLead;

  console.log('LINE userId из Kommo:', {
    fromContact: lineUserIdFromContact,
    fromLead: lineUserIdFromLead,
    final: lineUserId,
  });

  if (!lineUserId) {
    console.warn(
      '⚠️ Не удалось найти LINE userId ни в контакте, ни в лиде; ответ в LINE не отправляем.'
    );
    return;
  }

  const replyText = composeReplyText(lead || { id: leadId });

  await sendLineMessage(lineUserId, replyText);

  console.log('✅ Отправили автоответ в LINE для лида', {
    lineUserId,
    leadId: lead?.id || leadId,
  });
}

app.post('/kommo/webhook', (req, res) => {
  // Kommo достаточно простого 200 OK
  res.status(200).json({ ok: true });

  handleKommoWebhook(req.body).catch((err) => {
    console.error(
      '❌ Ошибка в обработчике Kommo webhook',
      err.response?.data || err.message
    );
  });
});

// ---------------------- Health-check и запуск ----------------------

app.get('/', (req, res) => {
  res.send('LINE-Kommo bridge is running');
});

app.get('/status', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`line-kommo-bridge is running on port ${PORT}`);
});
