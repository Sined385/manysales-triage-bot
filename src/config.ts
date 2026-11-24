import { z } from 'zod';

const csvIds = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x !== '')
      .map(Number),
  )
  .refine((ids) => ids.every((n) => Number.isSafeInteger(n)), 'must be comma-separated integer ids');

const csv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((s) => s.split(',').map((x) => x.trim()).filter((x) => x !== ''));

/** Words the announcement post-check rejects besides ticket keys, PR numbers, branches and repo links. */
// Whole words, case-insensitive; a trailing `*` matches as a prefix. The Cyrillic ones
// are the usual Ukrainian slang for the default language `uk` («на проді», «на стейджингу»).
export const DEFAULT_BLOCKLIST =
  'staging,stg,prod,dev,eval,hotfix,refactor,merge,pull request,CI,QA,прод,проді,проду,прода,продом,стейдж*,стейджинг*,стг';

const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  CLAUDE_MODEL: z.string().default('claude-opus-5-5'),
  JIRA_BASE_URL: z.url(),
  JIRA_EMAIL: z.string().min(1),
  JIRA_API_TOKEN: z.string().min(1),
  JIRA_PROJECT_KEY: z.string().min(1),
  // An issue type's id (all digits) or its name, as the project shows it.
  JIRA_BUG_TYPE: z.string().min(1).default('Bug'),
  JIRA_TASK_TYPE: z.string().min(1).default('Task'),
  JIRA_LABEL: z.string().default('from-telegram'),
  // Optional: the sprint a new ticket joins (Jira Cloud's sprint field is usually customfield_10020).
  JIRA_SPRINT_ID: z.coerce.number().int().positive().optional(),
  JIRA_SPRINT_FIELD: z.string().default('customfield_10020'),
  // What the team works on, told to Claude so tickets use the right words. Optional.
  PRODUCT_CONTEXT: z.string().default(''),
  // IANA zone the transcript times are written in.
  TIME_ZONE: z
    .string()
    .default('UTC')
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'must be an IANA time zone'),
  // Command names that trigger a run (`/ticket`), comma-separated, Latin letters, digits and _ only.
  TRIGGER_COMMANDS: z
    .string()
    .default('ticket')
    .transform((s) => s.split(',').map((x) => x.trim().toLowerCase()).filter((x) => x !== ''))
    .refine((cmds) => cmds.length > 0 && cmds.every((c) => /^[a-z0-9_]{1,32}$/.test(c)), 'must be command names'),
  // Plain-text phrases that also trigger a run anywhere in a message, comma-separated. Optional.
  TRIGGER_PHRASES: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((x) => x.trim()).filter((x) => x !== '')),
  // Only these chats are recorded and may trigger; empty = the bot does nothing.
  ALLOWED_CHAT_IDS: csvIds,
  // Only these users may trigger; empty = any member of an allowed chat.
  ALLOWED_USER_IDS: csvIds,
  DB_PATH: z.string().default('./data/bot.db'),
  CONTEXT_MESSAGES: z.coerce.number().int().min(1).max(200).default(50),
  MAX_IMAGES: z.coerce.number().int().min(0).max(20).default(10),
  MAX_TICKETS: z.coerce.number().int().min(1).max(5).default(3),
  DAILY_RUN_LIMIT: z.coerce.number().int().min(1).default(30),

  // --- Release announcements (optional feature; off unless the required ones below are set). ---
  // GitHub repos whose merges into ANNOUNCE_PROD_BRANCH are releases, `owner/name`, comma-separated.
  ANNOUNCE_REPOS: csv('').refine(
    (repos) => repos.every((r) => /^[\w.-]+\/[\w.-]+$/.test(r)),
    'must be comma-separated owner/name',
  ),
  // Fine-grained token with Pull requests: read and Metadata: read on those repos.
  GITHUB_TOKEN: z
    .string()
    .default('')
    .transform((s) => s.trim()),
  // The public channel posts go to: `-100…` or `@username`. The bot must be its admin with «Post messages».
  ANNOUNCE_CHANNEL_ID: z
    .string()
    .default('')
    .refine((s) => s === '' || /^(-?\d+|@[A-Za-z0-9_]{5,32})$/.test(s), 'must be a chat id or @username'),
  // The team group drafts are posted to; must be one of ALLOWED_CHAT_IDS.
  ANNOUNCE_TEAM_CHAT_ID: z
    .string()
    .default('')
    .refine((s) => s.trim() === '' || (/^-?\d+$/.test(s.trim()) && Number.isSafeInteger(Number(s.trim()))), 'must be an integer chat id')
    .transform((s) => (s.trim() === '' ? undefined : Number(s.trim()))),
  // Who may publish, change or cancel a draft; empty = ALLOWED_USER_IDS.
  ANNOUNCE_APPROVER_IDS: csvIds,
  ANNOUNCE_PROD_BRANCH: z.string().min(1).default('main'),
  ANNOUNCE_QUIET_MINUTES: z.coerce.number().int().min(1).max(180).default(10),
  ANNOUNCE_POLL_MINUTES: z.coerce.number().int().min(1).max(60).default(3),
  // The language the post is written in, as Claude should read it (`uk`, `English`, …).
  ANNOUNCE_LANGUAGE: z.string().min(1).default('uk'),
  // Voice and tone of the post: how to address readers, what to call things. Optional.
  ANNOUNCE_STYLE: z.string().default(''),
  ANNOUNCE_MAX_REVISIONS: z.coerce.number().int().min(1).max(20).default(5),
  ANNOUNCE_DAILY_LIMIT: z.coerce.number().int().min(1).default(10),
  ANNOUNCE_MAX_LINKED_PRS: z.coerce.number().int().min(0).max(100).default(30),
  ANNOUNCE_MAX_ISSUES: z.coerce.number().int().min(0).max(100).default(30),
  ANNOUNCE_BLOCKLIST: csv(DEFAULT_BLOCKLIST),
  // Names the ticket-key check would reject but the post may use («GPT-5»), comma-separated.
  ANNOUNCE_ALLOW_TERMS: csv(''),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    // Names only — never the values, some are secrets.
    const bad = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`invalid environment: ${bad}`);
  }
  return parsed.data;
}

