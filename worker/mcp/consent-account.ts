import { getAccessSignIn, type AuthEnv } from '../accounts/auth';

export interface ConsentIdentityEnv extends AuthEnv {
  ACCESS_CONSENT_AUD?: string;
  ACCESS_MCP_AUD?: string;
  ACCESS_MCP_WRITE_AUD?: string;
}

export const isLoopback = (hostname: string) =>
  ['localhost', '127.0.0.1', '[::1]'].includes(hostname);

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Grants and the tokens containing their identifiers never need the person's email in clear text. */
export const grantUserId = (email: string) => sha256(email.toLowerCase());

/** The account approving access in this browser, verified again when the form is submitted. */
export async function consentEmail(req: Request, env: ConsentIdentityEnv): Promise<string | null> {
  const team = env.ACCESS_TEAM_DOMAIN?.trim();
  const consent = env.ACCESS_CONSENT_AUD?.trim();
  const retired = [env.ACCESS_AUD, env.ACCESS_MCP_AUD, env.ACCESS_MCP_WRITE_AUD];
  if (team && consent && !retired.some((audience) => audience?.trim() === consent)) {
    return (await getAccessSignIn(req, team, consent))?.email ?? null;
  }
  if (env.ACCESS_TEAM_DOMAIN || env.ACCESS_CONSENT_AUD || retired.some(Boolean)) return null;
  const url = new URL(req.url);
  if (
    !env.DEV_USER_EMAIL ||
    !isLoopback(url.hostname) ||
    !['http:', 'https:'].includes(url.protocol)
  )
    return null;
  return (req.headers.get('X-Dev-User') ?? env.DEV_USER_EMAIL).toLowerCase();
}
