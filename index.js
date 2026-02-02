// line-kommo-bridge: clean version 2026-02-03
// Single file that:
// 1) Receives LINE webhooks and creates/updates contacts & leads in Kommo
// 2) Receives Kommo widget webhooks ("LINE Reply") and sends messages back to LINE

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const qs = require('querystring');

const {
  PORT = 10000,
  LINE_CHANNEL_SECRET,
  LINE_CHANNEL_ACCESS_TOKEN,
  KOMMO_SUBDOMAIN,
  KOMMO_API_KEY,
} = process.env;

const app = express();

const KOMMO_BASE = KOMMO_SUBDOMAIN
  ? `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4`
  : null;

// ---------- Small helpers ----------

function log(...args) {
  console.log(...args);
}

function kommoHeaders() {
  return {
    Authorization: `Bearer ${KOMMO_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

function safeJsonParse(str, fallback = null) {
  try {
    return JSON.parse(str);
  } catch (e) {
    return fallback;
  }
}

// Extract LINE userId from Kommo contact name
// Supports both formats:
//  - "LINE Uxxxxxxxxx"
//  - "Display Name (LINE Uxxxxxxxxx)"
function extractLineUserIdFromContact(contact) {
  if (!contact) return null;
  const name = contact.name || '';

  // Case 1: "... (LINE Uxxxx)"
  let m = name.match(/\(LINE\s+([^)]+)\)\s*$/i);
  if (m && m[1]) {
    return m[1].trim();
  }

  // Case 2: "LINE Uxxxx"
  m = name.match(/^LINE\s+(.+)$/i);
  if (m && m[1]) {
    return m[1].trim();
  }

  return null;
}

// ---------- LINE helpers ----------

async function getLineProfile(lineUserId) {
  try {
    const res = await axios.get(
      `https://api.line.me/v2/bot/profile/${lineUserId}`,
      {
        headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
      }
    );
    return res.data; // { userId, displayName, pictureUrl, statusMessage }
  } catch (err) {
    log('❌ Failed to load LINE profile:', err?.response?.data || err.message);
    return null;
  }
}

async function sendLineMessage(lineUserId, text) {
  if (!LINE_CHANNEL_ACCESS_TOKEN) {
    log('⚠️ LINE_CHANNEL_ACCESS_TOKEN is missing; cannot send message');
    return;
  }

  try {
    const body = {
      to: lineUserId,
      messages: [{ type: 'text', text }],
    };

    const res = await axios.post(
      'https://api.line.me/v2/bot/message/push',
      body,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        },
      }
    );

    log('✅ LINE message sent:', {
      status: res.status,
      statusText: res.statusText,
    });
  } catch (err) {
    log(
      '❌ LINE API error:',
      err?.response?.status,
      err?.response?.data || err.message
    );
  }
}

// ---------- Kommo helpers ----------

// Find or create a Kommo contact for given LINE userId
async function ensureKommoContactForLineUser(lineUserId, displayName) {
  if (!KOMMO_BASE || !KOMMO_API_KEY) {
    log('⚠️ Kommo env vars are missing; skipping Kommo contact creation');
    return { contactId: null, contact: null };
  }

  // 1) Try to find existing contact by userId in name (via ?query=)
  try {
    const searchRes = await axios.get(
      `${KOMMO_BASE}/contacts`,
      {
        params: { query: lineUserId, limit: 50 },
        headers: kommoHeaders(),
      }
    );

    const found =
      searchRes.data &&
      searchRes.data._embedded &&
      Array.isArray(searchRes.data._embedded.contacts)
        ? searchRes.data._embedded.contacts
        : [];

    if (found.length > 0) {
      const contact = found[0];
      log('👤 Using existing Kommo contact for LINE user:', {
        lineUserId,
        contactId: contact.id,
        name: contact.name,
      });
      return { contactId: contact.id, contact };
    }
  } catch (err) {
    log(
      '❌ Kommo search contact error:',
      err?.response?.status,
      err?.response?.data || err.message
    );
    // continue, we'll try to create
  }

  // 2) Create new contact
  const contactName = displayName
    ? `${displayName} (LINE ${lineUserId})`
    : `LINE ${lineUserId}`;

  const payload = [
    {
      name: contactName,
      _embedded: {
        tags: [{ name: 'LINE' }],
      },
    },
  ];

  try {
    const createRes = await axios.post(
      `${KOMMO_BASE}/contacts`,
      payload,
      { headers: kommoHeaders() }
    );

    const created =
      createRes.data &&
      createRes.data._embedded &&
      createRes.data._embedded.contacts &&
      createRes.data._embedded.contacts[0];

    const contactId = created ? created.id : null;

    log('👤 Created Kommo contact for LINE user:', {
      lineUserId,
      contactId,
      name: created?.name,
    });

    return { contactId, contact: created || null };
  } catch (err) {
    log(
      '❌ Kommo create contact error:',
      err?.response?.status,
      err?.response?.data || err.message
    );
    return { contactId: null, contact: null };
  }
}