export interface AnnounceSettings {
  repos: string[];
  githubToken: string;
  /** A numeric chat id, or `@username`. */
  channelId: number | string;
  teamChatId: number;
  approverIds: number[];
  prodBranch: string;
  quietMinutes: number;
  pollMinutes: number;
  language: string;
  style: string;
  maxRevisions: number;
  dailyLimit: number;
  maxLinkedPrs: number;
  maxIssues: number;
  blocklist: string[];
  allowTerms: string[];
  projectKey: string;
  jiraBaseUrl: string;
  timeZone: string;
  productContext: string;
}

/**
 * The announcement settings, or the names of what is missing. A missing
 * setting turns the feature off; triage keeps working.
 */
export function announceSettings(cfg: Config): AnnounceSettings | { disabled: true; missing: string[] } {
  const missing: string[] = [];
  if (cfg.ANNOUNCE_REPOS.length === 0) missing.push('ANNOUNCE_REPOS');
  if (cfg.GITHUB_TOKEN === '') missing.push('GITHUB_TOKEN');
  if (cfg.ANNOUNCE_CHANNEL_ID === '') missing.push('ANNOUNCE_CHANNEL_ID');
  if (cfg.ANNOUNCE_TEAM_CHAT_ID === undefined) missing.push('ANNOUNCE_TEAM_CHAT_ID');
  // Nothing may reach the channel without a press by a named user.
  const approverIds = cfg.ANNOUNCE_APPROVER_IDS.length > 0 ? cfg.ANNOUNCE_APPROVER_IDS : cfg.ALLOWED_USER_IDS;
  if (approverIds.length === 0) missing.push('ANNOUNCE_APPROVER_IDS|ALLOWED_USER_IDS');
  // A chat that is not allowed is not recorded, so a reply to a draft there would never be seen.
  if (cfg.ANNOUNCE_TEAM_CHAT_ID !== undefined && !cfg.ALLOWED_CHAT_IDS.includes(cfg.ANNOUNCE_TEAM_CHAT_ID)) {
    missing.push('ANNOUNCE_TEAM_CHAT_ID (not in ALLOWED_CHAT_IDS)');
  }
  if (missing.length > 0 || cfg.ANNOUNCE_TEAM_CHAT_ID === undefined) return { disabled: true, missing };
  const channel = cfg.ANNOUNCE_CHANNEL_ID;
  return {
    repos: cfg.ANNOUNCE_REPOS,
    githubToken: cfg.GITHUB_TOKEN,
    channelId: /^-?\d+$/.test(channel) ? Number(channel) : channel,
    teamChatId: cfg.ANNOUNCE_TEAM_CHAT_ID,
    approverIds,
    prodBranch: cfg.ANNOUNCE_PROD_BRANCH,
    quietMinutes: cfg.ANNOUNCE_QUIET_MINUTES,
    pollMinutes: cfg.ANNOUNCE_POLL_MINUTES,
    language: cfg.ANNOUNCE_LANGUAGE,
    style: cfg.ANNOUNCE_STYLE,
    maxRevisions: cfg.ANNOUNCE_MAX_REVISIONS,
    dailyLimit: cfg.ANNOUNCE_DAILY_LIMIT,
    maxLinkedPrs: cfg.ANNOUNCE_MAX_LINKED_PRS,
    maxIssues: cfg.ANNOUNCE_MAX_ISSUES,
    blocklist: cfg.ANNOUNCE_BLOCKLIST,
    allowTerms: cfg.ANNOUNCE_ALLOW_TERMS,
    projectKey: cfg.JIRA_PROJECT_KEY,
    jiraBaseUrl: cfg.JIRA_BASE_URL,
    timeZone: cfg.TIME_ZONE,
    productContext: cfg.PRODUCT_CONTEXT,
  };
}
