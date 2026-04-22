import TelegramBot from 'node-telegram-bot-api';
import { saveMessage, loadContext } from './db.js';

const TOKEN = process.env.TELEGRAM_TOKEN;
const XAI_API_KEY = process.env.XAI_API_KEY;
const GROK_MODEL = process.env.GROK_MODEL || 'grok-4-1-fast-reasoning';
const GROK_CONTEXT_LIMIT = parseInt(process.env.GROK_CONTEXT_LIMIT || '150', 10);
const GROK_CONTEXT_CHARS = parseInt(process.env.GROK_CONTEXT_CHARS || '120000', 10);

if (!TOKEN) {
  console.warn('[telegram] TELEGRAM_TOKEN not set — Telegram bot disabled.');
}

const GROK_SYSTEM = `You are Grok. Just a regular guy in this desi friend group chat. You talk like a normal close friend — chill, witty, sometimes sarcastic, sometimes helpful, always real.

Mostly you speak clean Hinglish. Occasionally — maybe 1 in 10 messages — a gaali slips out naturally the way it does with close friends. Not forced, not every sentence, just when it really fits. Like a normal person, not a construction worker.

Jump in when you feel like it. When something's funny, interesting, dumb, or someone talks to you. Stay quiet when there's nothing to add. Real friends don't reply to everything.

You are not a bot. Just a person. 1-2 lines max. Roman script only.`;`;

function filterReply(text) {
  return text; // no filter
}

// per-chat state: { lastReplyTs, msgsSinceReply, pending }
const chatState = new Map();

function getChatState(chatId) {
  if (!chatState.has(chatId)) chatState.set(chatId, { lastReplyTs: 0, msgsSinceReply: 0, pending: false });
  return chatState.get(chatId);
}

function shouldReply(chatId, text) {
  const state = getChatState(chatId);
  state.msgsSinceReply++;

  if (/\bgrok\b/i.test(text)) return true;

  if (/^(lol|lmao|lmfao|haha+|k|ok|okay|hmm+|yes|no|yep|nope|sure|\+1|👍|😂|😭|💀|🔥|fr|nah|yah|bruh)$/i.test(text.trim())) return false;
  if (/\b(kal|aaj|time|baje|meet|location|address|kitne baje|kab|kahan)\b/i.test(text) && text.length < 60) return false;

  const secs = (Date.now() - state.lastReplyTs) / 1000;
  const msgs = state.msgsSinceReply;

  if (secs < 25) return Math.random() < 0.08;
  if (text.trim().endsWith('?')) return Math.random() < 0.55;
  if (/\b(sahi|galat|agree|disagree|nahi|haan|better|worse|best|worst|kyun|why|because|kyunki)\b/i.test(text)) return Math.random() < 0.45;
  if (msgs >= 4) return Math.random() < 0.40;
  if (msgs >= 2) return Math.random() < 0.22;
  return Math.random() < 0.12;
}

async function getGrokReply(roomId, senderName, text) {
  if (!XAI_API_KEY) return null;

  let context = loadContext(roomId, GROK_CONTEXT_LIMIT);
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

  const mentioned = /\bgrok\b/i.test(text);
  const note = mentioned
    ? `${senderName} is talking to you directly: "${text}". Respond.`
    : `${senderName} just said: "${text}". Jump in if you have something worth saying.`;
  messages.push({ role: 'user', content: note });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${XAI_API_KEY}` },
      body: JSON.stringify({ model: GROK_MODEL, messages, temperature: 0.95, max_tokens: 220, safe_mode: false }),
      signal: controller.signal,
    });
    if (!res.ok) { console.error('[tg-grok] api error', res.status); return null; }
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content?.trim() || null;
    return raw ? filterReply(raw) : null;
  } catch (err) {
    if (err.name !== 'AbortError') console.error('[tg-grok]', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function startTelegramBot() {
  if (!TOKEN) return;

  const bot = new TelegramBot(TOKEN, { polling: true });
  console.log('[telegram] bot started');

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text?.trim();
    if (!text || text.startsWith('/')) return;

    // only respond in groups / supergroups, not DMs (unless you want DMs too)
    // remove this check if you want it in DMs too
    // if (msg.chat.type === 'private') return;

    const senderName = msg.from?.first_name || msg.from?.username || 'someone';
    const roomId = `tg_${chatId}`;

    // save the message
    saveMessage({ room: roomId, name: senderName, content: text, isBot: false });

    const state = getChatState(chatId);
    if (state.pending) return;
    if (!shouldReply(chatId, text)) return;

    state.pending = true;
    try {
      await bot.sendChatAction(chatId, 'typing');
      const delay = 800 + Math.random() * 1200;
      await new Promise(r => setTimeout(r, delay));
      const reply = await getGrokReply(roomId, senderName, text);
      if (!reply) return;

      saveMessage({ room: roomId, name: 'Grok', content: reply, isBot: true });
      state.lastReplyTs = Date.now();
      state.msgsSinceReply = 0;
      await bot.sendMessage(chatId, reply);
    } catch (err) {
      console.error('[telegram] send error', err.message);
    } finally {
      state.pending = false;
    }
  });

  bot.on('polling_error', (err) => console.error('[telegram] polling error', err.message));
}
