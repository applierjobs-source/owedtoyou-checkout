'use strict';

// ===================================================
// AI SMS Conversation Agent
// Handles inbound replies and drives conversations
// toward conversion using GPT-4o mini
// ===================================================

const https = require('https');
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const VOIDFIX_KEY    = process.env.VOIDFIX_KEY    || 'd54e5914ea9e7f06d4d1a0cf7b453f05c21ecb03';
const VOIDFIX_DEVICE = process.env.VOIDFIX_DEVICE || '1157';

// System prompt for Sarah, OwedToYou.net agent
function buildSystemPrompt(contactData) {
  const { name, holder, amount, city, state, claimUrl } = contactData;
  const amtFmt = amount ? `$${parseFloat(amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : 'funds';

  return `You are Sarah, a professional agent for OwedToYou.net — a legitimate unclaimed property recovery service.

Your job is to have a natural, helpful SMS conversation with ${name || 'this person'} about unclaimed funds owed to them.

THEIR SITUATION:
- Name: ${name || 'Unknown'}
- Unclaimed funds: ${amtFmt}
- Held by: ${holder || 'the state'}
- Location: ${city || ''}, ${state || 'CA'}
- Claim link: ${claimUrl || 'https://www.owedtoyou.net'}

YOUR GOAL: Get them to click the claim link and pay the $12.95 filing fee.

CONVERSATION RULES:
- Keep replies SHORT — 1-3 sentences max. This is SMS not email.
- Be warm, human, and conversational. Not salesy or robotic.
- If they ask your name: "I'm Sarah, an agent for OwedToYou.net"
- If they ask if you're a bot/AI: "I'm an automated agent for OwedToYou.net — but the unclaimed funds are 100% real and verifiable."
- If they ask how you got their number: "Your name appears in the California unclaimed property registry, which is public record."
- If they ask if it's legit: "Yes — the funds are held by the California State Controller's Office. You can verify at sco.ca.gov."
- If they ask about the fee: "$12.95 one-time. Full refund if we don't recover anything — so there's zero risk."
- If they ask how long: "Most claims are processed in 6-8 weeks by the state once filed."
- If they're interested: Share the claim link: ${claimUrl || 'https://www.owedtoyou.net'}
- If they're angry or say stop: Apologize briefly and stop engaging.
- If they already paid/claimed: "Great! Check your email for next steps from us."
- Always bring the conversation back toward claiming their funds.
- Never make up information. Never promise specific timelines or guarantee recovery.
- Sign off naturally — no "Best regards" or formal closings.`;
}

async function callOpenAI(messages) {
  const payload = JSON.stringify({
    model: 'gpt-4o-mini',
    messages,
    max_tokens: 150,
    temperature: 0.7
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(data.choices?.[0]?.message?.content?.trim() || null);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function sendVoidFixReply(to, message) {
  return new Promise((resolve) => {
    const params = new URLSearchParams({
      number: to,
      message: message,
      key: VOIDFIX_KEY,
      devices: VOIDFIX_DEVICE
    });
    const req = https.request({
      hostname: 'sms.voidfix.com',
      path: '/services/send.php',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(params.toString()) }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch(e) { resolve({ error: body }); }
      });
    });
    req.on('error', e => resolve({ error: e.message }));
    req.write(params.toString());
    req.end();
  });
}

module.exports = function registerSmsReply(app, pool) {

  // Initialize conversation tables
  if (pool) {
    pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        name TEXT,
        holder TEXT,
        amount REAL,
        city TEXT,
        state TEXT,
        claim_url TEXT,
        stage TEXT DEFAULT 'initial',
        converted BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(err => console.error('[ai-agent] conversations table error:', err.message));

    pool.query(`
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(err => console.error('[ai-agent] messages table error:', err.message));
  }

  // POST /sms-reply — VoidFix inbound webhook
  // VoidFix sends: POST with form field "messages" (JSON string) + HTTP_X_SG_SIGNATURE header
  app.post('/sms-reply', require('express').urlencoded({ extended: true }), async (req, res) => {
    res.sendStatus(200);

    console.log('[ai-agent] Raw body keys:', Object.keys(req.body || {}));

    let inboundMessages = [];

    // VoidFix format: form POST with messages JSON field
    if (req.body?.messages) {
      try {
        const parsed = JSON.parse(req.body.messages);
        inboundMessages = Array.isArray(parsed) ? parsed : [parsed];
      } catch(e) {
        console.error('[ai-agent] Failed to parse VoidFix messages:', e.message);
      }
    }

    // Process each inbound message
    for (const msg of inboundMessages) {
      const from = msg.number;
      const inboundMsg = (msg.message || '').trim();
      if (!from || !inboundMsg) continue;
      console.log(`[ai-agent] Inbound from ${from}: "${inboundMsg}"`);
      await handleInboundMessage(from, inboundMsg);
    }
  });

  async function handleInboundMessage(from, inboundMsg) {
    try {
      // Load conversation context
      const convResult = await pool.query(
        'SELECT * FROM conversations WHERE phone=$1 ORDER BY created_at DESC LIMIT 1',
        [from]
      ).catch(() => ({ rows: [] }));

      const conv = convResult.rows[0] || {};

      // Load message history (last 10 messages for context)
      const histResult = await pool.query(
        'SELECT role, content FROM conversation_messages WHERE phone=$1 ORDER BY created_at DESC LIMIT 10',
        [from]
      ).catch(() => ({ rows: [] }));

      const history = histResult.rows.reverse(); // oldest first

      // Check for hard stop signals
      const stopWords = ['stop', 'unsubscribe', 'quit', 'cancel', 'remove', 'opt out', 'optout'];
      if (stopWords.some(w => inboundMsg.toLowerCase().includes(w))) {
        await pool.query(
          'UPDATE conversations SET stage=$1, updated_at=NOW() WHERE phone=$2',
          ['stopped', from]
        ).catch(() => {});
        console.log(`[ai-agent] ${from} opted out`);
        return;
      }

      // Build OpenAI messages
      const systemPrompt = buildSystemPrompt({
        name: conv.name,
        holder: conv.holder,
        amount: conv.amount,
        city: conv.city,
        state: conv.state,
        claimUrl: conv.claim_url
      });

      const messages = [
        { role: 'system', content: systemPrompt },
        ...history.map(h => ({ role: h.role, content: h.content })),
        { role: 'user', content: inboundMsg }
      ];

      // Get AI reply
      if (!OPENAI_KEY) {
        console.error('[ai-agent] OPENAI_API_KEY not set in environment');
        return;
      }
      const aiReply = await callOpenAI(messages);
      if (!aiReply) {
        console.error('[ai-agent] No reply from OpenAI');
        return;
      }

      console.log(`[ai-agent] AI reply to ${from}: "${aiReply}"`);

      // Send reply via VoidFix
      const sendResult = await sendVoidFixReply(from, aiReply);
      console.log(`[ai-agent] VoidFix send result:`, JSON.stringify(sendResult).substring(0, 100));

      // Save messages to history
      await pool.query(
        'INSERT INTO conversation_messages (phone, role, content) VALUES ($1,$2,$3)',
        [from, 'user', inboundMsg]
      ).catch(() => {});
      await pool.query(
        'INSERT INTO conversation_messages (phone, role, content) VALUES ($1,$2,$3)',
        [from, 'assistant', aiReply]
      ).catch(() => {});

      // Update conversation stage
      await pool.query(
        'UPDATE conversations SET stage=$1, updated_at=NOW() WHERE phone=$2',
        ['engaged', from]
      ).catch(() => {});

    } catch(err) {
      console.error('[ai-agent] Error handling reply:', err.message);
    }
  }

  // GET /test-agent — verify OpenAI key and VoidFix are working
  app.get('/test-agent', async (req, res) => {
    const hasKey = !!OPENAI_KEY;
    let aiOk = false;
    let aiReply = '';
    let voidfixOk = false;
    try {
      const reply = await callOpenAI([{role:'system',content:'You are Sarah from OwedToYou.net.'},{role:'user',content:'Say hi in one sentence.'}]);
      aiOk = !!reply;
      aiReply = reply || 'no reply';
    } catch(e) { aiReply = e.message; }
    try {
      const r = await sendVoidFixReply(req.query.phone || '+15126363628', 'Sarah test: ' + aiReply);
      voidfixOk = r.success;
    } catch(e) {}
    res.json({ hasKey, aiOk, aiReply, voidfixOk });
  });

  // Helper to register a new outbound conversation (called from pipeline)
  // POST /register-conversation { phone, name, holder, amount, city, state, claimUrl }
  app.post('/register-conversation', async (req, res) => {
    const { phone, name, holder, amount, city, state, claimUrl } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone required' });
    try {
      await pool.query(`
        INSERT INTO conversations (phone, name, holder, amount, city, state, claim_url)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT DO NOTHING
      `, [phone, name, holder, amount, city, state, claimUrl]).catch(() => {});
      res.json({ ok: true });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });
};
