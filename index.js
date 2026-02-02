const express = require('express');
const axios = require('axios');
const qs = require('querystring');

const app = express();

// ----- ENVIRONMENT CONFIG -----
const PORT = process.env.PORT || 10000;

// Kommo
const KOMMO_SUBDOMAIN = process.env.KOMMO_SUBDOMAIN; // e.g. "andriecas"
const KOMMO_TOKEN = process.env.KOMMO_ACCESS_TOKEN || process.env.KOMMO_API_KEY; // long-lived token or OAuth access token

// LINE
const LINE_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET; // currently not used, but kept for completeness

// ----- BASIC CHECKS -----
if (!KOMMO_SUBDOMAIN) {
  console.warn('⚠️  KOMMO_SUBDOMAIN is not set in environment variables.');
}
if (!KOMMO_TOKEN) {
  console.warn('⚠️  KOMMO_ACCESS_TOKEN / KOMMO_API_KEY is not set in environment variables.');
}
if (!LINE_ACCESS_TOKEN) {
  console.warn('⚠️  LINE_CHANNEL_ACCESS_TOKEN is not set in environment variables. Sending messages to LINE will fail.');
}

// ----- HTTP CLIENTS -----
const kommoClient = axios.create({
  baseURL: `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4`,
  timeout: 10000,
  headers: {
    'Authorization': KOMMO_TOKEN ? `Bearer ${KOMMO_TOKEN}` : undefined,
    'Content-Type': 'application/json',
  },
});

const lineClient = axios.create({
  baseURL: 'https://api.line.me/v2/bot',
  timeout: 10000,
  headers: {
    'Authorization': LINE_ACCESS_TOKEN ? `Bearer ${LINE_ACCESS_TOKEN}` : undefined,
    'Content-Type': 'application/json',
  },
});

// ----- BODY PARSERS -----
// LINE sends JSON
app.use('/line/webhook', express.json());

// Kommo Webhooks send application/x-www-form-urlencoded
app.use('/kommo/webhook', express.urlencoded({ extended: false }));

// Fallback JSON for other routes (healthcheck, etc.)
app.use(express.json());

// ----- KOMMO HELPERS -----

async function searchKommoContactByLineUserId(lineUserId) {
  if (!lineUserId) return null;

  try {
    const resp = await kommoClient.get('/contacts', {
      params: {
        limit: 1,
        query: lineUserId,
      },
    });

    const contacts = (resp.data && resp.data._embedded && resp.data._embedded.contacts) || [];
    if (contacts.length > 0) {
      const c = contacts[0];
      console.log('👤 Using existing Kommo contact for LINE user:', {
        lineUserId,
        contactId: c.id,
        name: c.name,
      });
      return c;
    }
  } catch (err) {
    console.error('Error searching contact in Kommo:', err.response?.data || err.message);
  }

  return null;
}

async function createKommoContactForLineUser(lineUserId) {
  if (!lineUserId) return null;
  if (!KOMMO_TOKEN || !KOMMO_SUBDOMAIN) {
    console.error('Kommo credentials are missing; cannot create contact.');
    return null;
  }

  const payload = [
    {
      name: `LINE ${lineUserId}`,
      _embedded: {
        tags: [
          { name: 'LINE' },
          { name: `LINE_UID_${lineUserId}` },
        ],
      },
    },
  ];

  try {
    const resp = await kommoClient.post('/contacts', payload);
    const created = resp.data && resp.data._embedded && resp.data._embedded.contacts && resp.data._embedded.contacts[0];
    if (!created) {
      console.error('Unexpected response from Kommo when creating contact:', resp.data);
      return null;
    }
    console.log('🆕 Created Kommo contact for LINE user:', {
      lineUserId,
      contactId: created.id,
      name: created.name,
    });
    return created;
  } catch (err) {
    console.error('Error creating contact in Kommo:', err.response?.data || err.message);
    return null;
  }
}

async function getOrCreateKommoContact(lineUserId) {
  const existing = await searchKommoContactByLineUserId(lineUserId);
  if (existing) return existing;
  return await createKommoContactForLineUser(lineUserId);
}

async function findExistingLeadForContact(contactId) {
  if (!contactId) return null;

  try {
    // Берём пачку лидов с контактами и ищем самый свежий лид, где есть этот контакт
    const resp = await kommoClient.get('/leads', {
      params: {
        limit: 250,
        with: 'contacts',
        order: 'created_at',
      },
    });

    const leads = (resp.data && resp.data._embedded && resp.data._embedded.leads) || [];
    let bestLead = null;
    for (const lead of leads) {
      const contacts = (lead._embedded && lead._embedded.contacts) || [];
      const hasContact = contacts.some((c) => String(c.id) === String(contactId));
      if (!hasContact) continue;

      if (!bestLead || (lead.created_at || 0) > (bestLead.created_at || 0)) {
        bestLead = lead;
      }
    }

    if (bestLead) {
      console.log('📌 Using existing Kommo lead for contact:', {
        contactId,
        leadId: bestLead.id,
        leadName: bestLead.name,
      });
    }

    return bestLead;
  } catch (err) {
    console.error('Error searching Kommo leads for contact:', err.response?.data || err.message);
    return null;
  }
}

