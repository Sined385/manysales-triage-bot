# Release announcements (text-only) — spec

Date: 2026-11-24. Branch: `feature/release-announcements`.

## Request
Announce production releases in a public Telegram channel:
- Poll GitHub for PRs merged into the configured production branch of the configured repos, and group merges that land within a quiet window into one release.
- One structured-output Claude call writes a client-facing post. It uses the configured language and voice (`ANNOUNCE_STYLE`) and draws on the promotion PR bodies, the PRs they list, and the Jira issues they name. It leaves out internal work and never names tickets, PRs, branches or staging.
- If nothing client-visible changed, the bot says so in the team chat and proposes no post.
- The draft goes to a team chat with the buttons «Опублікувати», «Змінити» and «Скасувати». Only approvers can press them (`ANNOUNCE_APPROVER_IDS`, or else `ALLOWED_USER_IDS`).
- «Змінити» is followed by a reply with instructions, which regenerates the draft, up to a cap on revisions.
- «Опублікувати» posts exactly once per release, and the draft is edited to say who published it and when.
- Nothing reaches the channel without an explicit press by an approver.
- If a required setting is missing, the feature turns itself off.

Out of scope here (designed, planned as a follow-up PR): screenshots and illustration cards in the post.

## Design
- Polling, no webhook endpoint.
  - The SQLite table `gh_cursor` holds a `since` value and the baseline from the first start, per repo.
  - On the first start the cursor is set to now, so no historical PR is announced.
  - Each fetch overlaps the last one by 2× the poll interval. `release_prs (repo, number)` removes duplicates.
  - The cursor is written after the PR rows, so a restart loses nothing.
- Release states, kept in `releases.state` and changed by one atomic `UPDATE … WHERE state IN (…)`:
  - `collecting → drafting → drafted ⇄ editing/revising → publishing → published`
  - `cancelled` and `empty` are also final states.
- `checkPost` is the post-check in code. It rejects:
  - ticket keys: the project key, the generic form, and the uppercase «KEY 12» form;
  - PR numbers;
  - branch words;
  - repository and Jira links;
  - blocklist words (whole word or `prefix*`);
  - posts over 3800 chars.

  `ANNOUNCE_ALLOW_TERMS` exempts names such as `GPT-5` from the generic-key rule. A flagged draft gets one automatic retry. If it is still flagged, the Publish button is withheld.
- Publish is idempotent:
  - The `publishing` state is set before the send.
  - If Telegram refuses (GrammyError), the release goes back to `drafted`.
  - If there is no answer (HttpError, or a crash), it stays in `publishing` and is never sent again. The team checks the channel by hand.
- A press is accepted only on the current draft message. Buttons on stale duplicate drafts are disarmed.
- A revision edit with no answer is saved as flagged, so Publish is withheld. That revision does not count against the cap, and a reply can always repair it.
- The team message always contains the whole post: the header gives way, never the post. The team note is capped at 300 chars.
- Logs carry ids and counts only. PR, Jira and approver text is passed to Claude as data.
- `allowed_updates` now includes `callback_query`.

## Implemented
- `src/github.ts`: new read-only REST client with paging and a stop rule.
- `src/announce.ts`: new. Sources, prompt, schema, `checkPost`, texts, keyboard, routing, and `Announcer`.
- `src/store.ts`: new tables and the atomic `setState`.
- `src/config.ts`: the `ANNOUNCE_*` variables and `GITHUB_TOKEN`, plus `announceSettings()`.
- `src/index.ts`: wiring, the callback handler, draft-reply routing, and the poll loop with a stop flag.
- `src/triage.ts`: exports `ask` and `productBlock`.
- `src/announce-sample.ts`: prints the exact prompt built from a fixture. It makes no network call.
- `src/__fixtures__/sample-release.json`: a neutral fixture.
- `src/announce.test.ts`, `README.md`, `package.json`.

## Deviations from the plan
- The draft-reply route runs before the allowed-user check, so approvers who are not in `ALLOWED_USER_IDS` can revise. A reply to a draft is never a ticket trigger.
- A persisted `revising` state replaces the in-memory in-flight set.
- `store.hasPr` stops an old PR seen again in the overlap from opening an empty release.
- Revisions also get the automatic post-check retry.

## QA history
- Round 1: FAIL.
  - Blocking: a long team note cut the team copy of the post; a press was not tied to its draft message; an unanswered revision edit could drift the text.
  - Non-blocking: a pre-baseline PR could be announced; shutdown kept polling; four untested branches; gaps in the post-check; unanswered presses when the feature is off; config validation.
  - All fixed.
  - Localisation of the bot's own texts (uk only) is deferred to the owner.
- Round 2: FAIL.
  - Blocking: an unanswered edit on the last allowed revision stranded the release.
  - Non-blocking: a refused edit counted as a revision; the «Key 12» rule caught ordinary words; an untested catch; duplicate findings.
  - All fixed in 94afec4, each with a test that kills its mutant.
  - The round cap is 2, so this last commit has not had a QA round.

## Verification at the final head
- `npm run typecheck`: clean.
- `npm test`: 206 passed.
- `npm run build`: OK.
- Mutants: round 1 QA killed 24/30; round 2 QA killed 20/21; the developer killed 11/11 on the final fixes.
