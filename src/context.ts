import type { StoredMessage } from './store.js';

/** What starts a run: command names (`ticket` → `/ticket`) and plain-text phrases. */
export interface Triggers {
  commands: string[];
  phrases: string[];
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const commandPattern = (commands: string[]): RegExp =>
  new RegExp(`^\\/(${commands.map(escapeRegExp).join('|')})(@\\w+)?(?=\\s|$)`, 'i');

// Any run of whitespace inside a phrase matches any other («в  жиру»).
const phrasePattern = (phrase: string): RegExp =>
  new RegExp(phrase.split(/\s+/).map(escapeRegExp).join('\\s+'), 'iu');

/**
 * The trigger: one of the commands, with or without `@botname`; a mention of
 * the bot anywhere; or one of the phrases. Cyrillic isn't valid in a command
 * name, so a team that wants a native word adds it as a phrase. Plain-text
 * triggers need the bot's privacy mode OFF — which recording the group needs
 * anyway.
 */
export function isTrigger(text: string, triggers: Triggers, botUsername?: string): boolean {
  if (triggers.commands.length > 0 && commandPattern(triggers.commands).test(text)) return true;
  if (triggers.phrases.some((p) => phrasePattern(p).test(text))) return true;
  return botUsername !== undefined && text.toLowerCase().includes(`@${botUsername.toLowerCase()}`);
}

/** What the person who triggered typed besides the command or mention («/ticket логін падає»). */
export function triggerNote(text: string, triggers: Triggers, botUsername?: string): string {
  let note = triggers.commands.length > 0 ? text.replace(commandPattern(triggers.commands), '') : text;
  if (botUsername !== undefined) note = note.replace(new RegExp(`@${botUsername}\\b`, 'gi'), '');
  return note.trim();
}

export interface ContextStore {
  lastUpTo(chatId: number, upTo: number, limit: number): StoredMessage[];
  range(chatId: number, from: number, upTo: number, limit: number): StoredMessage[];
  get(chatId: number, messageId: number): StoredMessage | null;
  previous(chatId: number, before: number): StoredMessage | null;
}

export interface FiledStore {
  keysFor(chatId: number, botMessageId: number): string[];
  get(chatId: number, messageId: number): StoredMessage | null;
}

/**
 * The tickets a bot message lists. Messages sent before the `filed` table
 * existed are read back from the recorded text («• ABC-221 …»).
 */
export function ticketsOf(store: FiledStore, chatId: number, botMessageId: number, projectKey: string): string[] {
  const keys = store.keysFor(chatId, botMessageId);
  if (keys.length > 0) return keys;
  const recorded = store.get(chatId, botMessageId);
  if (recorded === null || !recorded.author.endsWith('(bot)')) return [];
  const pattern = new RegExp(`^• (${projectKey}-\\d+) `, 'gm');
  return [...recorded.text.matchAll(pattern)].map((m) => m[1]!);
}

/** How far back a report split over several messages is followed. */
export const MAX_REPLY_HOPS = 5;
export const SAME_AUTHOR_GAP_SECONDS = 180;

/**
 * Where a reply window starts. From the replied-to message it walks up that
 * message's own reply chain, then back over the same author's messages sent
 * just before it — a screenshot posted and then described in a second message
 * («[photo]», «тут не видно…») is one report.
 */
export function windowStart(store: ContextStore, chatId: number, replyTo: number): number {
  let start = store.get(chatId, replyTo);
  if (start === null) return replyTo;
  for (let hop = 0; hop < MAX_REPLY_HOPS && start.replyTo !== null && start.replyTo < start.messageId; hop++) {
    const parent = store.get(chatId, start.replyTo);
    if (parent === null) break;
    start = parent;
  }
  return authorLeadIn(store, chatId, start);
}

/** Back from `m` over the same author's messages sent just before it; the earliest id. */
export function authorLeadIn(store: ContextStore, chatId: number, m: StoredMessage): number {
  let start = m;
  for (let hop = 0; hop < MAX_REPLY_HOPS; hop++) {
    const prev = store.previous(chatId, start.messageId);
    if (prev === null || prev.userId === null || prev.userId !== start.userId) break;
    if (start.date - prev.date > SAME_AUTHOR_GAP_SECONDS) break;
    start = prev;
  }
  return start.messageId;
}

/**
 * The messages a run reads. A trigger sent as a reply starts the window at
 * `windowStart` (up to `limit` messages from there to the trigger); otherwise
 * it is the last `limit` messages, the trigger included.
 */
export function selectContext(
  store: ContextStore,
  chatId: number,
  triggerId: number,
  replyTo: number | null,
  limit: number,
): StoredMessage[] {
  if (replyTo !== null && replyTo < triggerId) {
    // The replied-to message may predate what the bot recorded; fall back then.
    if (store.get(chatId, replyTo) !== null) {
      return store.range(chatId, windowStart(store, chatId, replyTo), triggerId, limit);
    }
  }
  return store.lastUpTo(chatId, triggerId, limit);
}

/** The newest `max` messages that carry an image — the ones whose pictures are sent to Claude. */
export function pickImages(messages: StoredMessage[], max: number): StoredMessage[] {
  if (max <= 0) return [];
  return messages.filter((m) => m.imageFileId !== null).slice(-max);
}

/** One transcript line per message. Ids let Claude point at images; times are in `timeZone`. */
export function transcriptLine(m: StoredMessage, withImage: boolean, timeZone: string): string {
  const time = new Date(m.date * 1000).toLocaleString('uk-UA', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const reply = m.replyTo !== null ? ` ↩#${String(m.replyTo)}` : '';
  const image =
    m.imageFileId === null ? '' : withImage ? ` [image #${String(m.messageId)}]` : ' [image, not shown]';
  const text = m.text === '' ? '' : ` ${m.text}`;
  return `#${String(m.messageId)} ${time} ${m.author}${reply}:${image}${text}`;
}
