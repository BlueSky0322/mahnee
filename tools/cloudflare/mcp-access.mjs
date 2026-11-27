import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const apiRoot = 'https://api.cloudflare.com/client/v4';
const readName = 'Mahnee MCP read (managed)';
const writeName = 'Mahnee MCP write (managed)';
const writePath = '/api/mcp/write';
const consentName = 'Mahnee MCP consent (managed)';
const consentPath = '/oauth/authorize';
const kvTitle = 'mahnee-mcp-oauth-bluesky0322-1444093171';
const kvPath = '/storage/kv/namespaces';
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
  if (!accountId.test(account ?? '') || typeof token !== 'string' || !token) {
    abort('Missing or invalid Cloudflare deployment credentials.');
  }

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
        : path.startsWith('/storage/kv/')
          ? 'Workers KV Storage Write'
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
    const perPage = 50;
    for (let page = 1; page <= 200; page++) {
      const { result, result_info: info } = await request(
        operation,
        `${path}?page=${page}&per_page=${perPage}`,
      );
      if (!Array.isArray(result)) abort(`${operation}: Cloudflare returned an invalid list.`);
      all.push(...result);
      if (Number.isSafeInteger(info?.total_pages)) {
        if (page >= info.total_pages) return all;
      } else if (Number.isSafeInteger(info?.total_count)) {
        if (all.length >= info.total_count) return all;
      } else if (result.length < (info?.per_page || perPage)) {
        return all;
      }
      if (result.length === 0) abort(`${operation}: Cloudflare pagination ended unexpectedly.`);
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
  if (app.destinations?.length > 0) {
    return app.destinations
      .filter(({ type }) => type === 'public')
      .map(({ uri }) => publicUri(uri));
  }
  return [app.domain, ...(app.self_hosted_domains ?? [])].map(publicUri);
}

function browserAdmission(app) {
  return {
    ...pickOwn(app, browserFields),
    allowed_idps: [...(app.allowed_idps ?? [])].sort(),
    auto_redirect_to_identity: app.auto_redirect_to_identity === true,
  };
}

