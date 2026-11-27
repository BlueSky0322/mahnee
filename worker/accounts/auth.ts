// Identifies the signed-in user from the Cloudflare Access token on each request.
// In production every request must carry a valid Access JWT; locally (no Access in
// front of `wrangler dev`) DEV_USER_EMAIL stands in, overridable per request with
// an X-Dev-User header so tests can act as several people (and X-Dev-Picture for the
// Google picture a sign-in names).
//
// The token names the person's Google picture only when the Google identity provider in
// Zero Trust passes the `picture` claim on (its OIDC Claims setting): Access then puts it
// in the token's `custom` claims. Without that, there's no picture and the initial shows.

export interface AuthEnv {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** The separate Access application for MCP, when configured. */
  ACCESS_MCP_AUD?: string;
  /** A distinct Access application required for MCP mutations. */
  ACCESS_MCP_WRITE_AUD?: string;
  DEV_USER_EMAIL?: string;
  DEV_MCP_WRITES?: string;
}

export type AccessService = 'app' | 'mcp' | 'mcp-write';

interface AccessJwk extends JsonWebKey {
  kid: string;
}

const KEYS_TTL_MS = 60 * 60 * 1000;
/**
 * A key id the kept set doesn't have makes it fetch the set again, so a rotation is
 * picked up at once; but anyone can put any id in a token. So an id still missing after
 * a fetch isn't fetched for again for a while, and only so many fetches a minute are
 * made for ids not kept.
 */
const MISSING_KEY_MS = 5 * 60 * 1000;
const UNKNOWN_KEY_FETCHES_PER_MINUTE = 6;
const MAX_MISSING_KEYS = 1000;
/** How long the team's key set may take to arrive */
const KEYS_FETCH_TIMEOUT_MS = 5000;

interface KeySet {
  url: string;
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}
let keyCache: KeySet | null = null;
/** Ids found missing from the key set, until when they're taken to be */
const missing = new Map<string, number>();
/** When each of the last minute's fetches for an id not kept was made */
let unknownFetches: number[] = [];
// Each request fetches the key set itself when it needs it. A fetch is never shared
// between requests: the Worker can't finish one request's fetch once that request has
// ended (the person closed the page), so everyone waiting on it would wait for ever.

const decodeBase64Url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

// Token fields as read from the wire; each one is checked before it's trusted
interface JwtHeader {
  kid?: unknown;
}
interface JwtPayload {
  aud?: unknown;
  iss?: unknown;
  exp?: unknown;
  nbf?: unknown;
  email?: unknown;
  /** The identity provider's claims the team chose to pass on (OIDC Claims) */
  custom?: unknown;
}

/** Who's signed in, and the address of their Google picture when the sign-in names one */
export interface SignIn {
  email: string;
  picture: string | null;
}

/** The picture claim Access passed on from the identity provider, if it's text */
function pictureClaim(custom: unknown): string | null {
  if (custom == null || typeof custom !== 'object') return null;
  const picture = (custom as Record<string, unknown>).picture;
  return typeof picture === 'string' && picture !== '' ? picture : null;
}

/** What `decode` returns, or null when the token part isn't valid base64url or JSON */
function tryDecode<T>(decode: () => T): T | null {
  try {
    return decode();
  } catch {
    return null;
  }
}

/** A token part as JSON, or null when it can't be read */
const decodeJson = <T>(s: string) =>
  tryDecode(() => JSON.parse(new TextDecoder().decode(decodeBase64Url(s))) as T);

async function getSigningKey(certsUrl: string, kid: string): Promise<CryptoKey | undefined> {
  const cached = keyCache;
  const fresh = cached?.url === certsUrl && Date.now() - cached.fetchedAt < KEYS_TTL_MS;
  const key = fresh ? cached.keys.get(kid) : undefined;
  if (key != null) return key;
  const now = Date.now();
  if (fresh) {
    // Refetch on an unknown kid too, so a key rotation doesn't lock everyone out for an
    // hour; but not for one just found missing, nor more than so often
    if ((missing.get(kid) ?? 0) > now) return undefined;
    unknownFetches = unknownFetches.filter((at) => now - at < 60 * 1000);
    if (unknownFetches.length >= UNKNOWN_KEY_FETCHES_PER_MINUTE) return undefined;
    unknownFetches.push(now);
  }

  const found = (await fetchKeys(certsUrl)).keys.get(kid);
  if (found == null) {
    if (missing.size >= MAX_MISSING_KEYS) missing.clear();
    missing.set(kid, Date.now() + MISSING_KEY_MS);
  }
  return found;
}

