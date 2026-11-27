import OAuthProvider, {
  AuthorizationError,
  type AuthRequest,
  type OAuthHelpers,
  type OAuthProviderOptions,
} from '@cloudflare/workers-oauth-provider';
import type { McpEnv } from '../app';
import { bodyRefused, fail, isCrossSiteWrite, notFound, readBody } from '../http';
import {
  consentEmail,
  grantUserId,
  isLoopback,
  sha256,
  type ConsentIdentityEnv,
} from './consent-account';
import { handleConnections } from './connections';
import { READ_SCOPE, SCOPES, WRITE_SCOPE } from './scopes';
import { mcpHandler } from './server';

export interface GrantProps {
  email: string;
}

export interface OAuthEnv extends McpEnv, ConsentIdentityEnv {
  MCP_ORIGIN: string;
  OAUTH_KV: KVNamespace;
  REGISTER_LIMITER: RateLimit;
  REGISTER_ALL_LIMITER: RateLimit;
}

const RESOURCE = '/api/mcp';
const CONSENT = '/oauth/authorize';
const REGISTER = '/oauth/register';
const TOKEN = '/oauth/token';
const MAX_FORM_BYTES = 16 * 1024;
const REGISTRATION_TTL = 90 * 24 * 60 * 60;
const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(status: number, body: string, headers = new Headers()) {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Referrer-Policy', 'same-origin');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  );
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect to Mahnee</title><style>
    :root { color-scheme: light dark; font: 1rem/1.55 system-ui, sans-serif }
    body { margin: 0; padding: 3rem 1rem } main { max-width: 30rem; margin: auto; overflow-wrap: anywhere }
    h1 { font-size: 1.6rem; line-height: 1.2 } dt { margin-top: .5rem; font-weight: 600 } dd { margin: 0 }
    fieldset { margin: 1.5rem 0; border-radius: .5rem } label { display: block; padding: .65rem 0; cursor: pointer }
    small { display: block; margin-left: 1.5rem } button { padding: .6rem 1.2rem; margin-right: .5rem; font: inherit; cursor: pointer }
  </style></head><body><main>${body}</main></body></html>`,
    { status, headers },
  );
}

const problem = (status: number, message: string) =>
  page(status, `<h1>Unable to connect to Mahnee</h1><p>${escape(message)}</p>`);

// The provider binds the handle to this browser. Also bind it to the account that saw the
// form so changing Access accounts in another tab can't approve access to a different ledger.
const consentKey = async (handle: string, email: string) =>
  `mahnee-consent:${await sha256(JSON.stringify([handle, email]))}`;

async function showConsent(
  env: OAuthEnv,
  oauth: OAuthHelpers,
  request: AuthRequest,
  email: string,
) {
  if (!request.codeChallenge || request.codeChallengeMethod !== 'S256') {
    return problem(400, 'Start the connection again using S256 PKCE.');
  }
  const details = await oauth.describeConsent(request);
  const consent = await oauth.beginConsent(request);
  await env.OAUTH_KV.put(await consentKey(consent.handle, email), details.clientName, {
    expirationTtl: 600,
  });
  return page(
    200,
    `<h1>Allow ${escape(details.clientName)} to use Mahnee?</h1>
    <dl><dt>Signed in as</dt><dd>${escape(email)}</dd><dt>Access goes to</dt><dd>${escape(details.redirectHost)}</dd></dl>
    <p>This app supplied its own name. Approve only if you started connecting it.</p>
    ${details.redirectIsLoopback ? '<p>This sends access to an app on your computer.</p>' : ''}
    <form method="post" action="/oauth/authorize"><input type="hidden" name="handle" value="${escape(consent.handle)}">
    <fieldset><legend>Choose what this app can do</legend>
    <label><input type="checkbox" name="scope" value="${READ_SCOPE}" checked> Read ledger<small>See accounts, balances, categories, transactions and monthly summaries.</small></label>
    <label><input type="checkbox" name="scope" value="${WRITE_SCOPE}"> Add expenses<small>Record expenses in your ledger. Each one changes your account balance.</small></label>
    </fieldset><button name="decision" value="deny">Deny</button><button name="decision" value="approve">Allow</button></form>`,
    consent.headers,
  );
}

async function answerConsent(req: Request, env: OAuthEnv, oauth: OAuthHelpers, email: string) {
  const body = await readBody(req, MAX_FORM_BYTES);
  if (typeof body === 'string') return bodyRefused(body);
  const form = new URLSearchParams(new TextDecoder().decode(body));
  const handle = form.get('handle');
  if (!handle || handle.length > 128) return problem(400, 'Start the connection again.');
  const key = await consentKey(handle, email);
  const clientName = await env.OAUTH_KV.get(key);
  if (clientName == null)
    return problem(
      403,
      'This approval has expired or belongs to another account. Start the connection again.',
    );
  const decision = form.get('decision');
  if (decision === 'deny') {
    const { headers } = await oauth.denyConsent(req, handle);
    await env.OAUTH_KV.delete(key);
    return new Response(null, { status: 302, headers });
  }
  if (decision !== 'approve') return problem(400, 'Choose Allow or Deny.');
  const scope = [...new Set(form.getAll('scope'))];
  if (!scope.length || !scope.every((s) => SCOPES.includes(s))) {
    return problem(400, 'Select one or both permissions to continue.');
  }
  const approved = await oauth.approveConsent(req, handle, { scope });
  await env.OAUTH_KV.delete(key);
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: await grantUserId(email),
    metadata: { clientName },
    scope: approved.request.scope,
    props: { email } satisfies GrantProps,
  });
  approved.headers.set('Location', redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
}

const humanPages: ExportedHandler<OAuthEnv & { OAUTH_PROVIDER: OAuthHelpers }> = {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== CONSENT && url.pathname !== `${CONSENT}/connections`) return notFound();
    if (req.method !== 'GET' && req.method !== 'POST') return problem(405, 'Use GET or POST.');
    if (
      isCrossSiteWrite(req, url) ||
      (req.method === 'POST' &&
        req.headers.has('Origin') &&
        req.headers.get('Origin') !== url.origin)
    ) {
      return problem(403, 'Open this page on the Mahnee connection site.');
    }
    const email = await consentEmail(req, env);
    if (!email) return problem(401, 'Sign in to Mahnee, then start the connection again.');
    const oauth = env.OAUTH_PROVIDER;
    if (url.pathname.endsWith('/connections')) return handleConnections(req, oauth, email);
    try {
      if (req.method === 'POST') return await answerConsent(req, env, oauth, email);
      if (!resourceMatches(url.searchParams, url.origin)) return invalidTarget();
      return await showConsent(env, oauth, await oauth.parseAuthRequest(req), email);
    } catch (error) {
      if (!(error instanceof AuthorizationError)) throw error;
      if (error.redirectTo)
        return new Response(null, {
          status: 302,
          headers: { 'Location': error.redirectTo, 'Cache-Control': 'no-store' },
        });
      return problem(
        400,
        'This connection request is invalid or has expired. Start again from the app.',
      );
    }
  },
};

function registrationRefusal(metadata: Record<string, unknown>) {
  const name = metadata.client_name;
  if (name != null && (typeof name !== 'string' || name.length > 100))
    return 'Choose a shorter client name.';
  const redirects = metadata.redirect_uris;
  if (
    !Array.isArray(redirects) ||
    !redirects.length ||
    redirects.length > 5 ||
    redirects.some((u) => typeof u !== 'string' || u.length > 512)
  ) {
    return 'Provide between one and five redirect URIs of at most 512 characters each.';
  }
  for (const field of ['client_uri', 'logo_uri', 'policy_uri', 'tos_uri', 'jwks_uri']) {
    const value = metadata[field];
    if (value != null && (typeof value !== 'string' || value.length > 512))
      return 'Each client URI must be at most 512 characters.';
  }
  return undefined;
}

const resourceMatches = (params: URLSearchParams, origin: string) => {
  const resources = params.getAll('resource');
  return (
    resources.length === 0 || (resources.length === 1 && resources[0] === `${origin}${RESOURCE}`)
  );
};

const protocolError = (status: number, error: string, description: string) =>
  Response.json(
    { error, error_description: description },
    { status, headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } },
  );
const invalidTarget = () =>
  protocolError(400, 'invalid_target', 'Use the canonical Mahnee MCP resource.');

function providerOptions(origin: string): OAuthProviderOptions<OAuthEnv> {
  return {
    apiRoute: RESOURCE,
    apiHandler: mcpHandler,
    defaultHandler: humanPages as ExportedHandler<OAuthEnv>,
    authorizeEndpoint: CONSENT,
    tokenEndpoint: TOKEN,
    clientRegistrationEndpoint: REGISTER,
    clientRegistrationTTL: REGISTRATION_TTL,
    clientIdMetadataDocumentEnabled: false,
    clientRegistrationCallback: ({ clientMetadata }) => {
      const description = registrationRefusal(clientMetadata);
      if (description) return { description };
    },
    scopesSupported: [...SCOPES, 'offline_access'],
    requiredScopes: [...SCOPES],
    resourceMetadata: {
      resource: `${origin}${RESOURCE}`,
      authorization_servers: [origin],
      resource_name: 'Mahnee',
    },
    // Error descriptions may contain client input. Keep only stable protocol codes for outages.
    onError: ({ status, code }) => {
      if (status >= 500) console.error('OAuth provider', status, code);
    },
  };
}

let cached: { origin: string; provider: OAuthProvider<OAuthEnv> } | undefined;

export async function handleOAuth(req: Request, env: OAuthEnv, ctx: ExecutionContext) {
  const url = new URL(req.url);
  if (url.pathname === '/api/mcp/write')
    return fail('This endpoint has retired. Reconnect at /api/mcp and choose Add expenses.', 410);
  if (!env.MCP_ORIGIN || !env.OAUTH_KV) return notFound();
  const origin = new URL(env.MCP_ORIGIN).origin;
  if (
    url.origin !== origin ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname)))
  )
    return notFound();
  if (url.pathname.startsWith('/api/') && url.pathname !== RESOURCE) return notFound();
  if (url.pathname === REGISTER && req.method === 'POST') {
    const [address, all] = await Promise.all([
      env.REGISTER_LIMITER.limit({ key: req.headers.get('CF-Connecting-IP') ?? 'unknown' }),
      env.REGISTER_ALL_LIMITER.limit({ key: 'all' }),
    ]);
    if (!address.success || !all.success)
      return protocolError(429, 'temporarily_unavailable', 'Try registering again later.');
  }
  if ((url.pathname === REGISTER || url.pathname === TOKEN) && req.method === 'POST') {
    const body = await readBody(req, MAX_FORM_BYTES);
    if (body === 'too large') {
      const code = url.pathname === REGISTER ? 'invalid_client_metadata' : 'invalid_request';
      return protocolError(413, code, 'The request exceeds the 16 KiB limit.');
    }
    if (body === 'too slow') return bodyRefused(body);
    if (
      url.pathname === TOKEN &&
      !resourceMatches(new URLSearchParams(new TextDecoder().decode(body)), origin)
    )
      return invalidTarget();
    req = new Request(req.url, { method: req.method, headers: req.headers, body });
  }
  if (cached?.origin !== origin)
    cached = { origin, provider: new OAuthProvider(providerOptions(origin)) };
  return cached.provider.fetch(req, env, ctx);
}
