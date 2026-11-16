import { describe, expect, it, vi } from 'vitest';
import { isTrigger, pickImages, selectContext, ticketsOf, transcriptLine, triggerNote, type Triggers } from './context.js';
import { adfToText, Jira, toAdf } from './jira.js';
import { formatReply, plainReply, runTriage, runUpdate, sniffImage, type RunDeps } from './run.js';
import { KEEP_PER_CHAT, Store, type StoredMessage } from './store.js';
import {
  buildContent,
  buildUpdateContent,
  systemPrompt,
  triage,
  TriageError,
  updatePrompt,
  updateTickets,
  type Prompting,
} from './triage.js';
import { loadConfig } from './config.js';

const CHAT = -1001;
const msg = (id: number, over: Partial<StoredMessage> = {}): StoredMessage => ({
  chatId: CHAT,
  messageId: id,
  userId: 7,
  author: 'Денис',
  date: 1_763_200_000,
  text: `m${String(id)}`,
  replyTo: null,
  imageFileId: null,
  ...over,
});
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

const TEAM: Triggers = { commands: ['ticket', 'tiket', 'vzhyru'], phrases: ['в жиру'] };
const PLAIN: Triggers = { commands: ['ticket'], phrases: [] };

describe('trigger', () => {
  it.each([
    ['/ticket', true],
    ['/ticket@team_triage_bot логін падає', true],
    ['/vzhyru', true],
    ['/TICKET', true],
    ['ну все, в жиру', true],
    ['В  ЖИРУ', true],
    ['/tiket треба затестити бота', true],
    ['/tickets', false],
    ['send /ticket later', false],
    ['вжиру', false],
    ['привіт', false],
  ])('%s → %s', (text, expected) => expect(isTrigger(text, TEAM)).toBe(expected));

  it.each([
    ['/ticket', true],
    ['/vzhyru', false],
    ['ну все, в жиру', false],
  ])('with only the default command: %s → %s', (text, expected) => expect(isTrigger(text, PLAIN)).toBe(expected));

  it('escapes phrases and commands literally', () => {
    const odd: Triggers = { commands: ['bug'], phrases: ['fix (pls)', 'a.b'] };
    expect(isTrigger('please fix (pls) it', odd)).toBe(true);
    expect(isTrigger('fix pls', odd)).toBe(false);
    expect(isTrigger('axb', odd)).toBe(false);
    expect(isTrigger('/bug now', odd)).toBe(true);
  });

  it('a mention of the bot triggers, another mention does not', () => {
    expect(isTrigger('@Team_Triage_Bot глянь', TEAM, 'team_triage_bot')).toBe(true);
    expect(isTrigger('@someone глянь', TEAM, 'team_triage_bot')).toBe(false);
    expect(isTrigger('@team_triage_bot глянь', TEAM)).toBe(false);
  });

  it('strips the mention from the note', () => {
    expect(triggerNote('@team_triage_bot логін падає', TEAM, 'team_triage_bot')).toBe('логін падає');
    expect(triggerNote('/tiket треба затестити', TEAM, 'team_triage_bot')).toBe('треба затестити');
  });

  it('keeps the note after the command', () => {
    expect(triggerNote('/ticket@bot логін падає', TEAM)).toBe('логін падає');
    expect(triggerNote('/vzhyru', TEAM)).toBe('');
  });
});

