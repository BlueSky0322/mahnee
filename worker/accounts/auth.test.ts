import { afterEach, beforeAll, describe, expect, onTestFinished, test, vi } from 'vitest';
import { getSignIn, getUserEmail } from './auth';
import worker from '../index';
import mcpWorker from '../mcp/index';
import type { Env } from '../app';

const TEAM = 'mahnee.cloudflareaccess.com';
const AUD = 'app-audience-tag';
const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

const encode = (value: unknown) =>
  btoa(typeof value === 'string' ? value : JSON.stringify(value))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const bytesToBase64Url = (bytes: ArrayBuffer) =>
  encode(String.fromCharCode(...new Uint8Array(bytes)));

const generateKey = () =>
  crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  ) as Promise<CryptoKeyPair>;

let teamKey: CryptoKeyPair;
let otherKey: CryptoKeyPair;

const CERTS_URL = `https://${TEAM}/cdn-cgi/access/certs`;

/** The team's published key set, as Access serves it at CERTS_URL */
const publishedKeys = async (...keys: [CryptoKeyPair, string][]) =>
  Response.json({
    keys: await Promise.all(
      keys.map(async ([pair, kid]) => ({
        ...(await crypto.subtle.exportKey('jwk', pair.publicKey)),
        kid,
      })),
    ),
  });

async function sign(payload: Record<string, unknown>, key = teamKey, kid = 'team-key') {
  const unsigned = `${encode({ alg: 'RS256', kid, typ: 'JWT' })}.${encode(payload)}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key.privateKey,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${bytesToBase64Url(signature)}`;
}

const validClaims = () => ({
  iss: `https://${TEAM}`,
  aud: [AUD],
  email: 'Ryan@Example.com',
  exp: Math.floor(Date.now() / 1000) + 600,
  iat: Math.floor(Date.now() / 1000),
});

const requestWith = (token?: string, headers: Record<string, string> = {}) =>
  new Request('https://mahnee.example/api/me', {
    headers: token ? { 'Cf-Access-Jwt-Assertion': token, ...headers } : headers,
  });

/** Access publishing just the team key */
const defaultFetch = (url: string | URL | Request) =>
  (url instanceof Request ? url.url : url.toString()) === CERTS_URL
    ? publishedKeys([teamKey, 'team-key'])
    : Promise.resolve(new Response('not found', { status: 404 }));

beforeAll(async () => {
  teamKey = await generateKey();
  otherKey = await generateKey();
  vi.stubGlobal('fetch', vi.fn(defaultFetch));
});

afterEach(() => {
  vi.mocked(fetch).mockClear();
});