// Always create a new lead (we'll optimise later)
async function createKommoLeadFromLine(lineUserId, contactId, firstText) {
  if (!KOMMO_BASE || !KOMMO_API_KEY) {
    log('⚠️ Kommo env vars are missing; skipping Kommo lead creation');
    return { leadId: null };
  }

  const cleanText = (firstText || '').trim();
  const leadName =
    cleanText.length > 0
      ? cleanText.slice(0, 200)
      : `LINE inquiry ${lineUserId}`;

  const payload = [
    {
      name: leadName,
      _embedded: {
        contacts: contactId ? [{ id: contactId }] : [],
        tags: [{ name: 'LINE' }],
      },
    },
  ];

  try {
    const res = await axios.post(
      `${KOMMO_BASE}/leads`,
      payload,
      { headers: kommoHeaders() }
    );

    const created =
      res.data &&
      res.data._embedded &&
      res.data._embedded.leads &&
      res.data._embedded.leads[0];

    const leadId = created ? created.id : null;

    log('💼 Kommo lead created from LINE:', {
      lineUserId,
      contactId,
      leadId,
      leadName,
    });

    return { leadId };
  } catch (err) {
    log(
      '❌ Kommo create lead error:',
      err?.response?.status,
      err?.response?.data || err.message
    );
    return { leadId: null };
  }
}

// Load single Kommo contact by id (with tags)
async function fetchKommoContact(contactId) {
  if (!contactId || !KOMMO_BASE || !KOMMO_API_KEY) {
    return null;
  }

  try {
    const res = await axios.get(
      `${KOMMO_BASE}/contacts/${contactId}`,
      {
        params: { with: 'leads,tags' },
        headers: kommoHeaders(),
      }
    );

    return res.data || null;
  } catch (err) {
    log(
      '❌ Kommo fetch contact error:',
      err?.response?.status,
      err?.response?.data || err.message
    );
    return null;
  }
}

// Load single Kommo lead and its main contact
async function fetchKommoLeadWithContact(leadId) {
  if (!leadId || !KOMMO_BASE || !KOMMO_API_KEY) {
    return { lead: null, contact: null };
  }

  try {
    const res = await axios.get(
      `${KOMMO_BASE}/leads/${leadId}`,
      {
        params: { with: 'contacts' },
        headers: kommoHeaders(),
      }
    );

    const lead = res.data || null;
    let contact = null;

    const embeddedContacts =
      lead &&
      lead._embedded &&
      Array.isArray(lead._embedded.contacts)
        ? lead._embedded.contacts
        : [];

    if (embeddedContacts.length > 0) {
      const mainContactId = embeddedContacts[0].id;
      contact = await fetchKommoContact(mainContactId);
    }

    return { lead, contact };
  } catch (err) {
    log(
      '❌ Kommo fetch lead error:',
      err?.response?.status,
      err?.response?.data || err.message
    );
    return { lead: null, contact: null };
  }
}

// ---------- Routes ----------

// Healthcheck
app.get('/', (req, res) => {
  res.send('line-kommo-bridge is running');
});

