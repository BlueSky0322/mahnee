import { expect, it } from 'vitest';
import { checkMcpWorker, provisionMcp } from './mcp-access.mjs';

const account = 'a'.repeat(32);
const browser = {
  id: 'b'.repeat(32),
  aud: 'f'.repeat(64),
  type: 'self_hosted',
  domain: 'budget.example.test',
};
const allow = {
  id: '2'.repeat(32),
  precedence: 7,
  decision: 'allow',
  include: [{ email_domain: { domain: 'example.test' } }],
};
const deny = {
  id: '3'.repeat(32),
  precedence: 2,
  decision: 'deny',
  include: [{ email: { email: 'former-member@example.test' } }],
};
const appsPath = '/access/apps';
const workerPath = '/workers/scripts/mahnee-mcp';
const host = 'mahnee-mcp.example.workers.dev';
const kvPath = '/storage/kv/namespaces';
const namespaceId = 'd'.repeat(32);
const versionId = 'a'.repeat(32);
const legacy = [
  { id: '4'.repeat(32), aud: '4'.repeat(64), name: 'Mahnee MCP read (managed)', path: host },
  {
    id: '5'.repeat(32),
    aud: '5'.repeat(64),
    name: 'Mahnee MCP write (managed)',
    path: host + '/api/mcp/write',
  },
];
const text = (name, text) => ({ name, type: 'plain_text', text });
const owner = text('MAHNEE_MCP_MANAGED', 'BlueSky0322/mahnee:mcp-v1');

function fixture() {
  const apps = [browser];
  const reads = new Map([
    ['/workers/subdomain', { subdomain: 'example' }],
    ['/workers/scripts', []],
    [appsPath, apps],
    [`${appsPath}/${browser.id}`, browser],
    [`${appsPath}/${browser.id}/policies`, [allow, deny]],
    ['/access/policies', [allow, deny]],
    [kvPath, []],
  ]);
  const writes = [];
  const ok = (result) => Response.json({ success: true, result });
  async function fetch(url, { method, body }) {
    const parsed = new URL(url);
    const path = parsed.pathname.slice(`/client/v4/accounts/${account}`.length);
    const page = reads.get(`${path}?page=${parsed.searchParams.get('page')}`);
    if (method === 'GET' && page) return Response.json({ success: true, ...page });
    if (method === 'GET' && reads.has(path)) return ok(reads.get(path));
    if (method !== 'GET') writes.push({ method, path, body: JSON.parse(body ?? 'null') });
    if (method === 'POST' && path === kvPath) {
      const namespace = { ...JSON.parse(body), id: namespaceId };
      reads.get(kvPath).push(namespace);
      return ok(namespace);
    }
    if (method === 'DELETE' && path.startsWith(appsPath + '/')) {
      const id = path.slice(appsPath.length + 1);
      apps.splice(
        apps.findIndex((app) => app.id === id),
        1,
      );
      return ok({ id });
    }
    if (method === 'POST' && path === appsPath) {
      const digit = String(6 + apps.length);
      const app = { ...JSON.parse(body), id: digit.repeat(32), aud: digit.repeat(64) };
      apps.push(app);
      reads.set(`${appsPath}/${app.id}`, app);
      reads.set(`${appsPath}/${app.id}/policies`, app.policies);
      return ok({ id: app.id });
    }
    throw new Error(`Unexpected fixture request: ${method} ${path}`);
  }
  return {
    apps,
    reads,
    writes,
    checkWorker: () => checkMcpWorker({ account, token: 'fixture', fetch }),
    run: (activate = false) =>
      provisionMcp({ account, token: 'fixture', browserAudience: browser.aud, fetch, activate }),
    addLegacy() {
      for (const { path, ...app } of legacy) {
        Object.assign(app, {
          type: 'self_hosted',
          destinations: [{ type: 'public', uri: path }],
          app_launcher_visible: false,
          oauth_configuration: {
            enabled: true,
            dynamic_client_registration: { allowed_uris: ['https://callback.example.test'] },
          },
        });
        apps.push(app);
        reads.set(`${appsPath}/${app.id}`, app);
        reads.set(`${appsPath}/${app.id}/policies`, [allow, deny]);
      }
    },
    deployed(aud, native = true) {
      const bindings = [owner];
      if (native) {
        bindings.push(
          text('MAHNEE_MCP_NATIVE_OAUTH', 'v1'),
          text('MCP_ORIGIN', 'https://' + host),
          text('ACCESS_CONSENT_AUD', aud),
          { name: 'OAUTH_KV', type: 'kv_namespace', namespace_id: namespaceId },
        );
      }
      reads.set('/workers/scripts', [{ id: 'mahnee-mcp' }]);
      reads.set(workerPath + '/settings', { bindings });
      reads.set(workerPath + '/deployments', {
        deployments: [{ versions: [{ version_id: versionId, percentage: 100 }] }],
      });
      reads.set(workerPath + '/versions/' + versionId, { resources: { bindings } });
    },
  };
}