describe('getUserEmail with Cloudflare Access configured', () => {
  test('accepts a valid Access token and returns its email, lowercased', async () => {
    expect(await getUserEmail(requestWith(await sign(validClaims())), env)).toBe(
      'ryan@example.com',
    );
  });

  test('also reads the token from the CF_Authorization cookie', async () => {
    const token = await sign(validClaims());
    const req = new Request('https://mahnee.example/api/me', {
      headers: { Cookie: `other=1; CF_Authorization=${token}` },
    });
    expect(await getUserEmail(req, env)).toBe('ryan@example.com');
  });

  // Each case changes one thing about an otherwise valid token
  test.each([
    ['another Access app (wrong audience)', async () => sign({ ...validClaims(), aud: ['other'] })],
    [
      'another team (wrong issuer)',
      async () => sign({ ...validClaims(), iss: 'https://evil.cloudflareaccess.com' }),
    ],
    [
      'an expired token',
      async () => sign({ ...validClaims(), exp: Math.floor(Date.now() / 1000) - 1 }),
    ],
    [
      'a token not valid yet',
      async () => sign({ ...validClaims(), nbf: Math.floor(Date.now() / 1000) + 600 }),
    ],
    ['a token with an empty email', async () => sign({ ...validClaims(), email: '' })],
    ['a token signed by another key under the team kid', async () => sign(validClaims(), otherKey)],
    ['a token signed by an unknown key', async () => sign(validClaims(), otherKey, 'unknown-kid')],
    [
      'a token whose claims were edited after signing',
      async () => {
        const [header, , signature] = (await sign(validClaims())).split('.');
        return `${header}.${encode({ ...validClaims(), email: 'attacker@example.com' })}.${signature}`;
      },
    ],
    ['a malformed token', () => Promise.resolve('not-a-jwt')],
    ['a token whose parts are not base64url JSON', () => Promise.resolve('a!b.c!d.e!f')],
  ])('rejects %s', async (_name, makeToken) => {
    expect(await getUserEmail(requestWith(await makeToken()), env)).toBeNull();
  });

  test("fails loudly, rather than signing out, when the team's keys can't be fetched", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('down', { status: 503 }));
    await expect(
      getUserEmail(requestWith(await sign(validClaims(), otherKey, 'rotated-key')), env),
    ).rejects.toThrow('Access certs fetch failed');
  });

  test('rejects a request with no token', async () => {
    expect(await getUserEmail(requestWith(), env)).toBeNull();
  });

  test('ignores the local-dev X-Dev-User override', async () => {
    const devEnv = { ...env, DEV_USER_EMAIL: 'dev@example.com' };
    expect(
      await getUserEmail(requestWith(undefined, { 'X-Dev-User': 'a@b.c' }), devEnv),
    ).toBeNull();
  });
});

