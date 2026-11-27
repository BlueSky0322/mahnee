import type { GrantSummary, OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { readBody } from '../http';
import { grantUserId } from './consent-account';
import { READ_SCOPE, WRITE_SCOPE } from './scopes';

const PATH = '/oauth/authorize/connections';
const PAGE_SIZE = 20;
const MAX_CURSOR_LENGTH = 2048;
const FORM_LIMIT = 4096;
const GRANT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const NONCE = /^[a-f\d-]{36}$/;

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => {
    if (char === '&') return '&amp;';
    if (char === '<') return '&lt;';
    if (char === '>') return '&gt;';
    if (char === '"') return '&quot;';
    return '&#39;';
  });

function response(body: string, status = 200, headers: Record<string, string> = {}) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
      // Browsers need to keep the Origin header on this page's form submissions.
      'Referrer-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

function page(body: string) {
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connected apps · Mahnee</title>
<style>
  :root { color-scheme: light dark; font: 1rem/1.5 system-ui, sans-serif }
  body { max-width: 38rem; margin: 3rem auto; padding: 0 1rem }
  ul { padding: 0; list-style: none }
  li { border-block-start: 1px solid GrayText; padding: 1rem 0 }
  h1, h2, p { overflow-wrap: anywhere }
  h2 { margin: 0; font-size: 1.1rem }
  li p { margin: .25rem 0 .75rem }
  button { font: inherit; padding: .3rem .75rem }
</style>
<main><h1>Connected apps</h1>${body}</main></html>`;
}

function problem(message: string, status: number) {
  return response(
    page(`<p>${message}</p><p><a href="${PATH}">Back to connected apps</a></p>`),
    status,
  );
}

function cookieName(url: URL) {
  // The production cookie is host-only. An insecure cookie is needed only for local HTTP.
  return url.protocol === 'https:' ? '__Host-mahnee-connections' : 'mahnee-connections';
}

function browserNonce(req: Request, url: URL): string | undefined {
  const name = cookieName(url) + '=';
  const nonce = req.headers
    .get('Cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(name))
    ?.slice(name.length);
  return nonce && NONCE.test(nonce) ? nonce : undefined;
}

async function formToken(nonce: string, userId: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${nonce}:${userId}`),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function displayName(grant: GrantSummary) {
  const metadata = grant.metadata as { clientName?: unknown } | undefined;
  return (
    (typeof metadata?.clientName === 'string' && metadata.clientName.trim().slice(0, 100)) ||
    'An MCP client'
  );
}

async function listConnections(req: Request, url: URL, oauth: OAuthHelpers, email: string) {
  const userId = await grantUserId(email);
  const cursor = url.searchParams.get('cursor') ?? undefined;
  if (cursor && cursor.length > MAX_CURSOR_LENGTH)
    return problem('This page link is invalid.', 400);
  const nonce = browserNonce(req, url) ?? crypto.randomUUID();
  const [token, grants] = await Promise.all([
    formToken(nonce, userId),
    oauth.listUserGrants(userId, { limit: PAGE_SIZE, cursor }),
  ]);
  const items = grants.items.map((grant) => {
    const name = escapeHtml(displayName(grant));
    const scopes = [
      ...(grant.scope.includes(READ_SCOPE) ? ['Read ledger'] : []),
      ...(grant.scope.includes(WRITE_SCOPE) ? ['Add expenses'] : []),
    ];
    return `<li><h2>${name}</h2><p>${scopes.join(' · ') || 'No ledger permissions'}</p>
<form method="post" action="${PATH}">
<input type="hidden" name="grantId" value="${escapeHtml(grant.id)}">
<input type="hidden" name="csrf" value="${token}">
<button type="submit" aria-label="Disconnect ${name}">Disconnect</button>
</form></li>`;
  });
  const list = items.length
    ? `<ul>${items.join('')}</ul>`
    : '<p>No connected apps on this page.</p>';
  const next = grants.cursor
    ? `<p><a href="${PATH}?cursor=${encodeURIComponent(grants.cursor)}">Next page</a></p>`
    : '';
  const first = cursor ? `<p><a href="${PATH}">First page</a></p>` : '';
  return response(page(`<p>Signed in as ${escapeHtml(email)}</p>${list}${next}${first}`), 200, {
    'Set-Cookie': `${cookieName(url)}=${nonce}; Path=/; Max-Age=600; HttpOnly; SameSite=Strict${url.protocol === 'https:' ? '; Secure' : ''}`,
  });
}

/** The router verifies the current human identity for each request, including form submissions. */
export async function handleConnections(req: Request, oauth: OAuthHelpers, email: string) {
  const url = new URL(req.url);
  try {
    if (req.method === 'GET') return await listConnections(req, url, oauth, email);
    if (req.method !== 'POST')
      return response(page('<p>Method not allowed.</p>'), 405, { Allow: 'GET, POST' });

    const nonce = browserNonce(req, url);
    if (!nonce || req.headers.get('Origin') !== url.origin)
      return problem('Disconnect could not be verified. Open the page and try again.', 403);
    if (req.headers.get('Content-Type')?.split(';', 1)[0] !== 'application/x-www-form-urlencoded')
      return problem('Send the disconnect form from this page.', 415);
    const bytes = await readBody(req, FORM_LIMIT);
    if (bytes === 'too large') return problem('The form is too large.', 413);
    if (bytes === 'too slow') return problem('The form took too long to send.', 408);
    const form = new URLSearchParams(new TextDecoder().decode(bytes));
    const id = form.get('grantId');
    const userId = await grantUserId(email);
    if (form.get('csrf') !== (await formToken(nonce, userId)))
      return problem('Disconnect could not be verified. Open the page and try again.', 403);
    if (!id || !GRANT_ID.test(id)) return problem('Choose an app to disconnect.', 400);
    await oauth.revokeGrant(id, userId);
    return response('', 303, { Location: PATH });
  } catch {
    return problem('Could not load or update your connections. Try again.', 503);
  }
}