// LINE webhook: must use raw body for signature
app.post(
  '/line/webhook',
  express.raw({ type: '*/*' }),
  async (req, res) => {
    const bodyStr = req.body.toString('utf8');

    if (!LINE_CHANNEL_SECRET) {
      log('⚠️ LINE_CHANNEL_SECRET is missing; skipping signature check');
    } else {
      const signature = req.headers['x-line-signature'];

      const expectedSignature = crypto
        .createHmac('sha256', LINE_CHANNEL_SECRET)
        .update(bodyStr)
        .digest('base64');

      if (signature !== expectedSignature) {
        log('❌ Invalid LINE signature');
        return res.status(401).send('Invalid signature');
      }
    }

    const body = safeJsonParse(bodyStr, null);

    if (!body || !Array.isArray(body.events)) {
      log('❌ LINE webhook: invalid body:', bodyStr);
      return res.status(400).send('Bad Request');
    }

    // Handle events concurrently but don't wait to reply to LINE
    (async () => {
      for (const event of body.events) {
        if (event.type !== 'message' || event.message.type !== 'text') {
          continue;
        }

        const lineUserId =
          event.source && event.source.userId ? event.source.userId : null;
        const text = event.message.text;

        log('📩 New LINE message:', { lineUserId, text });

        if (!lineUserId) continue;

        const profile = await getLineProfile(lineUserId);
        const displayName = profile?.displayName || null;

        const { contactId } =
          await ensureKommoContactForLineUser(lineUserId, displayName);

        await createKommoLeadFromLine(lineUserId, contactId, text);
      }
    })().catch((err) => {
      log('❌ Unexpected error in LINE event handler:', err);
    });

    res.status(200).send('OK');
  }
);

// Kommo widget webhook (from Emfy)
// IMPORTANT: Kommo expects JSON in response & needs CORS headers
app.all(
  '/kommo/webhook',
  express.text({ type: '*/*' }),
  async (req, res) => {
    // CORS headers for all responses
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', '*');
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

    if (req.method === 'OPTIONS') {
      // Preflight request
      return res.status(200).end();
    }

    const rawBody = req.body || '';
    const parsedBody = qs.parse(rawBody);

    log('📨 Kommo webhook raw body:', rawBody);
    log('📨 Kommo webhook parsed body:', parsedBody);

    try {
      // 1) Extract leadId & contactId from webhook payload
      const leadId =
        parsedBody['this_item[id]'] ||
        parsedBody['leads[update][0][id]'] ||
        parsedBody['leads[add][0][id]'] ||
        null;

      let contactId =
        parsedBody['this_item[_embedded][contacts][0][id]'] ||
        parsedBody['contacts[update][0][id]'] ||
        parsedBody['contacts[add][0][id]'] ||
        null;

      log('🔍 Extracted IDs from Kommo webhook →', {
        leadId,
        contactId,
      });

      let contact = null;

      if (contactId) {
        contact = await fetchKommoContact(contactId);
      } else if (leadId) {
        const leadWithContact = await fetchKommoLeadWithContact(leadId);
        contact = leadWithContact.contact;
        if (contact && contact.id) {
          contactId = contact.id;
        }
      }

      // 2) Try to get LINE userId from contact
      const lineUserIdFromContact = extractLineUserIdFromContact(contact);

      log('🔍 LINE userId from Kommo contact:', {
        fromContact: lineUserIdFromContact,
      });

      const finalLineUserId = lineUserIdFromContact || null;

      // 3) Extract reply text from widget payload
      const replyText =
        parsedBody['this_comment[text]'] ||
        parsedBody['this_comment'] ||
        parsedBody['comment[text]'] ||
        parsedBody['comment'] ||
        parsedBody['message'] ||
        parsedBody['text'] ||
        'Thank you for your message! We will get back to you shortly.';

      log('💬 Reply text from Kommo widget:', replyText);

      if (finalLineUserId) {
        await sendLineMessage(finalLineUserId, replyText);
      } else {
        log(
          '⚠️ No LINE userId found in Kommo contact; not sending anything to LINE.'
        );
      }

      // 4) Always respond with JSON so Kommo widget is happy
      const responsePayload = {
        ok: true,
        method: req.method,
        leadId: leadId || null,
        contactId: contactId || null,
        lineUserId: finalLineUserId,
        sent: Boolean(finalLineUserId),
        replyText,
      };

      log('⬅️ Responding to Kommo widget with JSON:', responsePayload);

      return res.status(200).json(responsePayload);
    } catch (err) {
      log('❌ Error in /kommo/webhook handler:', err);

      const errorPayload = {
        ok: false,
        error: err.message || 'Unknown error',
      };

      return res.status(500).json(errorPayload);
    }
  }
);

// ---------- Start server ----------

app.listen(PORT, () => {
  log(`line-kommo-bridge is running on port ${PORT}`);
});
