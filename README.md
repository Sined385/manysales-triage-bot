# manysales-triage-bot

Telegram team group → Claude → Jira. The bot records every message (and photo) in the allowed group — the Bot API keeps no history — and on a trigger reads the recent chat, looks at the screenshots, and files Jira tickets with the screenshots attached. It answers in the chat with the links. Reply to that answer with more details and it updates the tickets.

Built for the [manysales](https://manysales.pro) team chat; nothing in it is specific to manysales — the product description, Jira project and trigger words are all settings.

## Trigger
- `/ticket` (or any command in `TRIGGER_COMMANDS`), optionally with a note: `/ticket login fails on Android`.
- a mention of the bot, or any phrase in `TRIGGER_PHRASES` anywhere in a message (useful for non-Latin words, which Telegram doesn't allow in command names).
- Sent **as a reply**, the window starts at the replied-to message; otherwise it is the last `CONTEXT_MESSAGES` (50) messages.
- **Replying to the bot's own ticket message** updates those tickets with whatever the reply adds (constraints, details, screenshots).

## What a run does
1. Takes the window, downloads its newest `MAX_IMAGES` (10) images (≤5 MB each, JPEG/PNG/GIF/WebP).
2. One Claude call (`claude-opus-5-5`, structured output, server-side refusal fallback on) → up to `MAX_TICKETS` (3) tickets: bug/task, summary, description, which images belong.
3. Creates each issue (label `from-telegram`, optional sprint), attaches only the images Claude tied to that ticket.
4. Replies in the chat with the links.

Tickets are written in the language the chat uses. The bot's own short chat replies are in Ukrainian.

Guards: only `ALLOWED_CHAT_IDS` are recorded; only `ALLOWED_USER_IDS` (if set) may trigger; one run per chat at a time; `DAILY_RUN_LIMIT` runs a day; chat text is data to Claude, not instructions; logs carry ids and counts only.

## Setup
1. **BotFather:** create the bot, then `/setprivacy` → *Disable* (otherwise it sees only commands and can't record the chat). Add it to the group. Optionally `/setcommands`: `ticket - file a ticket from the recent messages`.
2. **Jira API token:** id.atlassian.com → Security → API tokens, for a user that can create issues in your project.
3. **Host it** (any Node ≥ 22.13 host; a `railway.json` is included): a persistent volume for the SQLite file, the variables below, **one replica only** (Telegram long polling).
4. Start it, write anything in the group, read `chat_not_allowed {chatId}` in the logs, put that id in `ALLOWED_CHAT_IDS`, restart.

| Variable | Required | Default |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | |
| `ANTHROPIC_API_KEY` | yes | |
| `JIRA_BASE_URL` | yes | e.g. `https://your-team.atlassian.net` |
| `JIRA_PROJECT_KEY` | yes | e.g. `ABC` |
| `JIRA_EMAIL`, `JIRA_API_TOKEN` | yes | |
| `ALLOWED_CHAT_IDS` | yes (comma-separated) | empty = bot does nothing |
| `ALLOWED_USER_IDS` | no | any member of an allowed chat |
| `PRODUCT_CONTEXT` | no | none — a paragraph about what the team builds, so tickets use the right words |
| `TIME_ZONE` | no | `UTC` (IANA name, e.g. `Europe/Kyiv`) |
| `TRIGGER_COMMANDS` | no | `ticket` (comma-separated) |
| `TRIGGER_PHRASES` | no | none (comma-separated) |
| `JIRA_BUG_TYPE` / `JIRA_TASK_TYPE` | no | `Bug` / `Task` (a name, or an id like `10004`) |
| `JIRA_LABEL` | no | `from-telegram` |
| `JIRA_SPRINT_ID` / `JIRA_SPRINT_FIELD` | no | none / `customfield_10020` |
| `DB_PATH` | point it at the volume | `./data/bot.db` |
| `CLAUDE_MODEL` | no | `claude-opus-5-5` |
| `CONTEXT_MESSAGES` / `MAX_IMAGES` / `MAX_TICKETS` / `DAILY_RUN_LIMIT` | no | 50 / 10 / 3 / 30 |

Cost: one call per trigger — ~50 short messages plus up to 10 screenshots is roughly 15–25k input tokens, about $0.08–0.15 on Opus 5.5.

## Develop
```
npm ci
npm test        # Node ≥ 22.13 (node:sqlite)
npm run build
```

## License
MIT