async function fetchKeys(certsUrl: string): Promise<KeySet> {
  const res = await fetch(certsUrl, { signal: AbortSignal.timeout(KEYS_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Access certs fetch failed: ${res.status}`);
  const { keys } = await res.json<{ keys: AccessJwk[] }>();

  const imported = new Map<string, CryptoKey>();
  for (const jwk of keys) {
    if (jwk.kty !== 'RSA') continue;
    imported.set(
      jwk.kid,
      await crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      ),
    );
  }
  keyCache = { url: certsUrl, keys: imported, fetchedAt: Date.now() };
  return keyCache;
}

/** Who the token says signed in, if it is a valid Access token for this app; otherwise null */
async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  aud: string,
): Promise<SignIn | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [rawHeader, rawPayload, rawSignature] = parts;

  const header = decodeJson<JwtHeader>(rawHeader);
  // Always verified as RS256 with the team's key, whatever alg the token claims
  if (typeof header?.kid !== 'string') return null;

  const team = teamDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
  // A token that can't be read is simply not valid; failing to fetch the team's keys is
  // an outage, which reaches the error handler instead of looking like being signed out
  const key = await getSigningKey(`https://${team}/cdn-cgi/access/certs`, header.kid);
  if (key == null) return null;

  const signature = tryDecode(() => decodeBase64Url(rawSignature));
  if (signature == null) return null;
  const valid = await crypto.subtle
    .verify(
      'RSASSA-PKCS1-v1_5',
      key,
      signature,
      new TextEncoder().encode(`${rawHeader}.${rawPayload}`),
    )
    .catch(() => false);
  if (!valid) return null;

  const payload = decodeJson<JwtPayload>(rawPayload);
  if (payload == null) return null;
  const audiences: unknown[] = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const nowSeconds = Date.now() / 1000;
  if (payload.iss !== `https://${team}`) return null;
  if (!audiences.includes(aud)) return null;
  if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds) return null;
  if (typeof payload.nbf === 'number' && payload.nbf > nowSeconds) return null;
  if (typeof payload.email !== 'string' || payload.email === '') return null;

  return { email: payload.email.toLowerCase(), picture: pictureClaim(payload.custom) };
}

const readCookie = (req: Request, name: string) =>
  req.headers
    .get('Cookie')
    ?.split(';')
    .map((c) => c.trim().split('='))
    .find(([k]) => k === name)?.[1];

/** The signed-in user's email, or null. Fails closed when Access isn't configured. */
export const getUserEmail = async (req: Request, env: AuthEnv) =>
  (await getSignIn(req, env))?.email ?? null;

function audienceFor(env: AuthEnv, service: AccessService) {
  if (service === 'mcp-write') {
    const audience = env.ACCESS_MCP_WRITE_AUD;
    if (audience === env.ACCESS_AUD || audience === env.ACCESS_MCP_AUD) return undefined;
    return audience;
  }
  return service === 'mcp' && env.ACCESS_MCP_AUD ? env.ACCESS_MCP_AUD : env.ACCESS_AUD;
}

export async function getAccessSignIn(
  req: Request,
  teamDomain: string,
  audience: string,
): Promise<SignIn | null> {
  const token = req.headers.get('Cf-Access-Jwt-Assertion') ?? readCookie(req, 'CF_Authorization');
  return token ? verifyAccessJwt(token, teamDomain, audience) : null;
}

/** Who's signed in, with their Google picture's address, or null. Fails closed as above. */
export async function getSignIn(
  req: Request,
  env: AuthEnv,
  service: AccessService = 'app',
): Promise<SignIn | null> {
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    const audience = audienceFor(env, service);
    return audience ? getAccessSignIn(req, env.ACCESS_TEAM_DOMAIN, audience) : null;
  }

  // Any Access setting means this is a deployment and requires the full configuration.
  if (env.ACCESS_TEAM_DOMAIN || env.ACCESS_AUD || env.ACCESS_MCP_AUD || env.ACCESS_MCP_WRITE_AUD)
    return null;

  if (env.DEV_USER_EMAIL && (service !== 'mcp-write' || env.DEV_MCP_WRITES === 'true')) {
    return {
      email: (req.headers.get('X-Dev-User') ?? env.DEV_USER_EMAIL).toLowerCase(),
      picture: req.headers.get('X-Dev-Picture') || null,
    };
  }

  return null;
}
