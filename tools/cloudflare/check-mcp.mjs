import {
  discoverOAuthServerInfo,
  extractWWWAuthenticateParams,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { setTimeout as delay } from 'node:timers/promises';

const host = process.env.MCP_HOST ?? '';
if (!/^mahnee-mcp\.[a-z0-9-]+\.workers\.dev$/.test(host)) throw new Error('Invalid MCP hostname');

async function check(path) {
  const url = new URL(path, `https://${host}`);
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
    headers: {
      'Accept': 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'mahnee-deploy-check', version: '1' },
      },
    }),
  });
  await response.body?.cancel();
  if (path === '/api/mcp/write') {
    if (response.status !== 410) throw new Error(`Retired writer returned HTTP ${response.status}`);
    return;
  }
  if (
    response.status !== 401 ||
    !/^Bearer\b/i.test(response.headers.get('WWW-Authenticate') ?? '')
  ) {
    throw new Error(`${path} did not return an OAuth challenge (HTTP ${response.status})`);
  }
  const { resourceMetadataUrl } = extractWWWAuthenticateParams(response);
  const { authorizationServerMetadata: issuer, resourceMetadata } = await discoverOAuthServerInfo(
    url,
    {
      resourceMetadataUrl,
      fetchFn: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10000) }),
    },
  );
  const scopes = resourceMetadata?.scopes_supported ?? [];
  if (
    resourceMetadata?.resource !== url.href ||
    issuer?.issuer !== url.origin ||
    issuer.authorization_endpoint !== `${url.origin}/oauth/authorize` ||
    issuer.token_endpoint !== `${url.origin}/oauth/token` ||
    issuer.registration_endpoint !== `${url.origin}/oauth/register` ||
    !issuer.revocation_endpoint ||
    !issuer.code_challenge_methods_supported?.includes('S256') ||
    !['ledger:read', 'ledger:write'].every((scope) => scopes.includes(scope))
  ) {
    throw new Error(
      'OAuth discovery must advertise the dedicated issuer and both ledger permissions.',
    );
  }
  console.log(`Verified OAuth discovery at ${url.href}`);
}

for (const path of ['/api/mcp', '/api/mcp/write']) {
  for (let attempt = 1; ; attempt++) {
    try {
      await check(path);
      break;
    } catch (error) {
      if (attempt >= 6) throw error;
      await delay(5000);
    }
  }
}
