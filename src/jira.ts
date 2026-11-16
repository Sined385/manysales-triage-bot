/** Jira Cloud REST v3: create an issue, attach files. Basic auth with an API token. */

export interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKey: string;
  /** An issue type's id (all digits) or name. */
  bugType: string;
  taskType: string;
  label: string;
  sprintId?: number;
  sprintField: string;
}

export interface NewIssue {
  type: 'bug' | 'task';
  summary: string;
  /** Plain text; blank lines separate paragraphs. */
  description: string;
}

export interface Attachment {
  filename: string;
  contentType: string;
  data: Uint8Array;
}

type Fetch = typeof fetch;

/** Jira takes an issue type by id or by name; an all-digit value is an id. */
export const issueType = (value: string): { id: string } | { name: string } =>
  /^\d+$/.test(value) ? { id: value } : { name: value };

export class JiraError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Atlassian Document Format: one paragraph per blank-line block, hard breaks inside. */
export function toAdf(text: string): object {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.map((p) => ({
      type: 'paragraph',
      content: p.split('\n').flatMap((line, i) => [
        ...(i > 0 ? [{ type: 'hardBreak' }] : []),
        ...(line === '' ? [] : [{ type: 'text', text: line }]),
      ]),
    })),
  };
}

/** ADF back to plain text: paragraphs by blank lines, hard breaks by newlines. Other nodes keep their text. */
export function adfToText(node: unknown): string {
  const walk = (n: unknown): string => {
    if (typeof n !== 'object' || n === null) return '';
    const o = n as { type?: unknown; text?: unknown; content?: unknown };
    if (o.type === 'text' && typeof o.text === 'string') return o.text;
    if (o.type === 'hardBreak') return '\n';
    const inner = Array.isArray(o.content) ? o.content.map(walk) : [];
    if (o.type === 'doc') return inner.filter((x) => x !== '').join('\n\n');
    if (o.type === 'listItem') return `- ${inner.join('').trim()}\n`;
    return inner.join('');
  };
  return walk(node).trim();
}

export interface IssueText {
  summary: string;
  description: string;
}

export class Jira {
  constructor(
    private readonly cfg: JiraConfig,
    private readonly fetchFn: Fetch = fetch,
  ) {}

  private get auth(): string {
    return `Basic ${Buffer.from(`${this.cfg.email}:${this.cfg.apiToken}`).toString('base64')}`;
  }

  issueUrl(key: string): string {
    return `${this.cfg.baseUrl.replace(/\/$/, '')}/browse/${key}`;
  }

  async createIssue(issue: NewIssue): Promise<string> {
    const fields: Record<string, unknown> = {
      project: { key: this.cfg.projectKey },
      issuetype: issueType(issue.type === 'bug' ? this.cfg.bugType : this.cfg.taskType),
      // Jira rejects a summary over 255 characters or with a line break.
      summary: issue.summary.replace(/\s+/g, ' ').trim().slice(0, 255),
      description: toAdf(issue.description),
      labels: [this.cfg.label],
    };
    if (this.cfg.sprintId !== undefined) fields[this.cfg.sprintField] = this.cfg.sprintId;
    const res = await this.fetchFn(`${this.cfg.baseUrl}/rest/api/3/issue`, {
      method: 'POST',
      headers: { Authorization: this.auth, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ fields }),
    });
    if (!res.ok) throw new JiraError(res.status, `create issue failed: ${String(res.status)}`);
    const body = (await res.json()) as { key?: unknown };
    if (typeof body.key !== 'string') throw new JiraError(res.status, 'create issue returned no key');
    return body.key;
  }

  async getIssue(key: string): Promise<IssueText> {
    const res = await this.fetchFn(`${this.cfg.baseUrl}/rest/api/3/issue/${key}?fields=summary,description`, {
      headers: { Authorization: this.auth, Accept: 'application/json' },
    });
    if (!res.ok) throw new JiraError(res.status, `get issue failed: ${String(res.status)}`);
    const body = (await res.json()) as { fields?: { summary?: unknown; description?: unknown } };
    return {
      summary: typeof body.fields?.summary === 'string' ? body.fields.summary : '',
      description: adfToText(body.fields?.description ?? null),
    };
  }

  async updateIssue(key: string, issue: IssueText): Promise<void> {
    const res = await this.fetchFn(`${this.cfg.baseUrl}/rest/api/3/issue/${key}`, {
      method: 'PUT',
      headers: { Authorization: this.auth, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        fields: { summary: issue.summary.replace(/\s+/g, ' ').trim().slice(0, 255), description: toAdf(issue.description) },
      }),
    });
    if (!res.ok) throw new JiraError(res.status, `update issue failed: ${String(res.status)}`);
  }

  /** One request for all files. */
  async attach(key: string, files: Attachment[]): Promise<void> {
    if (files.length === 0) return;
    const form = new FormData();
    for (const f of files) form.append('file', new Blob([new Uint8Array(f.data)], { type: f.contentType }), f.filename);
    const res = await this.fetchFn(`${this.cfg.baseUrl}/rest/api/3/issue/${key}/attachments`, {
      method: 'POST',
      headers: { Authorization: this.auth, 'X-Atlassian-Token': 'no-check', Accept: 'application/json' },
      body: form,
    });
    if (!res.ok) throw new JiraError(res.status, `attach failed: ${String(res.status)}`);
  }
}