it.each([false, true])(
  'checks Worker ownership without Access permissions (exists: %s)',
  async (exists) => {
    const cf = fixture();
    for (const path of cf.reads.keys()) {
      if (path.startsWith('/access/')) cf.reads.delete(path);
    }
    if (exists) {
      cf.reads.set('/workers/scripts', [{ id: 'mahnee-mcp' }]);
      cf.reads.set('/workers/scripts/mahnee-mcp/settings', {
        bindings: [
          { name: 'MAHNEE_MCP_MANAGED', type: 'plain_text', text: 'BlueSky0322/mahnee:mcp-v1' },
        ],
      });
    }
    expect(await cf.checkWorker()).toEqual({
      MCP_HOST: 'mahnee-mcp.example.workers.dev',
      MCP_WORKER_EXISTS: exists,
    });
    expect(cf.writes).toEqual([]);
  },
);

it('prepares a single human consent app and keeps both existing edge permissions until activation', async () => {
  const cf = fixture();
  cf.addLegacy();
  const prepared = await cf.run();
  expect(prepared).toEqual({
    MCP_HOST: host,
    ACCESS_CONSENT_AUD: expect.stringMatching(/^[\da-f]{64}$/),
    MCP_KV_ID: namespaceId,
  });
  expect(cf.writes.map(({ method, path }) => [method, path])).toEqual([
    ['POST', kvPath],
    ['POST', appsPath],
  ]);
  const { body } = cf.writes[1];
  expect(body.destinations.map(({ uri }) => uri)).toEqual([host + '/oauth/authorize']);
  expect(body.oauth_configuration).toEqual({ enabled: false });
  expect(body.policies).toEqual([
    { id: deny.id, precedence: 2 },
    { id: allow.id, precedence: 7 },
  ]);
  cf.writes.length = 0;
  expect(await cf.run()).toEqual(prepared);
  expect(cf.writes).toEqual([]);
});

it('only retires old applications after the native version serves all traffic, and can rerun', async () => {
  const cf = fixture();
  cf.addLegacy();
  const initial = await cf.run();
  cf.writes.length = 0;
  cf.deployed(initial.ACCESS_CONSENT_AUD, false);
  await expect(cf.run(true)).rejects.toThrow(/does not have the expected native/);
  expect(cf.writes).toEqual([]);
  cf.deployed(initial.ACCESS_CONSENT_AUD);
  const active = cf.reads.get(workerPath + '/deployments').deployments[0];
  active.versions[0].percentage = 90;
  active.versions.push({ version_id: 'c'.repeat(32), percentage: 10 });
  await expect(cf.run(true)).rejects.toThrow(/single version serving all MCP traffic/);
  expect(cf.writes).toEqual([]);
  cf.deployed(initial.ACCESS_CONSENT_AUD);
  expect(await cf.run(true)).toEqual(initial);
  expect(cf.writes.map(({ method, path }) => [method, path])).toEqual([
    ['DELETE', appsPath + '/' + legacy[1].id],
    ['DELETE', appsPath + '/' + legacy[0].id],
  ]);
  cf.writes.length = 0;
  expect(await cf.run(true)).toEqual(initial);
  expect(cf.writes).toEqual([]);
});

it('leaves an existing Worker with a different ownership marker untouched', async () => {
  const cf = fixture();
  cf.reads.set('/workers/scripts', [{ id: 'mahnee-mcp' }]);
  cf.reads.set('/workers/scripts/mahnee-mcp/settings', {
    bindings: [{ name: 'MAHNEE_MCP_MANAGED', type: 'plain_text', text: 'different-owner' }],
  });
  await expect(cf.checkWorker()).rejects.toThrow(/Worker name is already in use/);
  expect(cf.writes).toEqual([]);
});

it('leaves legacy and unrelated Access applications alone when the host protection differs', async () => {
  const cf = fixture();
  cf.addLegacy();
  cf.reads.set(`${appsPath}/${legacy[0].id}/policies`, [allow]);
  await expect(cf.run()).rejects.toThrow(/does not match/);
  expect(cf.writes).toEqual([]);
});

it('does not silently change an active Worker’s OAuth grant store', async () => {
  const cf = fixture();
  cf.deployed('7'.repeat(64));
  cf.reads.get(workerPath + '/settings').bindings.at(-1).namespace_id = 'e'.repeat(32);
  await expect(cf.run()).rejects.toThrow(/different OAuth KV namespace/);
  expect(cf.writes).toEqual([]);
});

it('reuses an OAuth namespace listed on a later server-sized KV page', async () => {
  const cf = fixture();
  const required = {
    id: namespaceId,
    title: 'mahnee-mcp-oauth-bluesky0322-1444093171',
  };
  cf.reads.set(`${kvPath}?page=1`, {
    result: [{ title: 'an unrelated namespace', id: 'e'.repeat(32) }],
    result_info: { page: 1, per_page: 1, count: 1, total_count: 2 },
  });
  cf.reads.set(`${kvPath}?page=2`, {
    result: [required],
    result_info: { page: 2, per_page: 1, count: 1, total_count: 2 },
  });
  expect((await cf.run()).MCP_KV_ID).toBe(namespaceId);
  expect(cf.writes.map(({ path }) => path)).toEqual([appsPath]);
});

it('leaves an exact legacy route app untouched when its audience is unrelated to the current Worker', async () => {
  const cf = fixture();
  cf.addLegacy();
  cf.deployed(undefined, false);
  cf.reads.get(workerPath + '/settings').bindings.push(text('ACCESS_MCP_AUD', 'a'.repeat(64)));
  await expect(cf.run()).rejects.toThrow(/does not match the audience/);
  expect(cf.writes).toEqual([]);
});
