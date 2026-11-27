import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const apiRoot = 'https://api.cloudflare.com/client/v4';
const readName = 'Mahnee MCP read (managed)';
const writeName = 'Mahnee MCP write (managed)';
const writePath = '/api/mcp/write';
const workerName = 'mahnee-mcp';
const ownership = 'BlueSky0322/mahnee:mcp-v1';
const audienceTag = /^[a-f\d]{64}$/i;
const accountId = /^[a-f\d]{32}$/i;
const workerSubdomain = /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/;
const browserFields = [
  'allowed_idps',
  'allow_authenticate_via_warp',
  'auto_redirect_to_identity',
  'mfa_config',
  'session_duration',
];

class ProvisionError extends Error {}

const abort = (message) => {
  throw new ProvisionError(message);
};

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function pickOwn(object, keys) {
  return Object.fromEntries(
    keys.filter((key) => object[key] != null).map((key) => [key, object[key]]),
  );
}

function client(account, token, fetch) {
  async function request(operation, path, method = 'GET', body) {
    let response;
    try {
      response = await fetch(`${apiRoot}/accounts/${account}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body == null ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body == null ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      abort(`${operation}: Cloudflare request failed or timed out.`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      abort(`${operation}: Cloudflare returned HTTP ${response.status} without JSON.`);
    }
    if (!response.ok || payload?.success !== true) {
      const code = payload?.errors?.[0]?.code;
      const permission = path.startsWith('/workers/')
        ? 'Workers Scripts Read or Write'
        : 'Access: Apps and Policies Write';
      const hint =
        response.status === 401 || response.status === 403
          ? ` Check the token and its ${permission} permission on this account.`
          : '';
      const numericCode = Number.isSafeInteger(code) ? `, API code ${code}` : '';
      abort(`${operation}: Cloudflare returned HTTP ${response.status}${numericCode}.${hint}`);
    }
    return payload;
  }

  async function list(operation, path) {
    const all = [];
    for (let page = 1; page <= 200; page++) {
      const { result, result_info: info } = await request(
        operation,
        `${path}?page=${page}&per_page=50`,
      );
      if (!Array.isArray(result)) abort(`${operation}: Cloudflare returned an invalid list.`);
      all.push(...result);
      if (Number.isSafeInteger(info?.total_pages)) {
        if (page >= info.total_pages) return all;
      } else if (result.length < 50) {
        return all;
      }
    }
    abort(`${operation}: Cloudflare pagination could not be verified.`);
  }

  return { request, list };
}

const publicUri = (uri) =>
  typeof uri === 'string'
    ? uri
        .replace(/^https:\/\//i, '')
        .replace(/\/$/, '')
        .toLowerCase()
    : '';

function appUris(app) {
  return [
    app.domain,
    ...(app.self_hosted_domains ?? []),
    ...(app.destinations ?? []).filter((item) => item.type === 'public').map((item) => item.uri),
  ].map(publicUri);
}

function browserAdmission(app) {
  return {
    ...pickOwn(app, browserFields),
    allowed_idps: [...(app.allowed_idps ?? [])].sort(),
    auto_redirect_to_identity: app.auto_redirect_to_identity === true,
  };
}

function exactDestination(app, destination) {
  const actual = (app.destinations ?? []).map((item) => ({
    type: item.type,
    uri: publicUri(item.uri),
    overrides: item.overrides ?? [],
  }));
  return (
    app.type === 'self_hosted' &&
    same(actual, [{ type: 'public', uri: destination, overrides: [] }]) &&
    appUris(app)
      .filter(Boolean)
      .every((uri) => uri === destination)
  );
}

function rereadOrder(policies) {
  if (!policies.every((policy) => Number.isSafeInteger(policy.precedence))) {
    abort('Cloudflare did not return a verifiable Access policy order.');
  }
  if (new Set(policies.map(({ precedence }) => precedence)).size !== policies.length) {
    abort('Cloudflare returned duplicate Access policy precedence.');
  }
  return [...policies].sort((a, b) => a.precedence - b.precedence);
}

function safeSource(policy) {
  if (!['allow', 'deny'].includes(policy.decision)) {
    abort('The browser Access application has a policy that cannot be reused safely.');
  }
  for (const key of ['include', 'exclude', 'require']) {
    const rules = policy[key] ?? [];
    if (!Array.isArray(rules) || rules.some((rule) => rule == null || typeof rule !== 'object')) {
      abort('The browser Access application returned invalid policy selectors.');
    }
    if (rules.some((rule) => 'service_token' in rule || 'any_valid_service_token' in rule)) {
      abort('The browser Access application uses a service-token selector.');
    }
  }
  if (policy.decision === 'allow' && !(policy.include?.length > 0)) {
    abort('An allow policy on the browser Access application has no selectors.');
  }
}

export async function provisionMcp({ account, token, browserAudience, fetch }) {
  if (
    !accountId.test(account ?? '') ||
    typeof token !== 'string' ||
    !token ||
    !audienceTag.test(browserAudience ?? '')
  ) {
    abort('Missing or invalid Cloudflare deployment credentials or browser audience.');
  }
  const cf = client(account, token, fetch);
  const appPath = '/access/apps';
  const [{ result: subdomain }, apps, { result: scripts }] = await Promise.all([
    cf.request('Read the account Workers subdomain', '/workers/subdomain'),
    cf.list('List Access applications', appPath),
    cf.request('Check the intended Worker name', '/workers/scripts'),
  ]);
  if (!workerSubdomain.test(subdomain?.subdomain ?? '')) {
    abort('Cloudflare did not return a valid Workers subdomain.');
  }
  const host = `${workerName}.${subdomain.subdomain}.workers.dev`;
  if (!Array.isArray(scripts) || scripts.some((script) => typeof script?.id !== 'string')) {
    abort('Cloudflare did not return a verifiable list of Worker names.');
  }
  if (scripts.some((script) => script.id === workerName)) {
    const { result } = await cf.request(
      'Verify ownership of the existing MCP Worker',
      `/workers/scripts/${workerName}/settings`,
    );
    const marker = result?.bindings?.filter(({ name }) => name === 'MAHNEE_MCP_MANAGED');
    if (marker?.length !== 1 || marker[0].type !== 'plain_text' || marker[0].text !== ownership) {
      abort('The intended MCP Worker name is already in use without the Mahnee ownership marker.');
    }
  }

  const idFor = (app) => {
    const id = app.id;
    if (typeof id !== 'string' || !/^[a-f\d-]{32,36}$/i.test(id)) {
      abort('Cloudflare did not return a valid Access application ID.');
    }
    return id;
  };
  const getApp = async (id, purpose) => (await cf.request(purpose, `${appPath}/${id}`)).result;
  const policies = (id) => cf.list('Read Access application policies', `${appPath}/${id}/policies`);
  const matches = apps.filter((app) => app.aud === browserAudience);
  if (matches.length !== 1)
    abort('The configured browser Access audience did not match exactly one application.');
  const sourceId = idFor(matches[0]);
  const source = await getApp(sourceId, 'Read the browser Access application');
  if (
    source?.aud !== browserAudience ||
    source.type !== 'self_hosted' ||
    source.scim_config?.enabled === true ||
    source.approval_required === true ||
    source.mfa_disabled === true ||
    source.destinations?.some((destination) => destination.overrides?.length > 0) ||
    appUris(source).some((uri) => uri === host || uri.startsWith(`${host}/`))
  ) {
    abort('The browser Access application type or settings cannot be safely copied.');
  }

  const sourcePolicies = rereadOrder(await policies(sourceId));
  if (!sourcePolicies.some(({ decision }) => decision === 'allow')) {
    abort('The browser Access application has no allow policy.');
  }
  sourcePolicies.forEach(safeSource);
  const shared = await cf.list('List reusable Access policies', '/access/policies');
  const sharedIds = new Set(shared.map(({ id }) => id));
  if (!sourcePolicies.every(({ id }) => typeof id === 'string' && /^[a-f\d-]{32,36}$/i.test(id))) {
    abort('Cloudflare did not return verifiable browser policy IDs.');
  }
  if (!sourcePolicies.every(({ id }) => sharedIds.has(id))) {
    abort(
      'The browser Access application must use reusable policies so changing access applies to MCP too.',
    );
  }
  const references = sourcePolicies.map(({ id, precedence }) => ({ id, precedence }));
  const browserSettings = browserAdmission(source);
  const oauth = {
    enabled: true,
    dynamic_client_registration: {
      enabled: true,
      allow_any_on_localhost: false,
      allow_any_on_loopback: true,
      allowed_uris: [],
    },
    grant: { access_token_lifetime: '15m', session_duration: source.session_duration ?? '24h' },
  };
  const roles = [
    { name: readName, destination: host },
    { name: writeName, destination: `${host}${writePath}` },
  ];

  // Check for both collisions before touching either role.
  const destinations = new Set(roles.map(({ destination }) => destination));
  if (
    apps.some((app) =>
      appUris(app).some((uri) => uri.startsWith(`${host}/`) && !destinations.has(uri)),
    )
  ) {
    abort('An unrelated Access application already covers a path on the intended MCP host.');
  }
  for (const role of roles) {
    const candidates = apps.filter(
      (app) => app.name === role.name || appUris(app).includes(role.destination),
    );
    if (candidates.length === 0) continue;
    if (
      candidates.length !== 1 ||
      candidates[0].name !== role.name ||
      !exactDestination(candidates[0], role.destination)
    ) {
      abort(
        'The intended MCP Access name or destination is already used by an unrelated application.',
      );
    }
    role.id = idFor(candidates[0]);
  }

  async function verify(role) {
    const app = await getApp(role.id, 'Verify an MCP Access application');
    const actualOAuth = app?.oauth_configuration;
    const registration = actualOAuth?.dynamic_client_registration;
    const actualPolicies = rereadOrder(await policies(role.id));
    if (
      !app ||
      app.id !== role.id ||
      app.name !== role.name ||
      !exactDestination(app, role.destination) ||
      !audienceTag.test(app.aud ?? '') ||
      app.aud === browserAudience ||
      app.options_preflight_bypass === true ||
      app.app_launcher_visible !== false ||
      !same(browserAdmission(app), browserSettings) ||
      actualOAuth?.enabled !== true ||
      registration?.enabled !== true ||
      registration.allow_any_on_localhost === true ||
      registration.allow_any_on_loopback !== true ||
      !same(actualOAuth.grant, oauth.grant) ||
      !same(
        actualPolicies.map(({ id, precedence }) => ({ id, precedence })),
        references,
      )
    ) {
      abort(
        'An intended MCP Access application does not match the expected configuration. No existing application was modified.',
      );
    }
    return app.aud;
  }

  // Validate existing applications before creating any missing counterpart.
  for (const role of roles) {
    if (role.id != null) role.aud = await verify(role);
  }

  // Put the narrower policy in place first.
  for (const role of [...roles].reverse()) {
    if (role.id != null) continue;
    const { result } = await cf.request(
      'Create a dedicated MCP Access application',
      appPath,
      'POST',
      {
        ...browserSettings,
        type: 'self_hosted',
        name: role.name,
        destinations: [{ type: 'public', uri: role.destination }],
        app_launcher_visible: false,
        oauth_configuration: oauth,
        policies: references,
      },
    );
    role.id = idFor(result ?? {});
    role.aud = await verify(role);
  }

  const [read, write] = roles;
  if (read.aud === write.aud) abort('Cloudflare returned the same audience for both MCP roles.');
  return { MCP_READ_AUD: read.aud, MCP_WRITE_AUD: write.aud, MCP_HOST: host };
}

async function main() {
  const {
    CLOUDFLARE_ACCOUNT_ID: account,
    CLOUDFLARE_API_TOKEN: token,
    GITHUB_OUTPUT: output,
  } = process.env;
  if (!output) abort('GITHUB_OUTPUT is required in the trusted deployment job.');
  const config = await readFile(new URL('../../wrangler.jsonc', import.meta.url), 'utf8');
  const browserAudience = config.match(/^\s*"ACCESS_AUD"\s*:\s*"([a-f\d]{64})"/im)?.[1];
  const values = await provisionMcp({ account, token, browserAudience, fetch });
  await appendFile(
    output,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(
      error instanceof ProvisionError ? error.message : 'MCP Access provisioning failed.',
    );
    process.exitCode = 1;
  });
}
