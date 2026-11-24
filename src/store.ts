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
      CREATE TABLE IF NOT EXISTS gh_cursor (
        repo TEXT PRIMARY KEY,
        since TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS releases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        state TEXT NOT NULL,
        last_merge_at TEXT NOT NULL,
        chat_id INTEGER,
        draft_message_id INTEGER,
        draft_text TEXT,
        team_note TEXT,
        flagged TEXT NOT NULL DEFAULT '[]',
        revisions INTEGER NOT NULL DEFAULT 0,
        draft_attempts INTEGER NOT NULL DEFAULT 0,
        limit_notified INTEGER NOT NULL DEFAULT 0,
        published_by INTEGER,
        published_at TEXT,
        channel_message_id INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS release_prs (
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        merged_at TEXT NOT NULL,
        release_id INTEGER NOT NULL REFERENCES releases(id),
        PRIMARY KEY (repo, number)
      );
      CREATE TABLE IF NOT EXISTS announce_runs (
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
    return this.takeCounted('runs', day, limit);
  }

  /** Counts one announcement Claude call against today's (UTC) cap, apart from triage runs. */
  takeAnnounceRun(day: string, limit: number): boolean {
    return this.takeCounted('announce_runs', day, limit);
  }

  private takeCounted(table: 'runs' | 'announce_runs', day: string, limit: number): boolean {
    const row = this.db.prepare(`SELECT count FROM ${table} WHERE day = ?`).get(day) as
      | { count: number }
      | undefined;
    if ((row?.count ?? 0) >= limit) return false;
    this.db
      .prepare(`INSERT INTO ${table} (day, count) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET count = count + 1`)
      .run(day);
    return true;
  }

  // --- Release announcements ---

  /** The newest merge time already seen in a repo; null before the first poll. */
  cursor(repo: string): string | null {
    const row = this.db.prepare('SELECT since FROM gh_cursor WHERE repo = ?').get(repo) as { since: string } | undefined;
    return row?.since ?? null;
  }

  setCursor(repo: string, since: string): void {
    this.db
      .prepare('INSERT INTO gh_cursor (repo, since) VALUES (?, ?) ON CONFLICT(repo) DO UPDATE SET since = excluded.since')
      .run(repo, since);
  }

  /** The release still collecting merges; there is at most one. */
  openRelease(): Release | null {
    const row = this.db.prepare("SELECT * FROM releases WHERE state = 'collecting' ORDER BY id LIMIT 1").get() as
      | ReleaseRow
      | undefined;
    return row === undefined ? null : fromReleaseRow(row);
  }

  createRelease(lastMergeAt: string, now: string): Release {
    const res = this.db
      .prepare("INSERT INTO releases (state, last_merge_at, created_at) VALUES ('collecting', ?, ?)")
      .run(lastMergeAt, now);
    return this.release(Number(res.lastInsertRowid))!;
  }

  release(id: number): Release | null {
    const row = this.db.prepare('SELECT * FROM releases WHERE id = ?').get(id) as ReleaseRow | undefined;
    return row === undefined ? null : fromReleaseRow(row);
  }

  releasesIn(states: ReleaseState[]): Release[] {
    if (states.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT * FROM releases WHERE state IN (${states.map(() => '?').join(', ')}) ORDER BY id`)
      .all(...states) as unknown as ReleaseRow[];
    return rows.map(fromReleaseRow);
  }

  /** The release whose draft is this bot message; null for any other message. */
  releaseByDraft(chatId: number, messageId: number): Release | null {
    const row = this.db
      .prepare('SELECT * FROM releases WHERE chat_id = ? AND draft_message_id = ?')
      .get(chatId, messageId) as ReleaseRow | undefined;
    return row === undefined ? null : fromReleaseRow(row);
  }

  /** Whether a merged PR is already part of some release. */
  hasPr(repo: string, number: number): boolean {
    return this.db.prepare('SELECT 1 FROM release_prs WHERE repo = ? AND number = ?').get(repo, number) !== undefined;
  }

  /** Records a merged PR in a release; false when it was already recorded (in any release). */
  addPr(repo: string, number: number, mergedAt: string, releaseId: number): boolean {
    const res = this.db
      .prepare('INSERT OR IGNORE INTO release_prs (repo, number, merged_at, release_id) VALUES (?, ?, ?, ?)')
      .run(repo, number, mergedAt, releaseId);
    if (res.changes !== 1) return false;
    // ISO-8601 UTC strings of one format compare as text.
    this.db
      .prepare('UPDATE releases SET last_merge_at = max(last_merge_at, ?) WHERE id = ?')
      .run(mergedAt, releaseId);
    return true;
  }

  prsOf(releaseId: number): ReleasePr[] {
    const rows = this.db
      .prepare('SELECT repo, number, merged_at FROM release_prs WHERE release_id = ? ORDER BY merged_at, repo, number')
      .all(releaseId) as unknown as { repo: string; number: number; merged_at: string }[];
    return rows.map((r) => ({ repo: r.repo, number: r.number, mergedAt: r.merged_at }));
  }

  /**
   * The one atomic transition: moves a release to `to` only if it is in one of
   * `from`, in a single UPDATE. False means another press or tick got there first.
   */
  setState(id: number, from: ReleaseState[], to: ReleaseState, patch: ReleasePatch = {}): boolean {
    const cols = (Object.keys(patch) as (keyof ReleasePatch)[]).filter((k) => PATCHABLE.has(k));
    const sets = ['state = ?', ...cols.map((c) => `${c} = ?`)].join(', ');
    const res = this.db
      .prepare(`UPDATE releases SET ${sets} WHERE id = ? AND state IN (${from.map(() => '?').join(', ')})`)
      .run(to, ...cols.map((c) => patch[c] ?? null), id, ...from);
    return res.changes === 1;
  }

  saveDraft(
    id: number,
    d: { chatId: number; messageId: number; text: string; note: string; flagged: string[]; revisions: number },
  ): void {
    this.db
      .prepare(
        `UPDATE releases SET chat_id = ?, draft_message_id = ?, draft_text = ?, team_note = ?, flagged = ?, revisions = ?
         WHERE id = ?`,
      )
      .run(d.chatId, d.messageId, d.text, d.note, JSON.stringify(d.flagged), d.revisions, id);
  }
}

export type ReleaseState =
  | 'collecting'
  | 'drafting'
  | 'drafted'
  | 'editing'
  | 'revising'
  | 'publishing'
  | 'published'
  | 'cancelled'
  | 'empty';

export interface Release {
  id: number;
  state: ReleaseState;
  lastMergeAt: string;
  /** The team chat the draft is in; null before the draft is sent. */
  chatId: number | null;
  draftMessageId: number | null;
  /** The post as it would be published; '' when there is nothing to announce. */
  draftText: string;
  teamNote: string;
  /** Post-check findings; a release with any is never published. */
  flagged: string[];
  revisions: number;
  draftAttempts: number;
  limitNotified: boolean;
  publishedBy: number | null;
  publishedAt: string | null;
  channelMessageId: number | null;
  createdAt: string;
}

export interface ReleasePr {
  repo: string;
  number: number;
  mergedAt: string;
}

export interface ReleasePatch {
  published_by?: number | null;
  published_at?: string | null;
  channel_message_id?: number | null;
  draft_attempts?: number;
  limit_notified?: number;
}

const PATCHABLE = new Set<keyof ReleasePatch>([
  'published_by',
  'published_at',
  'channel_message_id',
  'draft_attempts',
  'limit_notified',
]);

interface ReleaseRow {
  id: number;
  state: ReleaseState;
  last_merge_at: string;
  chat_id: number | null;
  draft_message_id: number | null;
  draft_text: string | null;
  team_note: string | null;
  flagged: string;
  revisions: number;
  draft_attempts: number;
  limit_notified: number;
  published_by: number | null;
  published_at: string | null;
  channel_message_id: number | null;
  created_at: string;
}

const fromReleaseRow = (r: ReleaseRow): Release => ({
  id: r.id,
  state: r.state,
  lastMergeAt: r.last_merge_at,
  chatId: r.chat_id,
  draftMessageId: r.draft_message_id,
  draftText: r.draft_text ?? '',
  teamNote: r.team_note ?? '',
  flagged: JSON.parse(r.flagged) as string[],
  revisions: r.revisions,
  draftAttempts: r.draft_attempts,
  limitNotified: r.limit_notified === 1,
  publishedBy: r.published_by,
  publishedAt: r.published_at,
  channelMessageId: r.channel_message_id,
  createdAt: r.created_at,
});

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
