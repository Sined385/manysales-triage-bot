import { authorLeadIn, pickImages, selectContext, type ContextStore } from './context.js';
import type { Attachment, IssueText, NewIssue } from './jira.js';
import type { StoredMessage } from './store.js';
import type { Triage, TriageImage, TriageInput, Update, UpdateInput } from './triage.js';

/** Claude's per-image limit. A bigger image is neither shown nor attached. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface RunDeps {
  store: ContextStore;
  /** Downloads a Telegram file by file_id. */
  download(fileId: string): Promise<Uint8Array>;
  triage(input: TriageInput): Promise<Triage>;
  update?(input: UpdateInput): Promise<Update>;
  jira: {
    createIssue(issue: NewIssue): Promise<string>;
    getIssue?(key: string): Promise<IssueText>;
    updateIssue?(key: string, issue: IssueText): Promise<void>;
    attach(key: string, files: Attachment[]): Promise<void>;
    issueUrl(key: string): string;
  };
  log(event: string, fields: Record<string, unknown>): void;
}

export interface RunRequest {
  chatId: number;
  triggerId: number;
  replyTo: number | null;
  note: string;
  triggeredBy: string;
  contextMessages: number;
  maxImages: number;
  maxTickets: number;
}

export interface Filed {
  key: string;
  url: string;
  summary: string;
  attached: number;
  /** False when the issue exists but its images could not be attached. */
  attachOk: boolean;
}

export interface RunResult {
  chatReply: string;
  filed: Filed[];
}

/** Image type from its first bytes; null when it is not one Claude takes. */
export function sniffImage(data: Uint8Array): TriageImage['mediaType'] | null {
  const b = data;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
    return 'image/webp';
  return null;
}

const EXT: Record<TriageImage['mediaType'], string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

interface LoadedImage extends TriageImage {
  data: Uint8Array;
}

async function loadImages(
  deps: RunDeps,
  chatId: number,
  messages: StoredMessage[],
  max: number,
): Promise<LoadedImage[]> {
  const images: LoadedImage[] = [];
  for (const m of pickImages(messages, max)) {
    try {
      const data = await deps.download(m.imageFileId!);
      const mediaType = sniffImage(data);
      if (mediaType === null || data.byteLength > MAX_IMAGE_BYTES) {
        deps.log('image_skipped', { chatId: chatId, messageId: m.messageId, bytes: data.byteLength });
        continue;
      }
      images.push({ messageId: m.messageId, mediaType, base64: Buffer.from(data).toString('base64'), data });
    } catch (err) {
      deps.log('image_download_failed', { chatId: chatId, messageId: m.messageId, error: errorName(err) });
    }
  }

  return images;
}

const attachmentsFor = (images: LoadedImage[], ids: number[]): Attachment[] => {
  const byId = new Map(images.map((i) => [i.messageId, i]));
  return ids.flatMap((id) => {
    const img = byId.get(id);
    return img === undefined
      ? []
      : [{ filename: `telegram-${String(id)}.${EXT[img.mediaType]}`, contentType: img.mediaType, data: img.data }];
  });
};

export async function runTriage(deps: RunDeps, req: RunRequest): Promise<RunResult> {
  const messages = selectContext(deps.store, req.chatId, req.triggerId, req.replyTo, req.contextMessages);

  const images = await loadImages(deps, req.chatId, messages, req.maxImages);

  const result = await deps.triage({
    messages,
    images: images.map(({ messageId, mediaType, base64 }) => ({ messageId, mediaType, base64 })),
    note: req.note,
    triggeredBy: req.triggeredBy,
    maxTickets: req.maxTickets,
  });

  const filed: Filed[] = [];
  for (const ticket of result.tickets) {
    const key = await deps.jira.createIssue({
      type: ticket.type,
      summary: ticket.summary,
      description: ticket.description,
    });
    // Only the images Claude tied to this ticket: the window holds other
    // people's screenshots too (owner, 2026-11-16: «adds unrelated screenshots»).
    const files = attachmentsFor(images, ticket.image_message_ids);
    let attachOk = true;
    try {
      await deps.jira.attach(key, files);
    } catch (err) {
      attachOk = false;
      deps.log('attach_failed', { chatId: req.chatId, key, files: files.length, error: errorName(err) });
    }
    filed.push({ key, url: deps.jira.issueUrl(key), summary: ticket.summary, attached: files.length, attachOk });
    deps.log('issue_created', { chatId: req.chatId, triggerId: req.triggerId, key, attached: attachOk ? files.length : 0 });
  }

  return { chatReply: result.chat_reply, filed };
}

