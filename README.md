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

Release announcements (optional, off until its required variables are set — see below):

| Variable | Required | Default |
|---|---|---|
| `ANNOUNCE_REPOS` | yes | — comma-separated `owner/name` |
| `GITHUB_TOKEN` | yes | — fine-grained token, *Pull requests: read* and *Metadata: read* on those repos |
| `ANNOUNCE_CHANNEL_ID` | yes | — the public channel: `-100…` or `@username` |
| `ANNOUNCE_TEAM_CHAT_ID` | yes | — the group drafts go to; must be in `ALLOWED_CHAT_IDS` |
| `ANNOUNCE_APPROVER_IDS` | no | `ALLOWED_USER_IDS` — who may publish, change or cancel; one of the two must be set |
| `ANNOUNCE_PROD_BRANCH` | no | `main` — merges into it are releases |
| `ANNOUNCE_QUIET_MINUTES` / `ANNOUNCE_POLL_MINUTES` | no | 10 / 3 |
| `ANNOUNCE_LANGUAGE` | no | `uk` — the language the post is written in |
| `ANNOUNCE_STYLE` | no | none — the voice: how to address readers, what to call things |
| `ANNOUNCE_MAX_REVISIONS` / `ANNOUNCE_DAILY_LIMIT` | no | 5 / 10 (Claude calls a day for drafts and revisions) |
| `ANNOUNCE_MAX_LINKED_PRS` / `ANNOUNCE_MAX_ISSUES` | no | 30 / 30 |
| `ANNOUNCE_BLOCKLIST` | no | `staging,stg,prod,dev,eval,hotfix,refactor,merge,pull request,CI,QA` — words a post may not contain |

Cost: one call per trigger — ~50 short messages plus up to 10 screenshots is roughly 15–25k input tokens, about $0.08–0.15 on Opus 5.5.

## Release announcements
The bot can also write the post that tells your users what shipped.

1. **Detect.** Every `ANNOUNCE_POLL_MINUTES` it asks GitHub for PRs merged into `ANNOUNCE_PROD_BRANCH` of each repo in `ANNOUNCE_REPOS`. Merges that land within `ANNOUNCE_QUIET_MINUTES` of each other are one release; a merge after the draft is out starts the next one. On the very first poll it only notes the time — nothing merged before is announced.
2. **Draft.** Once the release has been quiet for the window, one Claude call reads the merged PRs, the same-repo PRs their bodies list (`#123`), and the Jira tickets they name, and writes a post for users in `ANNOUNCE_LANGUAGE` and the voice of `ANNOUNCE_STYLE`. Internal-only work is left out. If nothing is visible to users, the bot says so in the team group and proposes no post.
3. **Check.** Before the team sees it, code rejects a post that names ticket keys, PR numbers, branches, repository or Jira links, or a word from `ANNOUNCE_BLOCKLIST`, and asks Claude once more. A post still rejected is shown with the reason and can't be published until it is changed.
4. **Approve.** The draft appears in `ANNOUNCE_TEAM_CHAT_ID` with *Опублікувати* / *Змінити* / *Скасувати*. Only approvers can press them. To change it, reply to the draft with what you want; the bot rewrites the same message (up to `ANNOUNCE_MAX_REVISIONS` times).
5. **Publish.** *Опублікувати* posts the text, exactly as shown, to `ANNOUNCE_CHANNEL_ID` once, and marks the draft with who published it and when. If Telegram refuses (say, the bot isn't an admin), the draft stays and can be published again; if the result is unknown (no answer), the bot never retries — check the channel.

Nothing reaches the channel without a press by an approver. Setup: add the bot to the channel as an administrator with *Post messages*; create the GitHub token; set the variables. A missing required variable turns the feature off (`announce_disabled {missing}` in the logs) and the triage bot keeps working.

To see the exact prompt for a saved release without calling Claude:
```
npm run build
ANNOUNCE_LANGUAGE=uk node dist/announce-sample.js path/to/release.json
```
The file holds `{ promotions, linked, issues }` (see `src/__fixtures__/sample-release.json`); a `draft.txt` beside it is run through the post-check.

## Develop
```
npm ci
npm test        # Node ≥ 22.13 (node:sqlite)
npm run build
```

## License
MIT
