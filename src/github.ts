/** GitHub REST: merged pull requests of a repo. A fine-grained token with Pull requests: read is enough. */

export interface Pull {
  /** `owner/name`. */
  repo: string;
  number: number;
  title: string;
  body: string;
  /** ISO-8601 UTC (`toISOString` form); null when the PR was closed without a merge. */
  mergedAt: string | null;
  headRef: string;
}

type Fetch = typeof fetch;

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A PR body is cut here when fetched; promotion bodies are lists, far shorter. */
export const MAX_BODY_CHARS = 8000;
export const PAGE_SIZE = 50;
export const MAX_PAGES = 3;

interface ApiPull {
  number?: unknown;
  title?: unknown;
  body?: unknown;
  merged_at?: unknown;
  updated_at?: unknown;
  head?: { ref?: unknown };
}

const iso = (s: string): string => new Date(s).toISOString();

const toPull = (repo: string, p: ApiPull): Pull => ({
  repo,
  number: Number(p.number),
  title: typeof p.title === 'string' ? p.title : '',
  body: typeof p.body === 'string' ? p.body.slice(0, MAX_BODY_CHARS) : '',
  mergedAt: typeof p.merged_at === 'string' ? iso(p.merged_at) : null,
  headRef: typeof p.head?.ref === 'string' ? p.head.ref : '',
});

export class GitHub {
  constructor(
    private readonly token: string,
    private readonly fetchFn: Fetch = fetch,
    private readonly apiUrl = 'https://api.github.com',
  ) {}

  private async get(path: string): Promise<unknown> {
    const res = await this.fetchFn(`${this.apiUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'triage-bot',
      },
    });
    if (!res.ok) throw new GitHubError(res.status, `github ${String(res.status)}`);
    return res.json();
  }

  /**
   * PRs merged into `base` after `since`, newest update first. Walks the
   * closed PRs sorted by last update and stops at the first one not updated
   * since `since` — a merge updates the PR, so nothing older can be new.
   */
  async listMergedPulls(repo: string, base: string, since: string): Promise<Pull[]> {
    const sinceMs = Date.parse(since);
    const pulls: Pull[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const q = new URLSearchParams({
        state: 'closed',
        base,
        sort: 'updated',
        direction: 'desc',
        per_page: String(PAGE_SIZE),
        page: String(page),
      });
      const items = (await this.get(`/repos/${repo}/pulls?${q.toString()}`)) as ApiPull[];
      if (!Array.isArray(items)) throw new GitHubError(200, 'github list is not an array');
      for (const item of items) {
        if (typeof item.updated_at !== 'string' || Date.parse(item.updated_at) <= sinceMs) return pulls;
        if (typeof item.merged_at === 'string' && Date.parse(item.merged_at) > sinceMs) pulls.push(toPull(repo, item));
      }
      if (items.length < PAGE_SIZE) break;
    }
    return pulls;
  }

  async getPull(repo: string, number: number): Promise<Pull> {
    return toPull(repo, (await this.get(`/repos/${repo}/pulls/${String(number)}`)) as ApiPull);
  }
}
