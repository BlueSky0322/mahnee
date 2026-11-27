// Drive the consent form as a signed-in local browser. The SDK discovers the real server,
// registers a public client, and exchanges its S256 code and verifier at the token endpoint.
import { createRequire } from 'node:module';
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  registerClient,
  refreshAuthorization,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { expect } from 'vitest';

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: { fragment(html: string): DocumentFragment };
};
export const read = 'ledger:read';
export const write = 'ledger:write';
const redirectUri = 'http://127.0.0.1:48711/callback';

export async function openPage(url: URL, email: string) {
  const response = await fetch(url, { headers: { 'X-Dev-User': email }, redirect: 'manual' });
  expect(response.status).toBe(200);
  return {
    url,
    document: JSDOM.fragment(await response.text()),
    cookie: response.headers
      .getSetCookie()
      .map((line) => line.split(';')[0])
      .join('; '),
  };
}

export function submit(
  page: Awaited<ReturnType<typeof openPage>>,
  form: HTMLFormElement,
  email: string,
  values: URLSearchParams,
) {
  const action = new URL(form.getAttribute('action') || page.url.href, page.url);
  expect(action.origin).toBe(page.url.origin);
  return fetch(action, {
    method: 'POST',
    headers: { 'X-Dev-User': email, 'Origin': action.origin, 'Cookie': page.cookie },
    body: values,
    redirect: 'manual',
  });
}

export function hiddenFields(form: HTMLFormElement) {
  const fields = new URLSearchParams();
  form
    .querySelectorAll<HTMLInputElement>('input[type=hidden][name]')
    .forEach((input) => fields.append(input.name, input.value));
  return fields;
}

export async function registerApp(base: string, name: string) {
  const resource = new URL('/api/mcp', base);
  const {
    authorizationServerUrl,
    authorizationServerMetadata: metadata,
    resourceMetadata,
  } = await discoverOAuthServerInfo(resource);
  expect(resourceMetadata?.resource).toBe(resource.href);
  expect([...(resourceMetadata?.scopes_supported ?? [])].sort()).toEqual([read, write]);
  const clientInformation = await registerClient(authorizationServerUrl, {
    metadata,
    clientMetadata: {
      client_name: name,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    scope: [read, write].join(' '),
  });
  return { resource, authorizationServerUrl, metadata, clientInformation };
}

export type RegisteredApp = Awaited<ReturnType<typeof registerApp>>;

export async function startConsent(app: RegisteredApp, email: string, requested = [read, write]) {
  const { resource, authorizationServerUrl, metadata, clientInformation } = app;
  const state = crypto.randomUUID();
  const { authorizationUrl, codeVerifier } = await startAuthorization(authorizationServerUrl, {
    metadata,
    clientInformation,
    redirectUrl: redirectUri,
    scope: requested.join(' '),
    state,
    resource,
  });
  expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
  const page = await openPage(authorizationUrl, email);
  const form = page.document.querySelector('form')!;
  return {
    page,
    form,
    state,
    async approve(signer: string, scopes: string[]) {
      const values = hiddenFields(form);
      values.set('decision', 'approve');
      scopes.forEach((scope) => values.append('scope', scope));
      return submit(page, form, signer, values);
    },
    async exchange(response: Response) {
      expect([302, 303]).toContain(response.status);
      const callback = new URL(response.headers.get('location')!);
      expect(callback.origin + callback.pathname).toBe(redirectUri);
      expect(callback.searchParams.get('state')).toBe(state);
      const authorizationCode = callback.searchParams.get('code');
      expect(authorizationCode).toBeTruthy();
      return exchangeAuthorization(authorizationServerUrl, {
        metadata,
        clientInformation,
        authorizationCode: authorizationCode!,
        codeVerifier,
        redirectUri,
        resource,
      });
    },
  };
}

export async function grant(app: RegisteredApp, email: string, scopes: string[]) {
  const consent = await startConsent(app, email);
  const response = await consent.approve(email, scopes);
  return consent.exchange(response);
}

export function refresh(app: RegisteredApp, refreshToken: string) {
  const { authorizationServerUrl, metadata, clientInformation, resource } = app;
  return refreshAuthorization(authorizationServerUrl, {
    metadata,
    clientInformation,
    resource,
    refreshToken,
  });
}
