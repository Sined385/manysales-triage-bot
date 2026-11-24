import Anthropic from '@anthropic-ai/sdk';
import { Bot, type Context } from 'grammy';
import { Announcer, draftAnnouncement, routeMessage } from './announce.js';
import { announceSettings, loadConfig } from './config.js';
import { triggerNote, type Triggers } from './context.js';
import { GitHub } from './github.js';
import { Jira } from './jira.js';
import { errorName, formatReply, plainReply, runTriage, runUpdate, type RunDeps, type RunResult } from './run.js';
import { Store } from './store.js';
import { triage, updateTickets, type Prompting } from './triage.js';

const cfg = loadConfig();
const store = new Store(cfg.DB_PATH);
const anthropic = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY });
const jira = new Jira({
  baseUrl: cfg.JIRA_BASE_URL,
  email: cfg.JIRA_EMAIL,
  apiToken: cfg.JIRA_API_TOKEN,
  projectKey: cfg.JIRA_PROJECT_KEY,
  bugType: cfg.JIRA_BUG_TYPE,
  taskType: cfg.JIRA_TASK_TYPE,
  label: cfg.JIRA_LABEL,
  sprintId: cfg.JIRA_SPRINT_ID,
  sprintField: cfg.JIRA_SPRINT_FIELD,
});
const triggers: Triggers = { commands: cfg.TRIGGER_COMMANDS, phrases: cfg.TRIGGER_PHRASES };
const prompting: Prompting = { productContext: cfg.PRODUCT_CONTEXT, timeZone: cfg.TIME_ZONE };
const bot = new Bot(cfg.TELEGRAM_BOT_TOKEN);

/** Logs carry ids and counts only — never message text, names or images. */
function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}

const allowedChat = (id: number): boolean => cfg.ALLOWED_CHAT_IDS.includes(id);
const allowedUser = (id: number | undefined): boolean =>
  cfg.ALLOWED_USER_IDS.length === 0 || (id !== undefined && cfg.ALLOWED_USER_IDS.includes(id));

function authorOf(ctx: Context): string {
  const from = ctx.message?.from ?? ctx.callbackQuery?.from;
  if (from === undefined) return 'unknown';
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || String(from.id);
}

