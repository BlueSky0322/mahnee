// The API end to end, against the real Worker and a fresh local database: who's signed
// in, their profile and settings, exchange rates, and the safeguards every write passes.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { LocalWorker } from './local-worker';
import { startLocalWorker } from './local-worker';
import { rateDay } from '../../shared/rates';

let api: LocalWorker;
let n = 0;
// Fresh accounts for each test, so tests don't see each other's data
const person = (name: string) => `${name}${++n}@example.com`;

// Within the harness's own limits: migrations, then the Worker starting
beforeAll(async () => {
  api = await startLocalWorker();
}, 180_000);

// Each test sets the rates it needs
afterEach(() => api.rates.reset());

afterAll(() => api?.stop(), 30_000);

describe('the profile', () => {
  it('starts with the defaults, before anything is saved', async () => {
    const me = person('me');
    const { status, data } = await api.call(me, 'GET', '/api/me');
    expect(status).toBe(200);
    expect(data).toEqual({
      email: me,
      displayName: null,
      settings: { theme: 'auto', accent: 'blurple', ratePreference: 'wise' },
    });
  });

  it('saves a display name and settings, for that account alone', async () => {
    const me = person('me');
    const other = person('other');
    const saved = await api.call(me, 'PATCH', '/api/me', {
      displayName: '  Mei  ',
      settings: { theme: 'light' },
    });
    expect(saved.status).toBe(200);
    expect(saved.data).toMatchObject({ displayName: 'Mei', settings: { theme: 'light' } });
    // A later change keeps what it doesn't name
    await api.call(me, 'PATCH', '/api/me', { settings: { accent: 'teal' } });
    expect((await api.call(me, 'GET', '/api/me')).data).toMatchObject({
      displayName: 'Mei',
      settings: { theme: 'light', accent: 'teal', ratePreference: 'wise' },
    });
    expect((await api.call(other, 'GET', '/api/me')).data.displayName).toBeNull();
    // An empty name clears it
    await api.call(me, 'PATCH', '/api/me', { displayName: '' });
    expect((await api.call(me, 'GET', '/api/me')).data.displayName).toBeNull();
  });

  it.each<[string, object]>([
    ['an unknown setting', { settings: { sidebarOpen: false } }],
    ['a theme that does not exist', { settings: { theme: 'sepia' } }],
    ['a rate source that does not exist', { settings: { ratePreference: 'xe' } }],
    ['settings that are not a list of settings', { settings: ['theme'] }],
    ['a name that is too long', { displayName: 'x'.repeat(33) }],
    ['a name that is not text', { displayName: 42 }],
  ])('refuses %s and saves nothing', async (_what, patch) => {
    const me = person('me');
    await api.call(me, 'PATCH', '/api/me', { displayName: 'Mei' });
    const res = await api.call(me, 'PATCH', '/api/me', patch);
    expect(res.status).toBe(400);
    expect(typeof res.data.error).toBe('string');
    expect((await api.call(me, 'GET', '/api/me')).data).toMatchObject({
      displayName: 'Mei',
      settings: { theme: 'auto', ratePreference: 'wise' },
    });
  });
});

describe('exchange rates', () => {
  // The Worker keeps the rates it fetches for hours, for every test after: these tests
  // look at which service a rate came from, so each uses currencies of its own
  it('converts with Wise, falls back to Frankfurter, and says when neither has a rate', async () => {
    const me = person('me');
    const [first, second] = [api.rates.newCurrency(), api.rates.newCurrency()];
    api.rates.set(first, 'MYR', 4.2);
    const res = await api.call(
      me,
      'GET',
      `/api/rates?from=${first.toLowerCase()}&to=MYR&amount=10.5`,
    );
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ from: first, to: 'MYR', rate: 4.2, source: 'wise' });
    expect(res.data.convertedCents).toBe(4410);

    api.rates.set(second, 'MYR', 3.3);
    api.rates.down('wise', true);
    const fallback = await api.call(me, 'GET', `/api/rates?from=${second}&to=MYR`);
    api.rates.down('wise', false);
    expect(fallback.data).toMatchObject({ rate: 3.3, source: 'frankfurter' });

    expect((await api.call(me, 'GET', '/api/rates?from=XXX&to=MYR')).status).toBe(503);
  });

  it('uses the rate source each person picked', async () => {
    const wiseFan = person('wisefan');
    const ecbFan = person('ecbfan');
    const nzd = api.rates.newCurrency();
    // The two services differ, so each answer shows where it came from
    api.rates.set(nzd, 'MYR', 2.75, 'wise');
    api.rates.set(nzd, 'MYR', 2.7, 'frankfurter');
    await api.call(ecbFan, 'PATCH', '/api/me', { settings: { ratePreference: 'ecb' } });
    expect((await api.call(ecbFan, 'GET', `/api/rates?from=${nzd}&to=MYR`)).data).toMatchObject({
      rate: 2.7,
      source: 'frankfurter',
    });
    expect((await api.call(wiseFan, 'GET', `/api/rates?from=${nzd}&to=MYR`)).data).toMatchObject({
      rate: 2.75,
      source: 'wise',
    });
  });

  it("gives an earlier day's rate, said to be from that day", async () => {
    const me = person('me');
    const cur = api.rates.newCurrency();
    const at = Date.parse(`${rateDay(Date.now() - 3 * 864e5)}T12:00:00Z`);
    api.rates.set(cur, 'MYR', 4);
    api.rates.setOn(rateDay(at), cur, 'MYR', 3);
    const res = await api.call(me, 'GET', `/api/rates?from=${cur}&to=MYR&at=${at}`);
    expect(res.data).toMatchObject({ rate: 3, source: 'frankfurter', fetchedAt: at });
  });

  it.each([
    'from=US&to=MYR',
    'from=USD&to=MYR&amount=-1',
    'from=USD&to=MYR&amount=abc',
    'from=USD&to=MYR&amount=1000000001',
    `from=USD&to=MYR&at=${Date.now() + 7 * 864e5}`,
    'from=USD&to=MYR&at=0',
  ])('refuses %s', async (query) => {
    expect((await api.call(person('me'), 'GET', `/api/rates?${query}`)).status).toBe(400);
  });
});