export interface UpdateRequest {
  chatId: number;
  /** The bot's ticket message and the reply to it. */
  botMessageId: number;
  replyId: number;
  keys: string[];
  maxImages: number;
}

/**
 * A reply to the bot's ticket message: the reply (with the author's messages
 * just before it) goes to Claude beside the tickets' current text, and each
 * ticket the reply adds to is rewritten and gets the reply's screenshots.
 */
export async function runUpdate(deps: RunDeps, req: UpdateRequest): Promise<RunResult> {
  const { update, jira } = deps;
  if (update === undefined || jira.getIssue === undefined || jira.updateIssue === undefined) {
    throw new Error('update not wired');
  }
  const reply = deps.store.get(req.chatId, req.replyId);
  if (reply === null) throw new Error('reply not recorded');
  // Only what came after the bot's message: earlier screenshots are already on the ticket.
  const from = Math.max(authorLeadIn(deps.store, req.chatId, reply), req.botMessageId + 1);
  const messages = deps.store.range(req.chatId, from, req.replyId, 20);
  const images = await loadImages(deps, req.chatId, messages, req.maxImages);
  const tickets = await Promise.all(req.keys.map(async (key) => ({ key, ...(await jira.getIssue!(key)) })));

  const result = await update({
    tickets,
    messages,
    images: images.map(({ messageId, mediaType, base64 }) => ({ messageId, mediaType, base64 })),
  });

  const filed: Filed[] = [];
  for (const u of result.updates) {
    await jira.updateIssue(u.key, { summary: u.summary, description: u.description });
    const files = attachmentsFor(images, u.image_message_ids);
    let attachOk = true;
    try {
      await jira.attach(u.key, files);
    } catch (err) {
      attachOk = false;
      deps.log('attach_failed', { chatId: req.chatId, key: u.key, files: files.length, error: errorName(err) });
    }
    filed.push({ key: u.key, url: jira.issueUrl(u.key), summary: u.summary, attached: files.length, attachOk });
    deps.log('issue_updated', { chatId: req.chatId, replyId: req.replyId, key: u.key, attached: attachOk ? files.length : 0 });
  }
  return { chatReply: result.chat_reply, filed };
}

export function errorName(err: unknown): string {
  if (err instanceof Error) {
    const status = (err as { status?: unknown }).status;
    return typeof status === 'number' ? `${err.name}:${String(status)}` : err.name;
  }
  return 'unknown';
}

/** The bot's answer in the chat. HTML parse mode; every interpolated value is escaped. */
export function formatReply(result: RunResult): string {
  const lines = [escapeHtml(result.chatReply)];
  for (const f of result.filed) {
    const images = f.attached === 0 ? '' : f.attachOk ? ` 📎${String(f.attached)}` : ' (⚠️ фото не прикріпились)';
    lines.push(`• <a href="${escapeHtml(f.url)}">${escapeHtml(f.key)}</a> ${escapeHtml(f.summary)}${images}`);
  }
  return lines.join('\n');
}

/** The same reply as plain text — what the bot records of its own message. */
export function plainReply(result: RunResult): string {
  return [result.chatReply, ...result.filed.map((f) => `• ${f.key} ${f.summary}`)].join('\n');
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
