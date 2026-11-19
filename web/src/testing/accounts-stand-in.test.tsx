// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import { fakeServer, renderApp, setupAppTests } from './app';

// The stand-in's account changes answer as the Worker's do (worker/ledger/changes.ts,
// worker/test/api.test.ts "accounts"), so screen tests see the same refusals.

setupAppTests();

const WALLET = 'a'.repeat(16);

const send = (changes: unknown[]) =>
  fetch('/api/changes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes, ids: changes.map((_, i) => String(i + 1).padStart(16, 'c')) }),
  });

describe("the stand-in's account changes", () => {
  test.each([
    ['no kind', null],
    ['a kind that does not exist', 'gold'],
    ['a kind that is not text', 7],
  ])('refuse a change to %s as the Worker does, saving nothing', async (_what, kind) => {
    const server = fakeServer();
    server.accounts.push({
      id: WALLET,
      name: 'Wallet',
      kind: 'cash',
      currency: 'MYR',
      openingCents: 100,
      position: 0,
      archived: false,
    });
    renderApp(server);
    const res = await send([{ op: 'updateAccount', id: WALLET, kind }]);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unknown kind of account' });
    expect(server.accounts[0]).toMatchObject({ kind: 'cash', openingCents: 100 });
  });
});