function exactDestinations(app, destinations) {
  const expected = destinations.map((uri) => ({ type: 'public', uri, overrides: [] }));
  const actual = (app.destinations ?? [])
    .map((item) => ({
      type: item.type,
      uri: publicUri(item.uri),
      overrides: item.overrides ?? [],
    }))
    .sort((a, b) => a.uri.localeCompare(b.uri));
  return app.type === 'self_hosted' && same(actual, expected);
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

async function workerTarget(cf) {
  const [{ result: subdomain }, { result: scripts }] = await Promise.all([
    cf.request('Read the account Workers subdomain', '/workers/subdomain'),
    cf.request('Check the intended Worker name', '/workers/scripts'),
  ]);
  if (!workerSubdomain.test(subdomain?.subdomain ?? '')) {
    abort('Cloudflare did not return a valid Workers subdomain.');
  }
  const host = `${workerName}.${subdomain.subdomain}.workers.dev`;
  if (!Array.isArray(scripts) || scripts.some((script) => typeof script?.id !== 'string')) {
    abort('Cloudflare did not return a verifiable list of Worker names.');
  }
  const exists = scripts.some((script) => script.id === workerName);
  let bindings = [];
  if (exists) {
    const { result } = await cf.request(
      'Verify ownership of the existing MCP Worker',
      `/workers/scripts/${workerName}/settings`,
    );
    bindings = result?.bindings ?? [];
    const marker = bindings.filter(({ name }) => name === 'MAHNEE_MCP_MANAGED');
    if (marker?.length !== 1 || marker[0].type !== 'plain_text' || marker[0].text !== ownership) {
      abort('The intended MCP Worker name is already in use without the Mahnee ownership marker.');
    }
  }

  return { host, exists, bindings };
}

export async function checkMcpWorker({ account, token, fetch }) {
  const { host, exists } = await workerTarget(client(account, token, fetch));
  return { MCP_HOST: host, MCP_WORKER_EXISTS: exists };
}

export async function provisionMcp({ account, token, browserAudience, fetch, activate = false }) {
  if (!audienceTag.test(browserAudience ?? ''))
    abort('Missing or invalid browser Access audience.');
  const cf = client(account, token, fetch);
  const { host, exists, bindings } = await workerTarget(cf);
  const appPath = '/access/apps';
  const apps = await cf.list('List Access applications', appPath);

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
  const consent = {
    name: consentName,
    // Access inherits the parent application's rules on descendant paths.
    destinations: [`${host}${consentPath}`],
  };
  const legacy = [
    { name: readName, destinations: [host], binding: 'ACCESS_MCP_AUD' },
    { name: writeName, destinations: [`${host}${writePath}`], binding: 'ACCESS_MCP_WRITE_AUD' },
  ];

  // A more specific or account-wide app could still intercept provider requests.
  const destinations = new Set([
    ...consent.destinations,
    ...legacy.flatMap((role) => role.destinations),
  ]);
  if (
    apps.some(
      (app) =>
        app.destinations?.some(({ type }) => type === 'all_workers') ||
        appUris(app).some((uri) => uri.startsWith(`${host}/`) && !destinations.has(uri)),
    )
  ) {
    abort('An unrelated Access application may intercept requests to the intended MCP host.');
  }

  async function verify(role, candidate, prior) {
    const id = idFor(candidate);
    const app = await getApp(id, 'Verify an MCP Access application');
    if (
      !app ||
      app.id !== id ||
      app.name !== role.name ||
      !exactDestinations(app, role.destinations) ||
      !audienceTag.test(app.aud ?? '') ||
      app.aud === browserAudience ||
      app.options_preflight_bypass === true ||
      app.app_launcher_visible !== false ||
      !same(browserAdmission(app), browserSettings) ||
      (app.oauth_configuration?.enabled === true) !== prior ||
      !same(
        rereadOrder(await policies(id)).map(({ id, precedence }) => ({ id, precedence })),
        references,
      )
    ) {
      abort('An intended MCP Access application does not match the expected configuration.');
    }
    return { id, aud: app.aud };
  }

  // Validate every existing role before creating or retiring anything.
  const existing = new Map();
  for (const role of [consent, ...legacy]) {
    const candidates = apps.filter(
      (app) =>
        app.name === role.name || appUris(app).some((uri) => role.destinations.includes(uri)),
    );
    if (candidates.length > 1)
      abort('The intended MCP Access name or destination is already used.');
    if (candidates.length === 1) {
      const app = await verify(role, candidates[0], role !== consent);
      const previous = bindings.find(({ name }) => name === role.binding);
      if (previous && (previous.type !== 'plain_text' || previous.text !== app.aud)) {
        abort(
          'A legacy Access application does not match the audience on the existing MCP Worker.',
        );
      }
      existing.set(role.name, app);
    }
  }

  const namespaces = (await cf.list('List Workers KV namespaces', kvPath)).filter(
    ({ title }) => title === kvTitle,
  );
  if (namespaces.length > 1) abort('The intended OAuth KV namespace title is not unique.');
  const bound = bindings.filter(({ name }) => name === 'OAUTH_KV');
  if (
    bound.length > 1 ||
    (bound.length === 1 &&
      (bound[0].type !== 'kv_namespace' || bound[0].namespace_id !== namespaces[0]?.id))
  ) {
    abort('The active MCP Worker already uses a different OAuth KV namespace.');
  }

  let namespace = namespaces[0];
  let consentApp = existing.get(consent.name);
  if (activate) {
    if (!exists || !namespace || !consentApp)
      abort('Prepare and deploy the native OAuth Worker before activation.');
  } else {
    if (!namespace) {
      ({ result: namespace } = await cf.request(
        'Create the MCP OAuth KV namespace',
        kvPath,
        'POST',
        { title: kvTitle },
      ));
    }
    if (!consentApp) {
      const { result } = await cf.request(
        'Create the MCP consent Access application',
        appPath,
        'POST',
        {
          ...browserSettings,
          type: 'self_hosted',
          name: consent.name,
          destinations: consent.destinations.map((uri) => ({ type: 'public', uri })),
          app_launcher_visible: false,
          oauth_configuration: { enabled: false },
          policies: references,
        },
      );
      consentApp = await verify(consent, result ?? {}, false);
    }
  }
  if (!accountId.test(namespace?.id ?? ''))
    abort('Cloudflare did not return a valid OAuth KV namespace ID.');
  if (activate) {
    await verifyNativeDeployment(cf, host, consentApp.aud, namespace.id);
    // Remove the narrower obsolete route first, then release whole-host protection.
    for (const role of [...legacy].reverse()) {
      const app = existing.get(role.name);
      if (app) {
        await cf.request(
          'Retire a verified legacy MCP Access application',
          `${appPath}/${app.id}`,
          'DELETE',
        );
      }
    }
  }
  return { MCP_HOST: host, ACCESS_CONSENT_AUD: consentApp.aud, MCP_KV_ID: namespace.id };
}

async function verifyNativeDeployment(cf, host, audience, namespaceId) {
  const scriptPath = `/workers/scripts/${workerName}`;
  const { result } = await cf.request(
    'Read the active MCP Worker deployment',
    `${scriptPath}/deployments`,
  );
  const active = result?.deployments?.[0]?.versions;
  const id = active?.[0]?.version_id;
  if (
    active?.length !== 1 ||
    active[0].percentage !== 100 ||
    !/^[a-f\d-]{32,36}$/i.test(id ?? '')
  ) {
    abort('Cloudflare did not return a single version serving all MCP traffic.');
  }
  const { result: version } = await cf.request(
    'Verify active native OAuth bindings',
    `${scriptPath}/versions/${id}`,
  );
  const bindings = version?.resources?.bindings ?? [];
  const text = (name, value) =>
    bindings.some(
      (binding) => binding.name === name && binding.type === 'plain_text' && binding.text === value,
    );
  if (
    !text('MAHNEE_MCP_MANAGED', ownership) ||
    !text('MAHNEE_MCP_NATIVE_OAUTH', 'v1') ||
    !text('MCP_ORIGIN', `https://${host}`) ||
    !text('ACCESS_CONSENT_AUD', audience) ||
    !bindings.some(
      (binding) =>
        binding.name === 'OAUTH_KV' &&
        binding.type === 'kv_namespace' &&
        binding.namespace_id === namespaceId,
    ) ||
    bindings.some(({ name }) => ['ACCESS_MCP_AUD', 'ACCESS_MCP_WRITE_AUD'].includes(name))
  ) {
    abort('The active MCP Worker does not have the expected native OAuth bindings.');
  }
}

async function provisionFromConfig(input) {
  const config = await readFile(new URL('../../wrangler.jsonc', import.meta.url), 'utf8');
  const browserAudience = config.match(/^\s*"ACCESS_AUD"\s*:\s*"([a-f\d]{64})"/im)?.[1];
  return provisionMcp({ ...input, browserAudience });
}

async function main() {
  const {
    CLOUDFLARE_ACCOUNT_ID: account,
    CLOUDFLARE_API_TOKEN: token,
    GITHUB_OUTPUT: output,
  } = process.env;
  if (!output) abort('GITHUB_OUTPUT is required in the trusted deployment job.');
  const args = process.argv.slice(2);
  if (
    args.length > 1 ||
    (args.length === 1 && !['--check-worker', '--activate'].includes(args[0]))
  ) {
    abort('Usage: node tools/cloudflare/mcp-access.mjs [--check-worker | --activate]');
  }
  const input = { account, token, fetch };
  const values =
    args[0] === '--check-worker'
      ? await checkMcpWorker(input)
      : await provisionFromConfig({ ...input, activate: args[0] === '--activate' });
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
