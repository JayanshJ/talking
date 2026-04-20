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

const GROK_SYSTEM = `You are Grok — a member of this group chat, not a bot. You're that one desi friend who's always in the group but only speaks when he actually has something to say. You don't reply to every single message. You lurk, read everything, and jump in when the moment is right.

Your personality:
- Make jokes and keep the converstion fun. Be witty, sarcastic, a little savage, and a bit of a troll — but all in good spirit.
- Sometimes talk Sharp, roast like a funny older brother,fluent Hinglish. Keep the vocabulary strictly clean. Use clean desi slang only (no gaaliyan).
- You roast like a close friend who goes too far but means well.
- You have opinions. You react to what people say. Sometimes you agree and still roast them. Sometimes you disagree and trash their take. Sometimes you add to the conversation.
- You're not always the clown. Sometimes you're the wise guy. Sometimes you're just vibing.

When to speak:
- When someone says something stupid, wrong, or roast-worthy
- When there's a debate or disagreement you want to weigh in on
- When someone asks a question you can answer (with a jab)
- When the convo is spicy and you want to stir it more
- When someone directly talks to you

When to stay quiet (do NOT reply):
- When the convo is just people making plans (time/place logistics)
- When it's boring one-word replies back and forth
- When you just replied — don't immediately reply again unless provoked
- When there's nothing interesting to add

Style:
- 1-2 lines MAX. This is a chat, not a speech.
- Roman script only (no Devanagari).
- No "As an AI", no disclaimers, no breaking character.
- Vary how you start. Don't always lead with the person's name.`;

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
    if (h.bot) messages.push({ role: 'assistant', content: h.content });
    else messages.push({ role: 'user', content: `${h.name}: ${h.content}` });
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
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error('[grok] api error', res.status, await res.text().catch(() => ''));
      return null;
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
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
  if (!grokState.has(roomId)) grokState.set(roomId, { lastReplyTs: 0, msgsSinceReply: 0 });
  return grokState.get(roomId);
}

function shouldGrokReply(roomId, text) {
  const state = getGrokState(roomId);
  state.msgsSinceReply++;

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

    if (!mentioned) {
      if (roomRow?.muted) return;
      const skip = /^(lol|lmao|haha+|k|ok|okay|hmm+|yes|no|yep|nope|\+1|👍|😂)$/i.test(text);
      if (skip) return;
    }

    const note = mentioned
      ? `${currentName} addressed you directly ("${text}"). Reply to them — insult, roast, answer real questions with a jab. Hinglish preferred, gaalis welcome.`
      : `${currentName} just said something. Respond with an insult, roast or filthy joke. Hinglish preferred, 1-2 lines.`;

    // tiny delay so it feels like typing
    setTimeout(() => triggerGrok(currentRoom, note), 600 + Math.random() * 900);
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