describe("the team's signing keys", () => {
  const HOUR = 60 * 60 * 1000;

  test('accepts a token signed with a newly published key once the key set changes', async () => {
    // Access has rotated: the new key is published alongside the old one
    vi.mocked(fetch).mockImplementationOnce(() =>
      publishedKeys([teamKey, 'team-key'], [otherKey, 'next-key']),
    );
    const token = await sign(validClaims(), otherKey, 'next-key');
    expect(await getUserEmail(requestWith(token), env)).toBe('ryan@example.com');
    expect(fetch).toHaveBeenCalledWith(
      CERTS_URL,
      expect.objectContaining({ signal: expect.anything() }),
    );

    // The new key is now known, so it is not fetched again
    vi.mocked(fetch).mockClear();
    expect(await getUserEmail(requestWith(token), env)).toBe('ryan@example.com');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('stops accepting a retired key once the key set is next fetched', async () => {
    // Its own key id: the rotation case's 'next-key' may already be kept from before
    vi.mocked(fetch).mockImplementation(() => publishedKeys([otherKey, 'retirement-key']));
    try {
      // A token naming a key not kept yet makes the key set be fetched again
      await getUserEmail(requestWith(await sign(validClaims(), otherKey, 'unseen-key')), env);
      expect(await getUserEmail(requestWith(await sign(validClaims())), env)).toBeNull();
    } finally {
      vi.mocked(fetch).mockReset().mockImplementation(defaultFetch);
    }
  });

  test('made-up key ids make it fetch the key set only so often', async () => {
    vi.mocked(fetch).mockClear();
    // Two minutes on, so the last minute's fetches by the tests before are over, and
    // the key set is still within its hour
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 60 * 1000);
    onTestFinished(() => clock.mockRestore());
    const madeUp = (kid: string) =>
      sign(validClaims(), otherKey, kid).then((t) => getUserEmail(requestWith(t), env));
    // Several at once each fetch, each counting towards the limit, and are each refused
    expect(await Promise.all([madeUp('fake-1'), madeUp('fake-2'), madeUp('fake-3')])).toEqual([
      null,
      null,
      null,
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
    // One found missing isn't fetched for again
    await madeUp('fake-1');
    expect(fetch).toHaveBeenCalledTimes(3);
    // New ones only so many times a minute, however many there are
    for (let i = 0; i < 20; i++) await madeUp(`flood-${i}`);
    expect(vi.mocked(fetch).mock.calls.length).toBeLessThanOrEqual(6);
  });

  test('keeps the key set for an hour, then fetches it again', async () => {
    const start = Date.now() + 2 * HOUR;
    const clock = vi.spyOn(Date, 'now');
    try {
      // Anything kept before `start` is over an hour old by then, so this fetches
      clock.mockReturnValue(start);
      expect(await getUserEmail(requestWith(await sign(validClaims())), env)).toBe(
        'ryan@example.com',
      );
      expect(fetch).toHaveBeenCalledTimes(1);

      clock.mockReturnValue(start + HOUR - 1);
      expect(await getUserEmail(requestWith(await sign(validClaims())), env)).toBe(
        'ryan@example.com',
      );
      expect(fetch).toHaveBeenCalledTimes(1);

      clock.mockReturnValue(start + HOUR);
      expect(await getUserEmail(requestWith(await sign(validClaims())), env)).toBe(
        'ryan@example.com',
      );
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  test("a request whose key fetch never finishes doesn't hold up the next", async () => {
    // Over an hour after anything kept, so both requests need the key set
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * HOUR);
    onTestFinished(() => clock.mockRestore());
    // The first request ends (the page was closed) while its fetch is still out, so the
    // fetch never finishes
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(() => {}));
    void getUserEmail(requestWith(await sign(validClaims())), env);

    expect(await getUserEmail(requestWith(await sign(validClaims())), env)).toBe(
      'ryan@example.com',
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

function entryRequest(url: string, token?: string, extraHeaders?: Record<string, string>) {
  const headers = {
    ...extraHeaders,
    ...(token && { 'Cf-Access-Jwt-Assertion': token }),
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    },
  };
  return new Request<unknown, IncomingRequestCfProperties>(url, {
    headers,
    ...(new URL(url).pathname.startsWith('/api/mcp') && {
      method: 'POST',
      body: JSON.stringify(initialize),
    }),
  });
}

async function entryStatus(path: string, bindings: Partial<Env>, token?: string) {
  const response = await worker.fetch(
    entryRequest(`https://mahnee.example${path}`, token),
    { REQUIRE_EXPECTED_ACCOUNT: 'true', ...bindings } as Env,
    {} as ExecutionContext,
  );
  return response.status;
}

async function dedicatedStatus(path: string, bindings: Partial<Env>, token?: string) {
  const request = entryRequest(`https://mahnee-mcp.example${path}`, token, {
    'X-Dev-User': 'local@example.com',
  });
  return (await mcpWorker.fetch(request, bindings as Env)).status;
}

describe('the dedicated MCP Worker', () => {
  const dedicated = { ...env, ACCESS_MCP_AUD: 'mcp-read', ACCESS_MCP_WRITE_AUD: 'mcp-write' };

  test.each([
    ['/api/mcp', 'ACCESS_MCP_AUD', 'ACCESS_MCP_WRITE_AUD'],
    ['/api/mcp/write', 'ACCESS_MCP_WRITE_AUD', 'ACCESS_MCP_AUD'],
  ] as const)('%s accepts only its own dedicated audience', async (path, own, other) => {
    const ownToken = await sign({ ...validClaims(), aud: [dedicated[own]] });
    expect(await dedicatedStatus(path, dedicated, ownToken)).toBe(200);
    for (const audience of [AUD, dedicated[other]]) {
      const token = await sign({ ...validClaims(), aud: [audience] });
      expect(await dedicatedStatus(path, dedicated, token), audience).toBe(401);
    }
    for (const misconfigured of [
      { ...dedicated, [own]: '' },
      { ...dedicated, ACCESS_AUD: dedicated[own] },
      { ...dedicated, [other]: dedicated[own] },
    ]) {
      expect(await dedicatedStatus(path, misconfigured, ownToken)).toBe(401);
    }
    expect(
      await dedicatedStatus(path, { DEV_USER_EMAIL: 'local@example.com', DEV_MCP_WRITES: 'true' }),
    ).toBe(401);
  });

  test('keeps ordinary application routes off the dedicated origin', async () => {
    const token = await sign(validClaims());
    expect(await dedicatedStatus('/api/me', dedicated, token)).toBe(404);
  });
});

test('the Worker accepts web, read, and write credentials only at their own entry points', async () => {
  const readAudience = 'mcp-read-audience';
  const writeAudience = 'mcp-write-audience';
  const bindings = { ...env, ACCESS_MCP_AUD: readAudience, ACCESS_MCP_WRITE_AUD: writeAudience };
  const endpoints = ['/api/push', '/api/mcp', '/api/mcp/write'];
  for (const [index, aud] of [AUD, readAudience, writeAudience].entries()) {
    const token = await sign({ ...validClaims(), aud: [aud] });
    for (const [endpoint, path] of endpoints.entries()) {
      expect(await entryStatus(path, bindings, token), `${aud} at ${path}`).toBe(
        index === endpoint ? 200 : 401,
      );
    }
  }

  // Ordinary Access login for reads still works when a dedicated read audience is absent.
  expect(await entryStatus('/api/mcp', env, await sign(validClaims()))).toBe(200);
});

test('a missing or reused write audience keeps writes off', async () => {
  const readAudience = 'mcp-read-audience';
  for (const writeAudience of [undefined, AUD, readAudience]) {
    const token = await sign({ ...validClaims(), aud: [writeAudience ?? AUD] });
    expect(
      await entryStatus(
        '/api/mcp/write',
        {
          ...env,
          ACCESS_MCP_AUD: readAudience,
          ACCESS_MCP_WRITE_AUD: writeAudience,
        },
        token,
      ),
    ).toBe(401);
  }
});

test('local MCP writes require the dev account, explicit opt-in, and no Access settings', async () => {
  const local = { DEV_USER_EMAIL: 'local@example.com', DEV_MCP_WRITES: 'true' };
  expect(await entryStatus('/api/mcp/write', local)).toBe(200);
  expect(await entryStatus('/api/mcp/write', { DEV_USER_EMAIL: local.DEV_USER_EMAIL })).toBe(401);
  expect(await entryStatus('/api/mcp/write', { DEV_MCP_WRITES: 'true' })).toBe(401);
  expect(await entryStatus('/api/mcp/write', { ...local, ACCESS_MCP_WRITE_AUD: 'mcp-write' })).toBe(
    401,
  );
});

describe('getUserEmail configuration', () => {
  test('verifies tokens only when both the team domain and the audience are set', async () => {
    const token = await sign(validClaims());
    expect(await getUserEmail(requestWith(token), env)).toBe('ryan@example.com');
    // The team domain may be given as a URL
    expect(
      await getUserEmail(requestWith(token), { ...env, ACCESS_TEAM_DOMAIN: `https://${TEAM}/` }),
    ).toBe('ryan@example.com');
  });

  test.each([
    ['only the team domain is set', { ACCESS_TEAM_DOMAIN: TEAM }],
    ['only the audience is set', { ACCESS_AUD: AUD }],
    ['both are blank', { ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' }],
    ['nothing is set', {}],
  ])('refuses everyone, even with a valid token, when %s', async (_name, partial) => {
    const token = await sign(validClaims());
    expect(await getUserEmail(requestWith(token, { 'X-Dev-User': 'a@b.c' }), partial)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  // A deploy missing one Access value must not fall back to the local dev user, or
  // anyone could name themselves with X-Dev-User
  test.each([
    ['only the team domain is set', { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: '' }],
    ['only the audience is set', { ACCESS_AUD: AUD }],
    ['only the MCP audience is set', { ACCESS_MCP_AUD: 'mcp-audience-tag' }],
    ['only the MCP write audience is set', { ACCESS_MCP_WRITE_AUD: 'mcp-write-audience' }],
  ])('refuses everyone when %s, even with a local dev user set', async (_name, partial) => {
    const halfSet = { ...partial, DEV_USER_EMAIL: 'dev@example.com' };
    expect(
      await getUserEmail(requestWith(undefined, { 'X-Dev-User': 'a@b.c' }), halfSet),
    ).toBeNull();
    expect(await getUserEmail(requestWith(), halfSet)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('the Google picture a sign-in names', () => {
  const PICTURE = 'https://lh3.googleusercontent.com/a/photo=s96-c';

  test("reads it from the token's custom claims, where Access puts the IdP's picture claim", async () => {
    const token = await sign({ ...validClaims(), custom: { picture: PICTURE } });
    expect(await getSignIn(requestWith(token), env)).toEqual({
      email: 'ryan@example.com',
      picture: PICTURE,
    });
  });

  test.each([
    ['no custom claims', {}],
    ['custom claims without a picture', { custom: { groups: ['x'] } }],
    ['a picture that is not text', { custom: { picture: 42 } }],
    ['custom claims that are not an object', { custom: 'picture' }],
  ])('names none with %s', async (_what, extra) => {
    const token = await sign({ ...validClaims(), ...extra });
    expect(await getSignIn(requestWith(token), env)).toEqual({
      email: 'ryan@example.com',
      picture: null,
    });
  });

  test('ignores the local-dev X-Dev-Picture under Access, and takes it locally', async () => {
    const token = await sign(validClaims());
    expect(
      (await getSignIn(requestWith(token, { 'X-Dev-Picture': PICTURE }), env))?.picture,
    ).toBeNull();
    const devEnv = { DEV_USER_EMAIL: 'dev@example.com' };
    expect(await getSignIn(requestWith(undefined, { 'X-Dev-Picture': PICTURE }), devEnv)).toEqual({
      email: 'dev@example.com',
      picture: PICTURE,
    });
  });
});

describe('getUserEmail without Cloudflare Access configured', () => {
  test('refuses everyone unless a local dev user is set', async () => {
    expect(await getUserEmail(requestWith(undefined, { 'X-Dev-User': 'a@b.c' }), {})).toBeNull();
  });

  test('uses the local dev user when .dev.vars blanks the Access values', async () => {
    const localEnv = { ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', DEV_USER_EMAIL: 'you@example.com' };
    expect(await getUserEmail(requestWith(), localEnv)).toBe('you@example.com');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('uses the local dev user, overridable per request', async () => {
    const devEnv = { DEV_USER_EMAIL: 'Dev@Example.com' };
    expect(await getUserEmail(requestWith(), devEnv)).toBe('dev@example.com');
    expect(
      await getUserEmail(requestWith(undefined, { 'X-Dev-User': 'Sam@Example.com' }), devEnv),
    ).toBe('sam@example.com');
  });
});

describe('signing in to the API', () => {
  const callApi = (headers: Record<string, string> = {}) =>
    worker.fetch(
      new Request('https://mahnee.example/api/no-such-route', { headers }),
      env as unknown as Env,
      {} as ExecutionContext,
    );

  test.each([
    ['no token', () => Promise.resolve({})],
    [
      'an invalid token',
      async () => ({ 'Cf-Access-Jwt-Assertion': await sign(validClaims(), otherKey) }),
    ],
  ])('answers 401 Not signed in for %s', async (_name, makeHeaders) => {
    const res = await callApi(await makeHeaders());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Not signed in' });
  });

  test('lets a valid token through to the routes', async () => {
    const res = await callApi({ 'Cf-Access-Jwt-Assertion': await sign(validClaims()) });
    expect(res.status).toBe(404);
  });

  test("answers 500, not 401, when the team's keys can't be fetched", async () => {
    // Well after the key set tests, so the fetches they made for unknown ids don't count
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3 * 60 * 60 * 1000);
    onTestFinished(() => clock.mockRestore());
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(fetch).mockResolvedValueOnce(new Response('down', { status: 503 }));
    const res = await callApi({
      'Cf-Access-Jwt-Assertion': await sign(validClaims(), otherKey, 'failing-key'),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Something went wrong. Try again in a moment.' });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
