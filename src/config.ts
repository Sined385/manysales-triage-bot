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
