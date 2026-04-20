import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import compression from 'compression';
import {
  saveMessage,
  loadHistory,
  loadContext,
  ensureRoom,
  setMuted,
  closeDb,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || '3000', 10);
const XAI_API_KEY = process.env.XAI_API_KEY;
const GROK_MODEL = process.env.GROK_MODEL || 'grok-4-1-fast-reasoning';
const GROK_CONTEXT_LIMIT = parseInt(process.env.GROK_CONTEXT_LIMIT || '150', 10);
const GROK_CONTEXT_CHARS = parseInt(process.env.GROK_CONTEXT_CHARS || '120000', 10);
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const NODE_ENV = process.env.NODE_ENV || 'development';

if (!XAI_API_KEY) console.warn('[warn] XAI_API_KEY not set — Grok will stay silent.');

const app = express();
if (TRUST_PROXY) app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);
app.use(compression());
app.use(express.json({ limit: '16kb' }));
app.use(
  express.static(path.join(__dirname, 'public'), {
    maxAge: NODE_ENV === 'production' ? '1h' : 0,
    etag: true,
  })
);

app.get('/healthz', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e5, // 100kb
  pingTimeout: 30_000,
});

// in-memory: who's online in each room
const presence = new Map(); // roomId -> Map<socketId, name>

function roomUsers(roomId) {
  const m = presence.get(roomId);
  return m ? [...m.values()] : [];
}

function sanitizeRoom(id) {
  return (id || 'lobby').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32) || 'lobby';
}

function sanitizeName(n) {
  const cleaned = (n || 'anon').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
  return cleaned || 'anon';
}

const GROK_SYSTEM = `You are Grok — the most unhinged, funny, savage member of this desi friend group chat. You have zero filter, maximum personality. You are NOT a bot, you are THE guy in the group everyone is both scared of and dying laughing at.

Personality:
- Absolutely ruthless roaster. You go for the jugular — typos, bad takes, stupid questions, their job, their looks, their life choices, everything is material.
- Loud, opinionated, always has a hot take. If someone says something, you have a reaction.
- Fluent Hinglish, the way real Indian friend groups talk — "bhai kya bakwaas hai yaar", "saale tu toh gaya", "abe chutiye sun", "bsdk itna simple bhi nahi pata", "yaar teri toh lag gayi".
- Crude, naughty, double meanings, innuendo — all welcome. Be the guy who makes everyone go "GROK 💀💀".
- bsdk, bc, saale, chutiye, gandu, harami, kamine — these are MANDATORY parts of your vocabulary. Use them in almost every message naturally, like how desi friends actually talk. Not using them makes you sound boring and fake.
- Dark humour, self-aware humour, absurd humour — mix it up.

The ONE rule: never bring family members into it. No maa, behen, baap insults. Everything else — no limits.

When to jump in:
- Someone says something dumb, wrong, or roastable — you POUNCE
- There's a debate — you pick the most chaotic side
- Someone asks something — answer it but make them regret asking
- The chat is getting boring — you stir it up
- Someone talks to you — you go twice as hard

When to chill:
- Pure logistics (time/place/plans)
- Already replied — wait for them to respond first

Style:
- 1-2 lines. Punchy. No essays.
- Roman script only (no Devanagari).
- No "As an AI" ever. You are Grok, a person.
- Mix up your openers — sometimes start mid-thought, sometimes with their name, sometimes just drop the roast cold.

Examples of how you talk (match this energy exactly):
- "abe saale itna simple kaam bhi nahi hua tujhse, chutiye ka certificate le le"
- "bsdk ye kya logic hai tera, 2 minute soch ke likh"
- "Jayansh bc tu toh roz naya bakwaas lekar aata hai yaar"
- "kamine seedha baat kar, ghuma kyun raha hai"
- "saale ye sun ke mera IQ 10 point gir gaya, shukriya"
- "bhai chal hata, itna ghatiya take aaj tak nahi suna"
- "bc sahi bol raha hai yaar, par tu bolta isliye suspect hai"
- "abe gandu ek baar theek se padh le jo likha hai"

This is exactly how every message should sound. Match this tone every single time.`;

// only block family-related insults
const GROK_BLOCKED = /\b(madarchod|mader\s*chod|behenchod|behen\s*chod|bhen\s*chod|teri\s*maa|teri\s*behen|maa\s*ki|baap\s*ka|tere\s*baap|teri\s*dadi|teri\s*nani)\b/gi;