describe('safeguards', () => {
  it('refuses changes started by another site, but not reads or the app itself', async () => {
    const me = person('me');
    const rename = (headers: Record<string, string>) =>
      api.call(me, 'PATCH', '/api/me', { displayName: 'Taken' }, headers);
    expect((await rename({ 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await rename({ Origin: 'https://evil.example' })).status).toBe(403);
    expect((await api.call(me, 'GET', '/api/me')).data.displayName).toBeNull();
    // The same write from the app's own page goes through, whichever header says so
    expect((await rename({ Origin: api.base })).status).toBe(200);
    expect((await rename({ 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200);
    // Reads are fine from anywhere
    expect(
      (await api.call(me, 'GET', '/api/me', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status,
    ).toBe(200);
  });

  it('limits how many changes an account makes a minute, but never reading', async () => {
    const busy = person('busy');
    // Write until refused. The limit counts per minute window, and a run can straddle
    // two windows, so up to 130 writes: at least one window then sees more than 60.
    let accepted = 0;
    let refused = false;
    for (let i = 0; i < 130 && !refused; i++) {
      const theme = i % 2 === 0 ? 'light' : 'dark';
      const { status } = await api.call(busy, 'PATCH', '/api/me', { settings: { theme } });
      if (status === 429) refused = true;
      else if (status === 200) accepted++;
    }
    expect(refused).toBe(true);
    expect(accepted).toBeGreaterThanOrEqual(60);
    expect((await api.call(busy, 'GET', '/api/me')).status).toBe(200);
    // Someone else isn't held back
    expect((await api.call(person('calm'), 'PATCH', '/api/me', { displayName: 'C' })).status).toBe(
      200,
    );
  });

  it('turns away request bodies that are too large, or are not JSON', async () => {
    const me = person('me');
    const huge = await api.call(me, 'PATCH', '/api/me', { displayName: 'x'.repeat(300_000) });
    expect(huge.status).toBe(413);
    const garbled = await api.call(me, 'PATCH', '/api/me', '{not json', {
      'Content-Type': 'application/json',
    });
    expect(garbled).toEqual({ status: 400, data: { error: 'Invalid JSON' } });
  });

  it('answers unknown API paths with a JSON 404', async () => {
    const res = await api.call(person('x'), 'GET', '/api/nope');
    expect(res.status).toBe(404);
    expect(res.data.error).toBe('Not found');
  });
});

describe('saying whose a write is', () => {
  it('refuses a write made as another account before changing anything', async () => {
    const me = person('me');
    const other = person('other');
    const renameAs = (expected: string) =>
      api.call(me, 'PATCH', '/api/me', { displayName: 'Mei' }, { 'X-Expected-Account': expected });

    const refused = await renameAs(other);
    expect(refused).toEqual({
      status: 409,
      data: { error: 'Signed in as someone else.', code: 'account_mismatch' },
    });
    expect((await api.call(me, 'GET', '/api/me')).data.displayName).toBeNull();

    // The account signed in, however it's written, is saved
    expect((await renameAs(` ${me.toUpperCase()} `)).status).toBe(200);
    expect((await api.call(me, 'GET', '/api/me')).data.displayName).toBe('Mei');
  });

  it('still saves a write that says nothing, from apps from before it, while that is allowed', async () => {
    const me = person('me');
    expect((await api.call(me, 'PATCH', '/api/me', { displayName: 'Mei' })).status).toBe(200);
  });
});
