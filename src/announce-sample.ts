/**
 * Prints what one announcement call would send — the system prompt and the
 * user content — for a saved release, without calling anyone:
 *
 *   node dist/announce-sample.js <dir | release.json>
 *
 * The file holds `{ promotions: Pull[], linked: Pull[], issues: {key, summary, description}[] }`.
 * A `draft.txt` beside it is run through the post-check. PRODUCT_CONTEXT,
 * ANNOUNCE_STYLE, ANNOUNCE_LANGUAGE, JIRA_PROJECT_KEY, JIRA_BASE_URL,
 * ANNOUNCE_PROD_BRANCH, ANNOUNCE_BLOCKLIST and ANNOUNCE_ALLOW_TERMS are read from the environment.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { announcePrompt, buildAnnounceContent, checkPost, limitSources, type AnnounceSources } from './announce.js';
import { DEFAULT_BLOCKLIST } from './config.js';

export function renderSample(path: string, env: NodeJS.ProcessEnv): string {
  const file = statSync(path).isDirectory() ? join(path, 'release.json') : path;
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<AnnounceSources>;
  const { sources } = limitSources({ promotions: raw.promotions ?? [], linked: raw.linked ?? [], issues: raw.issues ?? [] });
  const language = env.ANNOUNCE_LANGUAGE ?? 'uk';
  const system = announcePrompt({ productContext: env.PRODUCT_CONTEXT ?? '', style: env.ANNOUNCE_STYLE ?? '', language });
  const content = buildAnnounceContent({ ...sources, language })
    .map((b) => (b.type === 'text' ? b.text : `[${b.type}]`))
    .join('\n');
  const out = ['=== system ===', system, '', '=== user ===', content];

  const draftFile = join(dirname(file), 'draft.txt');
  if (existsSync(draftFile)) {
    const findings = checkPost(readFileSync(draftFile, 'utf8'), {
      projectKey: env.JIRA_PROJECT_KEY ?? '',
      prodBranch: env.ANNOUNCE_PROD_BRANCH ?? 'main',
      jiraBaseUrl: env.JIRA_BASE_URL ?? '',
      blocklist: (env.ANNOUNCE_BLOCKLIST ?? DEFAULT_BLOCKLIST).split(',').map((w) => w.trim()).filter((w) => w !== ''),
      allow: (env.ANNOUNCE_ALLOW_TERMS ?? '').split(',').map((w) => w.trim()).filter((w) => w !== ''),
    });
    out.push('', '=== post-check of draft.txt ===', findings.length === 0 ? 'clean' : findings.map((f) => `- ${f}`).join('\n'));
  }
  return out.join('\n');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const path = process.argv[2];
  if (path === undefined) {
    console.error('usage: node dist/announce-sample.js <dir | release.json>');
    process.exit(2);
  }
  console.log(renderSample(path, process.env));
}