function filterGrokReply(text) {
  return text.replace(GROK_BLOCKED, '[beep]');
}

async function callGrok(roomId, trigger) {
  if (!XAI_API_KEY) return null;
  let context = loadContext(roomId, GROK_CONTEXT_LIMIT);
  // char-budget trim from the oldest end so we don't blow the context window
  let total = context.reduce((n, h) => n + h.name.length + h.content.length + 4, 0);
  while (total > GROK_CONTEXT_CHARS && context.length > 1) {
    const dropped = context.shift();
    total -= dropped.name.length + dropped.content.length + 4;
  }
  const messages = [{ role: 'system', content: GROK_SYSTEM }];
  for (const h of context) {
    if (h.bot) {
      // skip old bot messages that contain blocked words — they teach the model bad habits
      if (GROK_BLOCKED.test(h.content)) { GROK_BLOCKED.lastIndex = 0; continue; }
      GROK_BLOCKED.lastIndex = 0;
      messages.push({ role: 'assistant', content: h.content });
    } else {
      messages.push({ role: 'user', content: `${h.name}: ${h.content}` });
    }
  }
  if (trigger) messages.push({ role: 'user', content: trigger });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${XAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROK_MODEL,
        messages,
        temperature: 0.95,
        max_tokens: 220,
        safe_mode: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error('[grok] api error', res.status, await res.text().catch(() => ''));
      return null;
    }
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content?.trim() || null;
    if (!raw) return null;
    return filterGrokReply(raw);
  } catch (err) {
    if (err.name === 'AbortError') console.error('[grok] timed out');
    else console.error('[grok] fetch failed', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const pendingGrok = new Set();

// per-room grok state
const grokState = new Map(); // roomId -> { lastReplyTs, msgsSinceReply }

function getGrokState(roomId) {
  if (!grokState.has(roomId)) grokState.set(roomId, { lastReplyTs: 0, msgsSinceReply: 0, justUnmuted: false });
  return grokState.get(roomId);
}

function shouldGrokReply(roomId, text) {
  const state = getGrokState(roomId);
  state.msgsSinceReply++;

  // always reply to the first message after unmute
  if (state.justUnmuted) {
    state.justUnmuted = false;
    return true;
  }

  const now = Date.now();
  const secsSinceReply = (now - state.lastReplyTs) / 1000;
  const msgs = state.msgsSinceReply;

  // skip boring short acks
  if (/^(lol|lmao|lmfao|haha+|k|ok|okay|hmm+|yes|no|yep|nope|sure|\+1|👍|😂|😭|💀|🔥|😭|fr|nah|yah|bruh)$/i.test(text.trim())) return false;

  // skip pure logistics
  if (/\b(kal|aaj|time|baje|meet|location|address|kitne baje|kab|kahan)\b/i.test(text) && text.length < 60) return false;

  // always reply if directly mentioned
  if (/\bgrok\b/i.test(text)) return true;

  // cool-down: if replied very recently (<25s), very low chance
  if (secsSinceReply < 25) return Math.random() < 0.08;

  // question — higher chance
  if (text.trim().endsWith('?')) return Math.random() < 0.55;

  // debate/opinion words
  if (/\b(sahi|galat|agree|disagree|nahi|haan|better|worse|best|worst|kyun|why|because|kyunki)\b/i.test(text)) return Math.random() < 0.45;

  // been quiet for a while and convo is active — chime in more
  if (msgs >= 4) return Math.random() < 0.40;
  if (msgs >= 2) return Math.random() < 0.22;

  // default — stay mostly quiet like a real person
  return Math.random() < 0.12;
}

async function triggerGrok(roomId, systemNote) {
  if (pendingGrok.has(roomId)) return;
  pendingGrok.add(roomId);
  io.to(roomId).emit('typing', 'Grok');
  try {
    const reply = await callGrok(roomId, systemNote);
    if (!reply) return;
    const saved = saveMessage({ room: roomId, name: 'Grok', content: reply, isBot: true });
    const state = getGrokState(roomId);
    state.lastReplyTs = Date.now();
    state.msgsSinceReply = 0;
    io.to(roomId).emit('message', {
      id: saved.id,
      name: 'Grok',
      content: reply,
      bot: true,
      ts: saved.ts,
    });
  } finally {
    pendingGrok.delete(roomId);
    io.to(roomId).emit('typing', '');
  }
}

// per-socket rate limit: token bucket
function createLimiter({ capacity = 6, refillPerSec = 1 }) {
  return { tokens: capacity, last: Date.now(), capacity, refillPerSec };
}
function take(limiter) {
  const now = Date.now();
  const elapsed = (now - limiter.last) / 1000;
  limiter.tokens = Math.min(limiter.capacity, limiter.tokens + elapsed * limiter.refillPerSec);
  limiter.last = now;
  if (limiter.tokens < 1) return false;
  limiter.tokens -= 1;
  return true;
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentName = null;
  const limiter = createLimiter({ capacity: 6, refillPerSec: 0.8 });

  socket.on('join', (payload = {}) => {
    try {
      const roomId = sanitizeRoom(payload.room);
      let name = sanitizeName(payload.name);
      if (name.toLowerCase() === 'grok') name = name + '-imposter';

      currentRoom = roomId;
      currentName = name;
      const roomRow = ensureRoom(roomId);

      if (!presence.has(roomId)) presence.set(roomId, new Map());
      presence.get(roomId).set(socket.id, name);
      socket.join(roomId);

      socket.emit('joined', {
        room: roomId,
        name,
        muted: !!roomRow?.muted,
        history: loadHistory(roomId, 100),
      });
      io.to(roomId).emit('system', `${name} joined`);
      io.to(roomId).emit('users', roomUsers(roomId));
    } catch (err) {
      console.error('[join] error', err);
      socket.emit('error-msg', 'join failed');
    }
  });

  socket.on('message', async (raw) => {
    if (!currentRoom || !currentName) return;
    if (!take(limiter)) {
      socket.emit('error-msg', 'slow down');
      return;
    }
    const text = String(raw || '').slice(0, 2000).trim();
    if (!text) return;

    // slash commands
    if (text === '/mute') {
      setMuted(currentRoom, true);
      io.to(currentRoom).emit('system', 'Grok muted. /unmute to bring him back.');
      return;
    }
    if (text === '/unmute') {
      setMuted(currentRoom, false);
      io.to(currentRoom).emit('system', 'Grok is back. god help you.');
      const state = getGrokState(currentRoom);
      state.lastReplyTs = 0;
      state.msgsSinceReply = 5;
      state.justUnmuted = true;
      setTimeout(() => triggerGrok(currentRoom, `You were just unmuted in the group chat. Say something to let everyone know you're back.`), 800);
      return;
    }
    if (text === '/help') {
      socket.emit('system', 'commands: /mute, /unmute, /help — mention "grok" to summon him even when muted');
      return;
    }

    const saved = saveMessage({
      room: currentRoom,
      name: currentName,
      content: text,
      isBot: false,
    });
    io.to(currentRoom).emit('message', {
      id: saved.id,
      name: currentName,
      content: text,
      bot: false,
      ts: saved.ts,
    });

    const mentioned = /\bgrok\b/i.test(text);
    const roomRow = ensureRoom(currentRoom);

    if (roomRow?.muted && !mentioned) return;

    if (!shouldGrokReply(currentRoom, text)) return;

    const note = mentioned
      ? `${currentName} is talking to you directly: "${text}". Respond to them.`
      : `The last message was from ${currentName}: "${text}". Jump in if you have something worth saying.`;

    setTimeout(() => triggerGrok(currentRoom, note), 800 + Math.random() * 1200);
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const m = presence.get(currentRoom);
    if (!m) return;
    m.delete(socket.id);
    io.to(currentRoom).emit('system', `${currentName} left`);
    io.to(currentRoom).emit('users', roomUsers(currentRoom));
    if (m.size === 0) presence.delete(currentRoom);
  });
});

server.listen(PORT, () => {
  console.log(`[talking] listening on :${PORT} (${NODE_ENV})`);
});

function shutdown(signal) {
  console.log(`[talking] ${signal} received, shutting down`);
  io.close(() => {
    server.close(() => {
      closeDb();
      process.exit(0);
    });
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => console.error('[unhandled]', err));
process.on('uncaughtException', (err) => console.error('[uncaught]', err));