describe('store and context window', () => {
  const filled = (n: number): Store => {
    const s = new Store(':memory:');
    for (let i = 1; i <= n; i++) s.save(msg(i, { userId: i }));
    return s;
  };

  it('takes the last N up to the trigger, oldest first', () => {
    const ids = selectContext(filled(80), CHAT, 70, null, 50).map((m) => m.messageId);
    expect(ids[0]).toBe(21);
    expect(ids.at(-1)).toBe(70);
    expect(ids).toHaveLength(50);
  });

  it('starts at the replied-to message', () => {
    const ids = selectContext(filled(80), CHAT, 70, 60, 50).map((m) => m.messageId);
    expect(ids).toEqual([60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70]);
  });

  it('caps a reply window at N from the replied-to message', () => {
    const ids = selectContext(filled(80), CHAT, 70, 5, 3).map((m) => m.messageId);
    expect(ids).toEqual([5, 6, 7]);
  });

  it('falls back to the last N when the replied-to message was never recorded', () => {
    const s = new Store(':memory:');
    for (const i of [10, 11, 12]) s.save(msg(i));
    expect(selectContext(s, CHAT, 12, 3, 50).map((m) => m.messageId)).toEqual([10, 11, 12]);
  });

  it('a reply to the text pulls in the same author\'s photo just before it', () => {
    const s = new Store(':memory:');
    s.save(msg(17, { userId: 1, date: 1000, text: 'інше' }));
    s.save(msg(18, { userId: 7, date: 1100, text: '', imageFileId: 'shot' }));
    s.save(msg(19, { userId: 7, date: 1105, text: 'Тут не видно в списке какой тенант выбран' }));
    s.save(msg(20, { userId: 7, date: 1110, text: '/ticket', replyTo: 19 }));
    expect(selectContext(s, CHAT, 20, 19, 50).map((m) => m.messageId)).toEqual([18, 19, 20]);
  });

  it('stops at another author or a long gap', () => {
    const s = new Store(':memory:');
    s.save(msg(1, { userId: 7, date: 0, imageFileId: 'old' }));
    s.save(msg(2, { userId: 8, date: 900 }));
    s.save(msg(3, { userId: 7, date: 1000 }));
    s.save(msg(4, { userId: 7, date: 1000 + 181 }));
    s.save(msg(5, { userId: 7, date: 1300, replyTo: 4 }));
    expect(selectContext(s, CHAT, 5, 4, 50).map((m) => m.messageId)).toEqual([4, 5]);
    expect(selectContext(s, CHAT, 5, 3, 50).map((m) => m.messageId)).toEqual([3, 4, 5]);
  });

  it('walks up the replied-to message\'s own reply chain', () => {
    const s = new Store(':memory:');
    s.save(msg(10, { userId: 1, date: 0, imageFileId: 'bug' }));
    s.save(msg(11, { userId: 2, date: 500 }));
    s.save(msg(12, { userId: 3, date: 900, replyTo: 10, text: 'і в мене' }));
    s.save(msg(13, { userId: 4, date: 1000, text: '/ticket', replyTo: 12 }));
    expect(selectContext(s, CHAT, 13, 12, 50).map((m) => m.messageId)).toEqual([10, 11, 12, 13]);
  });

  it('keeps chats apart', () => {
    const s = filled(3);
    s.save(msg(2, { chatId: -2002, text: 'other' }));
    expect(selectContext(s, CHAT, 3, null, 50).map((m) => m.text)).toEqual(['m1', 'm2', 'm3']);
  });

  it(`prunes to the newest ${String(KEEP_PER_CHAT)} per chat`, () => {
    const s = filled(1003);
    const all = s.lastUpTo(CHAT, 2000, 5000);
    expect(all).toHaveLength(1000);
    expect(all[0]!.messageId).toBe(4);
  });

  it('caps runs per day', () => {
    const s = new Store(':memory:');
    expect(s.takeRun('2026-11-15', 2)).toBe(true);
    expect(s.takeRun('2026-11-15', 2)).toBe(true);
    expect(s.takeRun('2026-11-15', 2)).toBe(false);
    expect(s.takeRun('2026-11-16', 2)).toBe(true);
  });

  it('picks the newest images', () => {
    const ms = [msg(1, { imageFileId: 'a' }), msg(2), msg(3, { imageFileId: 'b' }), msg(4, { imageFileId: 'c' })];
    expect(pickImages(ms, 2).map((m) => m.messageId)).toEqual([3, 4]);
    expect(pickImages(ms, 0)).toEqual([]);
  });

  it('writes a transcript line with reply, image and Kyiv time', () => {
    // 1763200000 = 2025-11-15 09:46:40 UTC = 11:46 Kyiv
    expect(transcriptLine(msg(9, { replyTo: 4, imageFileId: 'x', text: 'ось' }), true, 'Europe/Kyiv')).toBe(
      '#9 15.11, 11:46 Денис ↩#4: [image #9] ось',
    );
    expect(transcriptLine(msg(9, { imageFileId: 'x', text: '' }), false, 'Europe/Kyiv')).toBe('#9 15.11, 11:46 Денис: [image, not shown]');
    expect(transcriptLine(msg(9, { text: 'ось' }), false, 'UTC')).toBe('#9 15.11, 09:46 Денис: ось');
  });
});