async function download(fileId: string): Promise<Uint8Array> {
  const file = await bot.api.getFile(fileId);
  if (file.file_path === undefined) throw new Error('no file_path');
  const res = await fetch(`https://api.telegram.org/file/bot${cfg.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
  if (!res.ok) throw new Error(`telegram file ${String(res.status)}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Which chat runs are in flight — a second trigger while one runs is ignored. */
const running = new Set<number>();

// Release announcements: on only when every required setting is there.
const settings = announceSettings(cfg);
const announcer =
  'disabled' in settings
    ? null
    : new Announcer({
        store,
        github: new GitHub(settings.githubToken),
        jira,
        draft: (input) =>
          draftAnnouncement(
            anthropic,
            cfg.CLAUDE_MODEL,
            { productContext: settings.productContext, style: settings.style, language: settings.language },
            input,
          ),
        tg: {
          sendMessage: (chatId, text, other) =>
            bot.api.sendMessage(chatId, text, {
              ...(other?.reply_markup === undefined ? {} : { reply_markup: other.reply_markup }),
              ...(other?.reply_to === undefined ? {} : { reply_parameters: { message_id: other.reply_to } }),
              link_preview_options: { is_disabled: true },
            }),
          editMessageText: (chatId, messageId, text, other) =>
            bot.api.editMessageText(chatId, messageId, text, {
              reply_markup: other.reply_markup,
              link_preview_options: { is_disabled: true },
            }),
          answerCallbackQuery: (queryId, other) => bot.api.answerCallbackQuery(queryId, other),
        },
        log,
        now: () => new Date(),
        settings,
      });

bot.on('message', async (ctx) => {
  const msg = ctx.message;
  const chatId = msg.chat.id;
  if (!allowedChat(chatId)) {
    // Logged so the owner can read the group id to allow it; nothing else happens.
    if (msg.chat.type !== 'private') log('chat_not_allowed', { chatId });
    return;
  }

  const photo = msg.photo?.at(-1);
  const imageDoc = msg.document?.mime_type?.startsWith('image/') ? msg.document : undefined;
  const text = msg.text ?? msg.caption ?? '';
  store.save({
    chatId,
    messageId: msg.message_id,
    userId: msg.from?.id ?? null,
    author: authorOf(ctx),
    date: msg.date,
    text,
    replyTo: msg.reply_to_message?.message_id ?? null,
    imageFileId: photo?.file_id ?? imageDoc?.file_id ?? null,
  });

  const repliedTo = msg.reply_to_message;
  // A reply to an announcement draft belongs to the announcer; a reply to the
  // bot's ticket message updates those tickets; a trigger files new ones.
  const route = routeMessage({
    store,
    announcing: announcer !== null,
    chatId,
    text,
    repliedTo: repliedTo === undefined ? undefined : { messageId: repliedTo.message_id, fromId: repliedTo.from?.id },
    me: { id: ctx.me.id, username: ctx.me.username },
    triggers,
    projectKey: cfg.JIRA_PROJECT_KEY,
    userAllowed: allowedUser(msg.from?.id),
  });
  if (route.kind === 'draft') {
    void announcer?.onReply(route.release, { messageId: msg.message_id, text, userId: msg.from?.id });
    return;
  }
  if (route.kind === 'none') return;
  const keys = route.kind === 'update' ? route.keys : [];
  if (running.has(chatId)) return;
  const day = new Date().toISOString().slice(0, 10);
  if (!store.takeRun(day, cfg.DAILY_RUN_LIMIT)) {
    log('daily_limit', { chatId, triggerId: msg.message_id });
    await ctx.reply('Ліміт на сьогодні вичерпано.', { reply_parameters: { message_id: msg.message_id } });
    return;
  }

  running.add(chatId);
  // Not awaited: grammy handles updates one by one, and the chat must keep
  // being recorded while Claude works.
  const work =
    keys.length > 0
      ? () =>
          runUpdate(deps, {
            chatId,
            botMessageId: repliedTo!.message_id,
            replyId: msg.message_id,
            keys,
            maxImages: cfg.MAX_IMAGES,
          })
      : () =>
          runTriage(deps, {
            chatId,
            triggerId: msg.message_id,
            replyTo: repliedTo?.message_id ?? null,
            note: triggerNote(text, triggers, ctx.me.username),
            triggeredBy: authorOf(ctx),
            contextMessages: cfg.CONTEXT_MESSAGES,
            maxImages: cfg.MAX_IMAGES,
            maxTickets: cfg.MAX_TICKETS,
          });
  void handleRun(ctx, keys.length > 0 ? 'update' : 'triage', work, keys).finally(() => running.delete(chatId));
});

const deps: RunDeps = {
  store,
  download,
  triage: (input) => triage(anthropic, cfg.CLAUDE_MODEL, prompting, input),
  update: (input) => updateTickets(anthropic, cfg.CLAUDE_MODEL, prompting, input),
  jira,
  log,
};

async function handleRun(
  ctx: Context & { message: NonNullable<Context['message']> },
  kind: 'triage' | 'update',
  work: () => Promise<RunResult>,
  /** For an update: the tickets the replied-to message listed; its answer lists them too. */
  carriedKeys: string[] = [],
): Promise<void> {
  const msg = ctx.message;
  const chatId = msg.chat.id;
  log('run_started', { chatId, triggerId: msg.message_id, kind });
  await ctx.api.sendChatAction(chatId, 'typing').catch(() => undefined);
  try {
    const result = await work();
    const sent = await ctx.reply(formatReply(result), {
      parse_mode: 'HTML',
      reply_parameters: { message_id: msg.message_id },
      link_preview_options: { is_disabled: true },
    });
    // Telegram never delivers a bot its own messages, so record the reply
    // here: the next run then sees which tickets this chat already has, and a
    // reply to this message updates them.
    store.save({
      chatId,
      messageId: sent.message_id,
      userId: ctx.me.id,
      author: `${ctx.me.first_name} (bot)`,
      date: sent.date,
      text: plainReply(result),
      replyTo: msg.message_id,
      imageFileId: null,
    });
    // An update's answer stands for the same tickets, so a reply to it updates them again.
    store.saveFiled(chatId, sent.message_id, [...new Set([...carriedKeys, ...result.filed.map((f) => f.key)])]);
    log('run_done', { chatId, triggerId: msg.message_id, kind, tickets: result.filed.length });
  } catch (err) {
    log('run_failed', { chatId, triggerId: msg.message_id, kind, error: errorName(err) });
    const text = kind === 'update' ? 'Не вийшло оновити тікет — подивіться логи бота.' : 'Не вийшло створити тікет — подивіться логи бота.';
    await ctx.reply(text, { reply_parameters: { message_id: msg.message_id } }).catch(() => undefined);
  }
}

bot.on('callback_query:data', (ctx) => {
  if (announcer === null) return;
  // Not awaited: a publish waits on Telegram, and the group must keep being recorded meanwhile.
  void announcer.onCallback({
    id: ctx.callbackQuery.id,
    data: ctx.callbackQuery.data,
    chatId: ctx.callbackQuery.message?.chat.id,
    user: { id: ctx.from.id, name: authorOf(ctx) },
  });
});

bot.catch((err) => log('bot_error', { error: errorName(err.error) }));

let pollTimer: NodeJS.Timeout | undefined;
const stop = (): void => {
  clearTimeout(pollTimer);
  void bot.stop();
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);

await bot.init();
// False means BotFather privacy mode is on: the bot gets only commands and
// mentions, records almost nothing, and the window is empty.
const readsAll = bot.botInfo.can_read_all_group_messages;
log('starting', { chats: cfg.ALLOWED_CHAT_IDS.length, model: cfg.CLAUDE_MODEL, readsAllGroupMessages: readsAll });
if (!readsAll) log('privacy_mode_on', { fix: 'BotFather /setprivacy Disable, then remove and re-add the bot' });
if ('disabled' in settings) {
  log('announce_disabled', { missing: settings.missing });
} else if (announcer !== null) {
  announcer.startup();
  log('announce_started', { repos: settings.repos.length, pollMinutes: settings.pollMinutes });
  // A chain, not an interval: a slow tick delays the next one instead of overlapping it.
  const loop = async (): Promise<void> => {
    await announcer.tick();
    pollTimer = setTimeout(() => void loop(), settings.pollMinutes * 60_000);
  };
  void loop();
}
// Telegram remembers allowed_updates between calls, so callback_query is always asked for.
await bot.start({ allowed_updates: ['message', 'callback_query'], drop_pending_updates: false });