async function createLeadForContact(contactId, firstMessageText) {
  if (!contactId) return null;

  const leadNameRaw = (firstMessageText || '').trim();
  const leadName =
    leadNameRaw.length > 0
      ? leadNameRaw.substring(0, 250)
      : 'LINE inquiry';

  const payload = [
    {
      name: leadName,
      _embedded: {
        contacts: [{ id: contactId }],
        tags: [{ name: 'LINE' }],
      },
    },
  ];

  try {
    const resp = await kommoClient.post('/leads', payload);
    const created = resp.data && resp.data._embedded && resp.data._embedded.leads && resp.data._embedded.leads[0];
    if (!created) {
      console.error('Unexpected response from Kommo when creating lead:', resp.data);
      return null;
    }
    console.log('🧾 Kommo lead created from LINE:', {
      contactId,
      leadId: created.id,
      leadName: created.name,
    });
    return created;
  } catch (err) {
    console.error('Error creating lead in Kommo:', err.response?.data || err.message);
    return null;
  }
}

async function getOrCreateLeadForContact(contactId, firstMessageText) {
  const existingLead = await findExistingLeadForContact(contactId);
  if (existingLead) return existingLead;
  return await createLeadForContact(contactId, firstMessageText);
}

async function addNoteToLead(leadId, text) {
  if (!leadId || !text) return;

  const payload = [
    {
      entity_id: Number(leadId),
      note_type: 'common',
      params: {
        text,
      },
    },
  ];

  try {
    await kommoClient.post('/leads/notes', payload);
    console.log('📝 Added note to Kommo lead:', { leadId, text });
  } catch (err) {
    console.error('Error adding note to Kommo lead:', err.response?.data || err.message);
  }
}

async function fetchKommoContact(contactId) {
  if (!contactId) return null;
  try {
    const resp = await kommoClient.get(`/contacts/${contactId}`, {
      params: {
        with: 'tags',
      },
    });
    const contact = resp.data || null;
    if (!contact) return null;

    const tags = (contact._embedded && contact._embedded.tags) || [];
    console.log('📂 Loaded contact from Kommo:', {
      contactId,
      hasTags: Array.isArray(tags),
    });

    return contact;
  } catch (err) {
    console.error('Error fetching Kommo contact:', err.response?.data || err.message);
    return null;
  }
}

async function fetchKommoLead(leadId) {
  if (!leadId) return null;
  try {
    const resp = await kommoClient.get(`/leads/${leadId}`, {
      params: {
        with: 'contacts',
      },
    });
    const lead = resp.data || null;
    return lead;
  } catch (err) {
    console.error('Error fetching Kommo lead:', err.response?.data || err.message);
    return null;
  }
}

function extractLineUserIdFromContact(contact) {
  if (!contact) return null;

  const name = contact.name || '';
  let fromName = null;
  if (name.startsWith('LINE ')) {
    fromName = name.slice('LINE '.length).trim();
  }

  let fromTag = null;
  const tags = (contact._embedded && contact._embedded.tags) || [];
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (typeof tag.name === 'string' && tag.name.startsWith('LINE_UID_')) {
        fromTag = tag.name.slice('LINE_UID_'.length);
        break;
      }
    }
  }

  const finalId = fromTag || fromName || null;
  console.log('LINE userId from Kommo:', {
    fromContact: fromName,
    fromTag,
    final: finalId,
  });

  return finalId;
}

// ----- LINE HELPERS -----

async function sendLineMessage(lineUserId, text) {
  if (!lineUserId || !text) return;
  if (!LINE_ACCESS_TOKEN) {
    console.error('Cannot send message to LINE: LINE_CHANNEL_ACCESS_TOKEN is missing.');
    return;
  }

  try {
    await lineClient.post('/message/push', {
      to: lineUserId,
      messages: [
        {
          type: 'text',
          text,
        },
      ],
    });
    console.log('📤 Sent message to LINE:', { lineUserId, text });
  } catch (err) {
    console.error('Error sending message to LINE:', err.response?.data || err.message);
  }
}

// ----- LINE WEBHOOK HANDLER -----