describe('Jira', () => {
  const cfg = {
    baseUrl: 'https://example.atlassian.net',
    email: 'bot@example.com',
    apiToken: 'tok',
    projectKey: 'ABC',
    bugType: '10004',
    taskType: 'Task',
    label: 'from-telegram',
    sprintField: 'customfield_10020',
  };

  it('builds ADF paragraphs with hard breaks', () => {
    expect(toAdf('a\nb\n\nc')).toEqual({
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'c' }] },
      ],
    });
  });

  it('creates a bug in the project with the label, a one-line summary and the sprint', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ key: 'ABC-300' }), { status: 201 }));
    const key = await new Jira({ ...cfg, sprintId: 2 }, fetchFn).createIssue({
      type: 'bug',
      summary: 'Логін\nпадає',
      description: 'x',
    });
    expect(key).toBe('ABC-300');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://example.atlassian.net/rest/api/3/issue');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('bot@example.com:tok').toString('base64')}`,
    );
    const fields = JSON.parse(init.body as string).fields;
    expect(fields.project).toEqual({ key: 'ABC' });
    expect(fields.issuetype).toEqual({ id: '10004' });
    expect(fields.summary).toBe('Логін падає');
    expect(fields.labels).toEqual(['from-telegram']);
    expect(fields.customfield_10020).toBe(2);
  });

  it('a task uses the task type and no sprint field when none is set', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ key: 'ABC-1' }), { status: 201 }));
    await new Jira(cfg, fetchFn).createIssue({ type: 'task', summary: 's', description: 'd' });
    const fields = JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).fields;
    expect(fields.issuetype).toEqual({ name: 'Task' });
    expect('customfield_10020' in fields).toBe(false);
  });

  it('throws on a failed create', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 400 }));
    await expect(new Jira(cfg, fetchFn).createIssue({ type: 'bug', summary: 's', description: 'd' })).rejects.toThrow(
      'create issue failed: 400',
    );
  });

  it('attaches files in one multipart request with the XSRF header', async () => {
    const fetchFn = vi.fn(async () => new Response('[]', { status: 200 }));
    await new Jira(cfg, fetchFn).attach('ABC-300', [
      { filename: 'telegram-9.jpg', contentType: 'image/jpeg', data: JPEG },
      { filename: 'telegram-10.png', contentType: 'image/png', data: PNG },
    ]);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://example.atlassian.net/rest/api/3/issue/ABC-300/attachments');
    expect((init.headers as Record<string, string>)['X-Atlassian-Token']).toBe('no-check');
    const files = (init.body as FormData).getAll('file') as File[];
    expect(files.map((f) => f.name)).toEqual(['telegram-9.jpg', 'telegram-10.png']);
    expect(files.map((f) => f.size)).toEqual([7, 6]);
  });

  it('makes no request for no files', async () => {
    const fetchFn = vi.fn();
    await new Jira(cfg, fetchFn).attach('ABC-1', []);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('a run', () => {
  const setup = (triageResult: Awaited<ReturnType<RunDeps['triage']>>, images: Record<string, Uint8Array>) => {
    const store = new Store(':memory:');
    store.save(msg(1, { text: 'логін падає', imageFileId: 'f1' }));
    store.save(msg(2, { text: '', imageFileId: 'f2' }));
    store.save(msg(3, { text: 'і чек не приходить', imageFileId: 'f3' }));
    store.save(msg(4, { text: '/ticket' }));
    let n = 0;
    const deps: RunDeps = {
      store,
      download: vi.fn(async (id: string) => {
        const data = images[id];
        if (data === undefined) throw new Error('gone');
        return data;
      }),
      triage: vi.fn(async () => triageResult),
      jira: {
        createIssue: vi.fn(async () => `ABC-${String(++n)}`),
        attach: vi.fn(async () => undefined),
        issueUrl: (k: string) => `https://j/browse/${k}`,
      },
      log: vi.fn(),
    };
    const req = {
      chatId: CHAT,
      triggerId: 4,
      replyTo: null,
      note: '',
      triggeredBy: 'Денис',
      contextMessages: 50,
      maxImages: 10,
      maxTickets: 3,
    };
    return { deps, req };
  };

  it('attaches the images Claude tied to each ticket', async () => {
    const { deps, req } = setup(
      {
        chat_reply: 'Створено 2',
        tickets: [
          { type: 'bug', summary: 'Логін', description: 'd', image_message_ids: [1, 2] },
          { type: 'bug', summary: 'Чек', description: 'd', image_message_ids: [3] },
        ],
      },
      { f1: JPEG, f2: PNG, f3: JPEG },
    );
    const result = await runTriage(deps, req);
    const attach = deps.jira.attach as ReturnType<typeof vi.fn>;
    expect(attach.mock.calls.map(([k, f]) => [k, (f as { filename: string }[]).map((x) => x.filename)])).toEqual([
      ['ABC-1', ['telegram-1.jpg', 'telegram-2.png']],
      ['ABC-2', ['telegram-3.jpg']],
    ]);
    expect(result.filed.map((f) => [f.key, f.attached])).toEqual([
      ['ABC-1', 2],
      ['ABC-2', 1],
    ]);
  });

  it('a lone ticket with no images tied gets none — the window holds unrelated screenshots', async () => {
    const { deps, req } = setup(
      { chat_reply: 'ok', tickets: [{ type: 'bug', summary: 'x', description: 'd', image_message_ids: [] }] },
      { f1: JPEG, f2: PNG, f3: JPEG },
    );
    await runTriage(deps, req);
    const files = (deps.jira.attach as ReturnType<typeof vi.fn>).mock.calls[0]![1] as unknown[];
    expect(files).toEqual([]);
  });

  it('two tickets with no images tied attach nothing', async () => {
    const { deps, req } = setup(
      {
        chat_reply: 'ok',
        tickets: [
          { type: 'bug', summary: 'x', description: 'd', image_message_ids: [] },
          { type: 'task', summary: 'y', description: 'd', image_message_ids: [] },
        ],
      },
      { f1: JPEG },
    );
    await runTriage(deps, req);
    for (const call of (deps.jira.attach as ReturnType<typeof vi.fn>).mock.calls) expect(call[1]).toEqual([]);
  });

  it('skips an image that fails to download or is not an image, and still files', async () => {
    const { deps, req } = setup(
      { chat_reply: 'ok', tickets: [{ type: 'bug', summary: 'x', description: 'd', image_message_ids: [] }] },
      { f1: JPEG, f3: new Uint8Array([1, 2, 3, 4]) },
    );
    await runTriage(deps, req);
    const input = (deps.triage as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(input.images.map((i: { messageId: number }) => i.messageId)).toEqual([1]);
    expect((deps.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toContain('image_download_failed');
    expect((deps.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toContain('image_skipped');
  });

  it('a failed attach keeps the issue and says so', async () => {
    const { deps, req } = setup(
      { chat_reply: 'ok', tickets: [{ type: 'bug', summary: 'x', description: 'd', image_message_ids: [1] }] },
      { f1: JPEG },
    );
    (deps.jira.attach as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('413'));
    const result = await runTriage(deps, req);
    expect(result.filed).toEqual([
      { key: 'ABC-1', url: 'https://j/browse/ABC-1', summary: 'x', attached: 1, attachOk: false },
    ]);
    expect(formatReply(result)).toBe('ok\n• <a href="https://j/browse/ABC-1">ABC-1</a> x (⚠️ фото не прикріпились)');
  });

  it('logs ids, never text', async () => {
    const { deps, req } = setup(
      { chat_reply: 'ok', tickets: [{ type: 'bug', summary: 'секрет', description: 'd', image_message_ids: [] }] },
      {},
    );
    await runTriage(deps, req);
    const logged = JSON.stringify((deps.log as ReturnType<typeof vi.fn>).mock.calls);
    expect(logged).not.toContain('секрет');
    expect(logged).not.toContain('логін');
  });
});

describe('reply and image sniffing', () => {
  it('escapes HTML in the reply', () => {
    expect(
      formatReply({
        chatReply: '<b>',
        filed: [{ key: 'ABC-1', url: 'https://j/browse/ABC-1', summary: 'a & <b>', attached: 2, attachOk: true }],
      }),
    ).toBe('&lt;b&gt;\n• <a href="https://j/browse/ABC-1">ABC-1</a> a &amp; &lt;b&gt; 📎2');
  });

  it('records its own reply as plain text', () => {
    expect(
      plainReply({
        chatReply: 'Створив 1',
        filed: [{ key: 'ABC-218', url: 'u', summary: 'Перевірити бота', attached: 0, attachOk: true }],
      }),
    ).toBe('Створив 1\n• ABC-218 Перевірити бота');
  });

  it('sniffs image types', () => {
    expect(sniffImage(JPEG)).toBe('image/jpeg');
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBe('image/gif');
    expect(sniffImage(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe('image/webp');
    expect(sniffImage(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeNull();
  });
});

describe('Claude call', () => {
  const prompting: Prompting = { productContext: '', timeZone: 'Europe/Kyiv' };
  const input = {
    messages: [msg(1, { text: 'логін падає', imageFileId: 'f1' }), msg(2, { imageFileId: 'f2' }), msg(3, { text: '/ticket' })],
    images: [{ messageId: 1, mediaType: 'image/jpeg' as const, base64: 'AAA' }],
    note: '',
    triggeredBy: 'Денис',
    maxTickets: 2,
  };

  it('puts the transcript first and each image after its label', () => {
    const blocks = buildContent(input, 'Europe/Kyiv');
    expect(blocks).toHaveLength(3);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('#1 15.11, 11:46 Денис: [image #1] логін падає');
    expect(text).toContain('#2 15.11, 11:46 Денис: [image, not shown] m2');
    expect(text).toContain('Their note: (none)');
    expect(text).toContain('File at most 2 tickets.');
    expect(blocks[1]).toEqual({ type: 'text', text: 'Image #1:' });
    expect(blocks[2]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAA' } });
  });

  const fakeClient = (response: object) => {
    const parse = vi.fn(async () => response);
    return { client: { beta: { messages: { parse } } } as never, parse };
  };

  it('asks Opus 5.5 with the fallback beta and drops unshown image ids and extra tickets', async () => {
    const ticket = { type: 'bug', summary: 's', description: 'd', image_message_ids: [1, 1, 2, 99] };
    const { client, parse } = fakeClient({
      stop_reason: 'end_turn',
      parsed_output: { chat_reply: 'ok', tickets: [ticket, ticket, ticket] },
    });
    const result = await triage(client, 'claude-opus-5-5', prompting, input);
    expect(result.tickets).toHaveLength(2);
    expect(result.tickets[0]!.image_message_ids).toEqual([1]);
    const params = (parse.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(params.model).toBe('claude-opus-5-5');
    expect(params.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(params.fallbacks).toBe('default');
    expect(params.system).toBe(systemPrompt(prompting));
  });

  it('tells Claude about the product only when a context is set', () => {
    expect(systemPrompt({ productContext: '', timeZone: 'UTC' })).not.toContain('<product>');
    expect(systemPrompt({ productContext: '', timeZone: 'UTC' })).toContain('time in UTC');
    const withProduct = systemPrompt({ productContext: '  Acme sells shoes.  ', timeZone: 'Europe/Kyiv' });
    expect(withProduct).toContain('About the product the team works on:\n<product>\nAcme sells shoes.\n</product>');
    expect(withProduct).toContain('time in Europe/Kyiv');
    expect(updatePrompt({ productContext: 'Acme sells shoes.', timeZone: 'UTC' })).toContain('<product>\nAcme sells shoes.\n</product>');
  });

  it.each(['refusal', 'max_tokens'])('throws on %s', async (stop) => {
    const { client } = fakeClient({ stop_reason: stop, parsed_output: null });
    await expect(triage(client, 'm', prompting, input)).rejects.toThrow(TriageError);
  });

  it('throws when nothing parsed', async () => {
    const { client } = fakeClient({ stop_reason: 'end_turn', parsed_output: null });
    await expect(triage(client, 'm', prompting, input)).rejects.toThrow('unparsed');
  });
});

describe('config', () => {
  const base = {
    TELEGRAM_BOT_TOKEN: 't',
    ANTHROPIC_API_KEY: 'k',
    JIRA_EMAIL: 'e',
    JIRA_API_TOKEN: 'j',
    JIRA_BASE_URL: 'https://example.atlassian.net',
    JIRA_PROJECT_KEY: 'ABC',
  };

  it('defaults to Opus 5.5, 50 messages, 10 images, /ticket, UTC, Bug/Task, no product context', () => {
    const c = loadConfig({ ...base, ALLOWED_CHAT_IDS: '-100123, -100456' });
    expect(c.JIRA_PROJECT_KEY).toBe('ABC');
    expect(c.JIRA_BUG_TYPE).toBe('Bug');
    expect(c.JIRA_TASK_TYPE).toBe('Task');
    expect(c.TRIGGER_COMMANDS).toEqual(['ticket']);
    expect(c.TRIGGER_PHRASES).toEqual([]);
    expect(c.TIME_ZONE).toBe('UTC');
    expect(c.PRODUCT_CONTEXT).toBe('');
    expect(c.CLAUDE_MODEL).toBe('claude-opus-5-5');
    expect(c.CONTEXT_MESSAGES).toBe(50);
    expect(c.MAX_IMAGES).toBe(10);
    expect(c.ALLOWED_CHAT_IDS).toEqual([-100123, -100456]);
    expect(c.ALLOWED_USER_IDS).toEqual([]);
    expect(c.JIRA_SPRINT_ID).toBeUndefined();
  });

  it('reads triggers, zone and context', () => {
    const c = loadConfig({
      ...base,
      TRIGGER_COMMANDS: 'Ticket, vzhyru',
      TRIGGER_PHRASES: 'в жиру, ,file it',
      TIME_ZONE: 'Europe/Kyiv',
      PRODUCT_CONTEXT: 'Acme',
    });
    expect(c.TRIGGER_COMMANDS).toEqual(['ticket', 'vzhyru']);
    expect(c.TRIGGER_PHRASES).toEqual(['в жиру', 'file it']);
    expect(c.TIME_ZONE).toBe('Europe/Kyiv');
    expect(c.PRODUCT_CONTEXT).toBe('Acme');
  });

  it('requires the Jira site and project, and rejects a bad zone or command', () => {
    const { JIRA_BASE_URL: _u, JIRA_PROJECT_KEY: _p, ...noJira } = base;
    expect(() => loadConfig(noJira)).toThrow('invalid environment: JIRA_BASE_URL, JIRA_PROJECT_KEY');
    expect(() => loadConfig({ ...base, TIME_ZONE: 'Mars/Olympus' })).toThrow('invalid environment: TIME_ZONE');
    expect(() => loadConfig({ ...base, TRIGGER_COMMANDS: 'тікет' })).toThrow('invalid environment: TRIGGER_COMMANDS');
  });

  it('names a bad variable without printing secrets', () => {
    expect(() => loadConfig({ ...base, JIRA_API_TOKEN: '', ALLOWED_CHAT_IDS: 'abc' })).toThrow(
      'invalid environment: JIRA_API_TOKEN, ALLOWED_CHAT_IDS',
    );
  });
});

describe('updating from a reply', () => {
  const BOT = 99;
  const seed = () => {
    const store = new Store(':memory:');
    store.save(msg(20, { userId: 7, date: 1000, imageFileId: 'old-shot', text: 'тут не видно тенант' }));
    store.save(msg(21, { userId: 7, date: 1010, text: '/ticket', replyTo: 20 }));
    store.save(msg(22, { userId: BOT, author: 'team-triage-bot (bot)', date: 1030, text: 'Завів\n• ABC-221 Тенант', replyTo: 21 }));
    store.saveFiled(CHAT, 22, ['ABC-221']);
    store.save(msg(23, { userId: 7, date: 1060, imageFileId: 'new-shot', text: '' }));
    store.save(msg(24, { userId: 7, date: 1065, text: 'тільки на вебі, на iOS ок', replyTo: 22 }));
    return store;
  };

  const deps = (store: Store, updates: Awaited<ReturnType<NonNullable<RunDeps['update']>>>): RunDeps => ({
    store,
    download: vi.fn(async (id: string) => (id === 'new-shot' ? PNG : JPEG)),
    triage: vi.fn(),
    update: vi.fn(async () => updates),
    jira: {
      createIssue: vi.fn(),
      getIssue: vi.fn(async () => ({ summary: 'Тенант', description: 'Старий опис' })),
      updateIssue: vi.fn(async () => undefined),
      attach: vi.fn(async () => undefined),
      issueUrl: (k: string) => `https://j/browse/${k}`,
    },
    log: vi.fn(),
  });

  it('reads the reply and the author\'s screenshot after the bot message, not the old one', async () => {
    const d = deps(seed(), {
      chat_reply: 'Оновив',
      updates: [{ key: 'ABC-221', summary: 'Тенант (веб)', description: 'Новий опис', image_message_ids: [23] }],
    });
    const result = await runUpdate(d, { chatId: CHAT, botMessageId: 22, replyId: 24, keys: ['ABC-221'], maxImages: 10 });
    const input = (d.update as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(input.messages.map((m: StoredMessage) => m.messageId)).toEqual([23, 24]);
    expect(input.images.map((i: { messageId: number }) => i.messageId)).toEqual([23]);
    expect(input.tickets).toEqual([{ key: 'ABC-221', summary: 'Тенант', description: 'Старий опис' }]);
    expect(d.jira.updateIssue).toHaveBeenCalledWith('ABC-221', { summary: 'Тенант (веб)', description: 'Новий опис' });
    const files = (d.jira.attach as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { filename: string }[];
    expect(files.map((f) => f.filename)).toEqual(['telegram-23.png']);
    expect(result.filed.map((f) => f.key)).toEqual(['ABC-221']);
  });

  it('attaches no screenshot Claude did not tie to the ticket', async () => {
    const d = deps(seed(), {
      chat_reply: 'Оновив',
      updates: [{ key: 'ABC-221', summary: 'Тенант', description: 'Новий опис', image_message_ids: [] }],
    });
    await runUpdate(d, { chatId: CHAT, botMessageId: 22, replyId: 24, keys: ['ABC-221'], maxImages: 10 });
    expect((d.jira.attach as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toEqual([]);
  });

  it('changes nothing when the reply adds nothing', async () => {
    const d = deps(seed(), { chat_reply: 'Нічого нового', updates: [] });
    const result = await runUpdate(d, { chatId: CHAT, botMessageId: 22, replyId: 24, keys: ['ABC-221'], maxImages: 10 });
    expect(d.jira.updateIssue).not.toHaveBeenCalled();
    expect(d.jira.attach).not.toHaveBeenCalled();
    expect(result).toEqual({ chatReply: 'Нічого нового', filed: [] });
  });

  it('finds the tickets of a bot message, from the table or its recorded text', () => {
    const store = seed();
    expect(ticketsOf(store, CHAT, 22, 'ABC')).toEqual(['ABC-221']);
    store.save(msg(30, { author: 'team-triage-bot (bot)', text: 'Створив 2\n• ABC-5 a\n• ABC-6 b' }));
    expect(ticketsOf(store, CHAT, 30, 'ABC')).toEqual(['ABC-5', 'ABC-6']);
    store.save(msg(31, { author: 'Денис', text: '• ABC-7 not the bot' }));
    expect(ticketsOf(store, CHAT, 31, 'ABC')).toEqual([]);
    expect(ticketsOf(store, CHAT, 24, 'ABC')).toEqual([]);
  });

  it('turns ADF back into text', () => {
    expect(adfToText(toAdf('a\nb\n\nc'))).toBe('a\nb\n\nc');
    expect(adfToText(null)).toBe('');
  });

  it('gets and updates an issue over REST', async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT'
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({ fields: { summary: 'S', description: toAdf('D') } }), { status: 200 }),
    );
    const j = new Jira(
      { baseUrl: 'https://x', email: 'e', apiToken: 't', projectKey: 'ABC', bugType: '1', taskType: '2', label: 'l', sprintField: 'f' },
      fetchFn as unknown as typeof fetch,
    );
    expect(await j.getIssue('ABC-1')).toEqual({ summary: 'S', description: 'D' });
    await j.updateIssue('ABC-1', { summary: 'S2\nx', description: 'D2' });
    const [url, init] = fetchFn.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe('https://x/rest/api/3/issue/ABC-1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string).fields).toEqual({ summary: 'S2 x', description: toAdf('D2') });
  });

  it('keeps only listed keys and shown images', async () => {
    const parse = vi.fn(async () => ({
      stop_reason: 'end_turn',
      parsed_output: {
        chat_reply: 'ok',
        updates: [
          { key: 'ABC-221', summary: 's', description: 'd', image_message_ids: [23, 5] },
          { key: 'ABC-999', summary: 's', description: 'd', image_message_ids: [] },
        ],
      },
    }));
    const input = {
      tickets: [{ key: 'ABC-221', summary: 'Тенант', description: 'Старий' }],
      messages: [msg(24, { text: 'тільки на вебі' })],
      images: [{ messageId: 23, mediaType: 'image/png' as const, base64: 'B' }],
    };
    const result = await updateTickets({ beta: { messages: { parse } } } as never, 'claude-opus-5-5', { productContext: '', timeZone: 'UTC' }, input);
    expect(result.updates.map((u) => [u.key, u.image_message_ids])).toEqual([['ABC-221', [23]]]);
    const text = (buildUpdateContent(input, 'UTC')[0] as { text: string }).text;
    expect(text).toContain('<ticket key="ABC-221">\nSummary: Тенант\nDescription:\nСтарий\n</ticket>');
    expect(text).toContain('тільки на вебі');
  });
});
