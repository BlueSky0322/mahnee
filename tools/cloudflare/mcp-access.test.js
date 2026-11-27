import { expect, it } from 'vitest';
import { provisionMcp } from './mcp-access.mjs';

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

function fixture() {
  const apps = [browser];
  const reads = new Map([
    ['/workers/subdomain', { subdomain: 'example' }],
    ['/workers/scripts', []],
    [appsPath, apps],
    [`${appsPath}/${browser.id}`, browser],
    [`${appsPath}/${browser.id}/policies`, [allow, deny]],
    ['/access/policies', [allow, deny]],
  ]);
  const writes = [];
  const ok = (result) => Response.json({ success: true, result });
  async function fetch(url, { method, body }) {
    const path = new URL(url).pathname.slice(`/client/v4/accounts/${account}`.length);
    if (method === 'GET' && reads.has(path)) return ok(reads.get(path));
    if (method !== 'GET') writes.push({ method, path, body: JSON.parse(body ?? 'null') });
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
    run: () => provisionMcp({ account, token: 'fixture', browserAudience: browser.aud, fetch }),
  };
}

it('attaches the browser policy IDs to both roles in application precedence order and reuses them on retry', async () => {
  const cf = fixture();
  const roles = await cf.run();
  expect(roles.MCP_READ_AUD).not.toBe(roles.MCP_WRITE_AUD);
  expect(cf.writes.map(({ body }) => body.destinations[0].uri).sort()).toEqual([
    'mahnee-mcp.example.workers.dev',
    'mahnee-mcp.example.workers.dev/api/mcp/write',
  ]);
  for (const { body } of cf.writes) {
    expect(body.policies).toEqual([
      { id: deny.id, precedence: 2 },
      { id: allow.id, precedence: 7 },
    ]);
  }
  cf.writes.length = 0;
  expect(await cf.run()).toEqual(roles);
  expect(cf.writes).toEqual([]);
});

it('leaves an existing Worker with a different ownership marker untouched', async () => {
  const cf = fixture();
  cf.reads.set('/workers/scripts', [{ id: 'mahnee-mcp' }]);
  cf.reads.set('/workers/scripts/mahnee-mcp/settings', {
    bindings: [{ name: 'MAHNEE_MCP_MANAGED', type: 'plain_text', text: 'different-owner' }],
  });
  await expect(cf.run()).rejects.toThrow(/Worker name is already in use/);
  expect(cf.writes).toEqual([]);
});

it('refuses to create the missing writer when the existing reader has a different policy', async () => {
  const cf = fixture();
  const roles = await cf.run();
  const reader = cf.apps.find((app) => app.aud === roles.MCP_READ_AUD);
  cf.apps.splice(
    cf.apps.findIndex((app) => app.aud === roles.MCP_WRITE_AUD),
    1,
  );
  cf.reads.set(`${appsPath}/${reader.id}/policies`, [allow]);
  cf.writes.length = 0;
  await expect(cf.run()).rejects.toThrow(/does not match/);
  expect(cf.writes).toEqual([]);
});