async function handleIncomingLineMessage(lineUserId, text) {
  if (!lineUserId || !text) return;

  const contact = await getOrCreateKommoContact(lineUserId);
  if (!contact) {
    console.error('Cannot process LINE message because Kommo contact is missing.');
    return;
  }

  const lead = await getOrCreateLeadForContact(contact.id, text);
  if (!lead) {
    console.error('Cannot process LINE message because Kommo lead is missing.');
    return;
  }

  const noteText = `LINE message (${lineUserId}): ${text}`;
  await addNoteToLead(lead.id, noteText);
}

app.post('/line/webhook', async (req, res) => {
  const body = req.body || {};
  const events = body.events || [];

  for (const event of events) {
    try {
      if (
        event.type === 'message' &&
        event.message &&
        event.message.type === 'text'
      ) {
        const userId = event.source && event.source.userId;
        const text = event.message && event.message.text;

        console.log('📩 New LINE message:', {
          lineUserId: userId,
          text,
        });

        await handleIncomingLineMessage(userId, text);
      } else {
        console.log('Ignoring LINE event of unsupported type:', event.type);
      }
    } catch (err) {
      console.error('Error processing LINE webhook event:', err);
    }
  }

  res.json({ ok: true });
});

// ----- KOMMO WEBHOOK HANDLER -----

function extractReplyTextFromKommo(body) {
  if (!body) return null;

  const directKeys = [
    'message',
    'text',
    'reply',
    'reply_text',
    'line_message',
    'line_text',
  ];

  for (const key of directKeys) {
    if (
      typeof body[key] === 'string' &&
      body[key].trim().length > 0
    ) {
      return body[key].trim();
    }
  }

  // Heuristic: ищем любое поле с "message"/"text", которое не похоже на системное
  for (const [key, value] of Object.entries(body)) {
    if (typeof value !== 'string') continue;
    const lowerKey = key.toLowerCase();
    if (!value.trim()) continue;

    const looksLikeMessageKey =
      (lowerKey.includes('message') || lowerKey.includes('text')) &&
      !lowerKey.startsWith('this_item[') &&
      !lowerKey.startsWith('leads[') &&
      !lowerKey.startsWith('contacts[') &&
      !lowerKey.startsWith('account[');

    if (looksLikeMessageKey) {
      return value.trim();
    }
  }

  return null;
}

function extractLeadIdFromKommo(body) {
  if (!body) return null;
  const candidates = [
    'this_item[id]',
    'leads[add][0][id]',
    'leads[update][0][id]',
    'leads[status][0][id]',
  ];

  for (const key of candidates) {
    if (body[key]) return body[key];
  }
  return null;
}

function extractContactIdFromKommo(body) {
  if (!body) return null;
  const candidates = [
    'this_item[_embedded][contacts][0][id]',
    'contacts[add][0][id]',
  ];

  for (const key of candidates) {
    if (body[key]) return body[key];
  }
  return null;
}

async function findContactIdByLead(leadId) {
  const lead = await fetchKommoLead(leadId);
  if (!lead) return null;

  const contacts = (lead._embedded && lead._embedded.contacts) || [];
  if (Array.isArray(contacts) && contacts.length > 0) {
    return contacts[0].id;
  }
  return null;
}

app.post('/kommo/webhook', async (req, res) => {
  const body = req.body || {};
  console.log('📨 Incoming Kommo webhook body:', body);

  const replyText = extractReplyTextFromKommo(body);
  const leadId = extractLeadIdFromKommo(body);
  let contactId = extractContactIdFromKommo(body);

  if (replyText && (leadId || contactId)) {
    console.log('↩️ Kommo wants to send reply to LINE:', {
      leadId,
      contactId,
      replyText,
    });

    try {
      if (!contactId && leadId) {
        contactId = await findContactIdByLead(leadId);
      }

      if (!contactId) {
        console.warn('Could not determine contactId from Kommo webhook; aborting LINE reply.');
      } else {
        const contact = await fetchKommoContact(contactId);
        const lineUserId = extractLineUserIdFromContact(contact);

        if (!lineUserId) {
          console.warn('❌ Could not extract LINE userId from Kommo contact; reply will not be sent.');
        } else {
          await sendLineMessage(lineUserId, replyText);
        }
      }
    } catch (err) {
      console.error('Error processing Kommo reply webhook:', err.response?.data || err.message);
    }
  } else {
    console.log('Kommo webhook without reply text (probably system event); nothing to send to LINE.');
  }

  // Kommo expects JSON response
  res.json({ ok: true });
});

// ----- HEALTHCHECK -----
app.get('/', (req, res) => {
  res.json({ status: 'ok' });
});

// ----- START SERVER -----
app.listen(PORT, () => {
  console.log(`line-kommo-bridge is running on port ${PORT}`);
});
