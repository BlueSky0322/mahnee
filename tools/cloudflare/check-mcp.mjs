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
  if (
    response.status !== 401 ||
    !/^Bearer\b/i.test(response.headers.get('WWW-Authenticate') ?? '')
  ) {
    throw new Error(`${path} did not return an OAuth challenge (HTTP ${response.status})`);
  }
  const { resourceMetadataUrl } = extractWWWAuthenticateParams(response);
  const { authorizationServerMetadata } = await discoverOAuthServerInfo(url, {
    resourceMetadataUrl,
    fetchFn: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10000) }),
  });
  if (
    !authorizationServerMetadata?.authorization_endpoint ||
    !authorizationServerMetadata.token_endpoint
  ) {
    throw new Error(`OAuth discovery failed for ${path}`);
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
