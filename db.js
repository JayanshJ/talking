import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'talking.db');

import fs from 'fs';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    room       TEXT    NOT NULL,
    name       TEXT    NOT NULL,
    content    TEXT    NOT NULL,
    is_bot     INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room, created_at DESC);

  CREATE TABLE IF NOT EXISTS rooms (
    room       TEXT PRIMARY KEY,
    muted      INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
`);

const stmts = {
  insertMessage: db.prepare(
    `INSERT INTO messages (room, name, content, is_bot, created_at) VALUES (?, ?, ?, ?, ?)`
  ),
  recentMessages: db.prepare(
    `SELECT id, name, content, is_bot, created_at FROM messages WHERE room = ? ORDER BY id DESC LIMIT ?`
  ),
  contextMessages: db.prepare(
    `SELECT name, content, is_bot FROM messages WHERE room = ? ORDER BY id DESC LIMIT ?`
  ),
  ensureRoom: db.prepare(
    `INSERT OR IGNORE INTO rooms (room, muted, created_at) VALUES (?, 0, ?)`
  ),
  getRoom: db.prepare(`SELECT room, muted FROM rooms WHERE room = ?`),
  setMuted: db.prepare(`UPDATE rooms SET muted = ? WHERE room = ?`),
};

export function saveMessage({ room, name, content, isBot }) {
  const ts = Date.now();
  const info = stmts.insertMessage.run(room, name, content, isBot ? 1 : 0, ts);
  return { id: info.lastInsertRowid, ts };
}

export function loadHistory(room, limit = 100) {
  const rows = stmts.recentMessages.all(room, limit);
  return rows
    .reverse()
    .map((r) => ({ id: r.id, name: r.name, content: r.content, bot: !!r.is_bot, ts: r.created_at }));
}

export function loadContext(room, limit = 40) {
  const rows = stmts.contextMessages.all(room, limit);
  return rows.reverse().map((r) => ({ name: r.name, content: r.content, bot: !!r.is_bot }));
}

export function ensureRoom(room) {
  stmts.ensureRoom.run(room, Date.now());
  return stmts.getRoom.get(room);
}

export function setMuted(room, muted) {
  stmts.setMuted.run(muted ? 1 : 0, room);
}

export function closeDb() {
  db.close();
}
