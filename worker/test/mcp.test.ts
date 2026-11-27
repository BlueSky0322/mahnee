import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, expect, it, onTestFinished } from 'vitest';
import { DEFAULT_CATEGORIES } from '../../shared/categories';
import { startLocalWorker, type LocalWorker } from './local-worker';

let api: LocalWorker;
beforeAll(async () => {
  api = await startLocalWorker({ mcpWrites: true });
}, 180_000);
afterAll(() => api?.stop(), 30_000);

async function connect(email: string, path = '/api/mcp', send = fetch) {
  const client = new Client({ name: 'mahnee-test', version: '1' });
  onTestFinished(() => client.close());
  // A remote client uses the signed-in identity and has no browser account header.
  await client.connect(
    new StreamableHTTPClientTransport(new URL(path, api.base), {
      fetch: send,
      requestInit: { headers: { 'X-Dev-User': email } },
    }),
  );
  return client;
}

const rowId = (n: number) => n.toString(16).padStart(16, '0');
const wallet = rowId(1);
const savings = rowId(2);
const food = DEFAULT_CATEGORIES.find((c) => c.name === 'Food')!.id;
const salary = DEFAULT_CATEGORIES.find((c) => c.name === 'Salary')!.id;

const account = (id: string, name: string, openingCents: number) => ({
  op: 'addAccount',
  account: { id, name, kind: 'cash', openingCents },
});

const entry = (
  id: number,
  date: string,
  amountCents: number,
  kind: 'expense' | 'income' | 'transfer' = 'expense',
) => ({
  op: 'addTransaction',
  transaction: {
    id: rowId(id),
    accountId: wallet,
    kind,
    date,
    amountCents,
    categoryId: kind === 'expense' ? food : kind === 'income' ? salary : null,
    toAccountId: kind === 'transfer' ? savings : null,
    payee: kind === 'expense' ? 'Market' : null,
    note: null,
  },
});

async function seed(email: string, changes: unknown[]) {
  const reply = await api.call(email, 'POST', '/api/changes', {
    changes,
    ids: changes.map((_, i) => rowId(100 + i)),
  });
  expect(reply.status).toBe(200);
}

it('discovers the read tools and reports balances, month totals and paged entries for the signed-in ledger', async () => {
  const owner = 'groceries@example.test';
  const neighbor = 'travel@example.test';
  await seed(owner, [
    account(wallet, 'Wallet', 10_000),
    account(savings, 'Savings', 500),
    entry(11, '2026-09-24', 600),
    entry(12, '2026-09-25', 400),
    entry(13, '2026-10-10', 300),
    entry(14, '2026-10-20', 800, 'transfer'),
    entry(15, '2026-10-24', 2000, 'income'),
    entry(16, '2026-10-25', 100),
  ]);
  // Same account id, transaction id, date and payee as the first ledger.
  await seed(neighbor, [account(wallet, 'Travel purse', 20_000), entry(13, '2026-10-10', 9900)]);
  expect(
    (await api.call(owner, 'PATCH', '/api/me', { settings: { monthStartDay: 25 } })).status,
  ).toBe(200);

  const client = await connect(owner);
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name).sort()).toEqual([
    'get_month_summary',
    'list_accounts',
    'list_categories',
    'search_transactions',
  ]);
  expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);

  const balances = await client.callTool({ name: 'list_accounts' });
  expect(balances.structuredContent).toMatchObject({
    accounts: [
      { id: wallet, name: 'Wallet', currency: 'MYR', balanceCents: 9800 },
      { id: savings, name: 'Savings', currency: 'MYR', balanceCents: 1300 },
    ],
  });
  const month = await client.callTool({
    name: 'get_month_summary',
    arguments: { month: '2026-10' },
  });
  expect(month.structuredContent).toMatchObject({
    month: '2026-10',
    firstDay: '2026-09-25',
    lastDay: '2026-10-24',
    currency: 'MYR',
    spentCents: 700,
    incomeCents: 2000,
    leftCents: 1300,
    spentByCategory: [{ categoryId: food, cents: 700, entries: 2 }],
    incomeByCategory: [{ categoryId: salary, cents: 2000, entries: 1 }],
  });

  const filters = {
    q: 'market',
    account: wallet,
    category: food,
    kind: 'expense',
    from: '2026-09-25',
    to: '2026-10-24',
    limit: 1,
  };
  const page = await client.callTool({ name: 'search_transactions', arguments: filters });
  expect(page.structuredContent).toMatchObject({
    transactions: [
      { id: rowId(13), date: '2026-10-10', payee: 'Market', amountCents: 300, currency: 'MYR' },
    ],
    nextBefore: expect.any(String),
  });
  const next = await client.callTool({
    name: 'search_transactions',
    arguments: {
      ...filters,
      before: (page.structuredContent as { nextBefore: string }).nextBefore,
    },
  });
  expect(next.structuredContent).toMatchObject({
    transactions: [{ id: rowId(12), date: '2026-09-25', amountCents: 400 }],
    nextBefore: null,
  });

  const other = await connect(neighbor);
  const theirs = await other.callTool({ name: 'list_accounts' });
  expect(theirs.structuredContent).toMatchObject({
    accounts: [{ id: wallet, name: 'Travel purse', balanceCents: 10_100 }],
  });
});

