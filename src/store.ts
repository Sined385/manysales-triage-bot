import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** One group message as the bot saw it. The Bot API has no history, so this is the only record. */
export interface StoredMessage {
  chatId: number;
  messageId: number;
  userId: number | null;
  author: string;
  /** Unix seconds. */
  date: number;
  /** Text or caption; '' when the message is a bare photo. */
  text: string;
  replyTo: number | null;
  /** Telegram file_id of the largest photo size (or an image sent as a file). */
  imageFileId: string | null;
}

/** How many messages per chat are kept; older ones are pruned on insert. */
export const KEEP_PER_CHAT = 1000;

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        chat_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        user_id INTEGER,
        author TEXT NOT NULL,
        date INTEGER NOT NULL,
        text TEXT NOT NULL,
        reply_to INTEGER,
        image_file_id TEXT,
        PRIMARY KEY (chat_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS filed (
        chat_id INTEGER NOT NULL,
        bot_message_id INTEGER NOT NULL,
        issue_key TEXT NOT NULL,
        PRIMARY KEY (chat_id, bot_message_id, issue_key)
      );
      CREATE TABLE IF NOT EXISTS runs (
        day TEXT PRIMARY KEY,
        count INTEGER NOT NULL
      );
    `);
  }

  save(m: StoredMessage): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO messages
           (chat_id, message_id, user_id, author, date, text, reply_to, image_file_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(m.chatId, m.messageId, m.userId, m.author, m.date, m.text, m.replyTo, m.imageFileId);
    this.db
      .prepare(
        `DELETE FROM messages WHERE chat_id = ? AND message_id <= (
           SELECT message_id FROM messages WHERE chat_id = ?
           ORDER BY message_id DESC LIMIT 1 OFFSET ?)`,
      )
      .run(m.chatId, m.chatId, KEEP_PER_CHAT);
  }

  /** Messages of a chat with id ≤ `upTo`, newest last, at most `limit`. */
  lastUpTo(chatId: number, upTo: number, limit: number): StoredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE chat_id = ? AND message_id <= ?
         ORDER BY message_id DESC LIMIT ?`,
      )
      .all(chatId, upTo, limit) as unknown as Row[];
    return rows.map(fromRow).reverse();
  }

  get(chatId: number, messageId: number): StoredMessage | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE chat_id = ? AND message_id = ?').get(chatId, messageId) as
      | Row
      | undefined;
    return row === undefined ? null : fromRow(row);
  }

  /** The newest message of a chat with id < `before`, or null. */
  previous(chatId: number, before: number): StoredMessage | null {
    const row = this.db
      .prepare('SELECT * FROM messages WHERE chat_id = ? AND message_id < ? ORDER BY message_id DESC LIMIT 1')
      .get(chatId, before) as Row | undefined;
    return row === undefined ? null : fromRow(row);
  }

  /** Messages of a chat with `from` ≤ id ≤ `upTo`, oldest first, at most `limit` from `from`. */
  range(chatId: number, from: number, upTo: number, limit: number): StoredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE chat_id = ? AND message_id >= ? AND message_id <= ?
         ORDER BY message_id ASC LIMIT ?`,
      )
      .all(chatId, from, upTo, limit) as unknown as Row[];
    return rows.map(fromRow);
  }

  /** Records which tickets a bot message lists, so a reply to it can update them. */
  saveFiled(chatId: number, botMessageId: number, keys: string[]): void {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO filed (chat_id, bot_message_id, issue_key) VALUES (?, ?, ?)');
    for (const key of keys) stmt.run(chatId, botMessageId, key);
  }

  /** The tickets a bot message lists, in filing order; [] for any other message. */
  keysFor(chatId: number, botMessageId: number): string[] {
    const rows = this.db
      .prepare('SELECT issue_key FROM filed WHERE chat_id = ? AND bot_message_id = ? ORDER BY rowid')
      .all(chatId, botMessageId) as unknown as { issue_key: string }[];
    return rows.map((r) => r.issue_key);
  }

  /** Counts one run against today's (UTC) cap; false when the cap is already reached. */
  takeRun(day: string, limit: number): boolean {
    const row = this.db.prepare('SELECT count FROM runs WHERE day = ?').get(day) as
      | { count: number }
      | undefined;
    if ((row?.count ?? 0) >= limit) return false;
    this.db
      .prepare('INSERT INTO runs (day, count) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET count = count + 1')
      .run(day);
    return true;
  }
}

interface Row {
  chat_id: number;
  message_id: number;
  user_id: number | null;
  author: string;
  date: number;
  text: string;
  reply_to: number | null;
  image_file_id: string | null;
}

const fromRow = (r: Row): StoredMessage => ({
  chatId: r.chat_id,
  messageId: r.message_id,
  userId: r.user_id,
  author: r.author,
  date: r.date,
  text: r.text,
  replyTo: r.reply_to,
  imageFileId: r.image_file_id,
});