it('lets a new signer read the empty ledger and default categories without creating a profile', async () => {
  const email = 'first-read@example.test';
  const client = await connect(email);
  const accounts = await client.callTool({ name: 'list_accounts' });
  expect(accounts.structuredContent).toEqual({ accounts: [] });
  const categories = await client.callTool({ name: 'list_categories' });
  expect(categories.structuredContent).toMatchObject({
    categories: expect.arrayContaining([
      expect.objectContaining({ id: food, name: 'Food', kind: 'expense' }),
    ]),
  });
  const empty = await client.callTool({ name: 'search_transactions', arguments: {} });
  expect(empty.structuredContent).toEqual({ transactions: [], nextBefore: null });
  const invalid = await client.callTool({ name: 'search_transactions', arguments: { limit: 51 } });
  expect(invalid.isError).toBe(true);
  expect(invalid.structuredContent).toBeUndefined();
  expect(await api.sql('SELECT email FROM profiles WHERE email = ?', email)).toEqual([]);
});

it('keeps tool responses out of caches and refuses a request from a different browser origin', async () => {
  const request = (origin: string) =>
    fetch(new URL('/api/mcp', api.base), {
      method: 'POST',
      headers: {
        'X-Dev-User': 'transport@example.test',
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Origin': origin,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

  const firstParty = await request(api.base);
  expect(firstParty.status).toBe(200);
  expect(firstParty.headers.get('cache-control')).toContain('no-store');
  const elsewhere = await request('https://other.example.test');
  expect(elsewhere.status).toBe(403);
});

const expense = (expectedAccount: string) => ({
  expectedAccount,
  requestId: rowId(501),
  accountId: wallet,
  categoryId: food,
  date: '2026-10-13',
  amountCents: 735,
  currency: 'MYR',
  payee: 'Market',
});

it('records an expense once when a writer loses the reply and retries the same request', async () => {
  const owner = 'repeat-expense@example.test';
  await seed(owner, [account(wallet, 'Wallet', 4000)]);
  let dropReply = false;
  const writer = await connect(owner, '/api/mcp/write', async (input, init) => {
    const response = await fetch(input, init);
    if (dropReply && init?.method === 'POST') {
      dropReply = false;
      await response.arrayBuffer();
      throw new TypeError('Expense reply lost');
    }
    return response;
  });
  const identity = await writer.callTool({ name: 'list_accounts' });
  expect(identity.structuredContent).toMatchObject({
    signedInAs: owner,
    accounts: [{ id: wallet, balanceCents: 4000 }],
  });
  const args = expense((identity.structuredContent as { signedInAs: string }).signedInAs);
  const record = { name: 'record_expense', arguments: args };
  const reader = await connect(owner);
  expect((await reader.callTool(record)).isError).toBe(true);
  const history = () => api.call(owner, 'GET', '/api/search?rowsOnly=1');
  expect((await history()).data.transactions).toEqual([]);

  dropReply = true;
  await expect(writer.callTool(record)).rejects.toThrow('Expense reply lost');
  const saved = {
    id: args.requestId,
    kind: 'expense',
    amountCents: 735,
    date: args.date,
    payee: 'Market',
  };
  expect((await history()).data.transactions).toMatchObject([saved]);

  const retry = await writer.callTool(record);
  expect(retry.structuredContent).toEqual({ transactionId: args.requestId });
  for (const change of [{ amountCents: 736 }, { currency: 'USD' }]) {
    const conflicting = await writer.callTool({
      ...record,
      arguments: { ...args, ...change },
    });
    expect(conflicting.isError).toBe(true);
    expect(conflicting.content).toMatchObject([
      { type: 'text', text: expect.stringMatching(/request id.*already used/i) },
    ]);
  }
  expect((await history()).data.transactions).toMatchObject([saved]);
  const balances = await reader.callTool({ name: 'list_accounts' });
  expect(balances.structuredContent).toMatchObject({
    accounts: [{ id: wallet, balanceCents: 3265 }],
  });
});

it('books a foreign-currency expense once when identical writer requests overlap', async () => {
  const owner = 'overlapping-expense@example.test';
  await seed(owner, [account(wallet, 'Wallet', 4000)]);
  const args = { ...expense(owner), currency: 'THB', amountCents: 2000 };
  const record = { name: 'record_expense', arguments: args };
  api.rates.setOn(args.date, 'THB', 'MYR', 0.25);
  const quote = api.rates.hold('THB', 'MYR');
  let waitingForSecondPost = false;
  try {
    const writer = await connect(owner, '/api/mcp/write', (input, init) => {
      const response = fetch(input, init);
      if (waitingForSecondPost && init?.method === 'POST') quote.release();
      return response;
    });
    const first = writer.callTool(record);
    await quote.reached;
    waitingForSecondPost = true;
    const outcomes = await Promise.all([first, writer.callTool(record)]);
    expect(outcomes.map((result) => result.structuredContent)).toEqual([
      { transactionId: args.requestId },
      { transactionId: args.requestId },
    ]);
  } finally {
    quote.release();
  }
  const after = await api.call(owner, 'GET', '/api/search?rowsOnly=1');
  expect(after.data.transactions).toMatchObject([
    { id: args.requestId, amountCents: 500, original: { currency: 'THB', cents: 2000 } },
  ]);
});

it('refuses an unexpected signer, unavailable accounts and invalid amounts or currencies without charging either ledger', async () => {
  const owner = 'verify-expense@example.test';
  const neighbor = 'other-expense@example.test';
  await seed(owner, [
    account(wallet, 'Open wallet', 4000),
    account(savings, 'Old wallet', 0),
    { op: 'archiveAccount', id: savings, archived: true },
  ]);
  const foreign = rowId(3);
  await seed(neighbor, [account(foreign, 'Travel purse', 1500)]);
  const writer = await connect(owner, '/api/mcp/write');
  const refusals = [
    [{ expectedAccount: neighbor }, /signed.in account changed/i],
    [{ accountId: foreign }, /account not found/i],
    [{ accountId: savings }, /archived/i],
    [{ amountCents: 0 }, /amountCents/i],
    [{ currency: 'ZZZ' }, /currency/i],
  ] as const;
  for (const [i, [change, reason]] of refusals.entries()) {
    const result = await writer.callTool({
      name: 'record_expense',
      arguments: { ...expense(owner), requestId: rowId(600 + i), ...change },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject([{ type: 'text', text: expect.stringMatching(reason) }]);
  }
  for (const email of [owner, neighbor]) {
    const after = await api.call(email, 'GET', '/api/search?rowsOnly=1');
    expect(after.data.transactions).toEqual([]);
  }
});
