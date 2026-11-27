import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import type { McpEnv } from '../app';
import { isCrossSite, readBody } from '../http';
import { registerExpenseTool } from './record-expense';
import { registerLedgerTools } from './tools';

const MAX_REQUEST_BYTES = 64 * 1024;

function rpcError(status: number, code: number, message: string, headers?: HeadersInit) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Cache-Control', 'private, no-store');
  return Response.json(
    { jsonrpc: '2.0', error: { code, message }, id: null },
    { status, headers: responseHeaders },
  );
}

/** One stateless JSON-RPC exchange, scoped to the account established by the router. */
export async function handleMcp(
  req: Request,
  env: McpEnv,
  email: string,
  mode: 'read' | 'write' = 'read',
): Promise<Response> {
  const url = new URL(req.url);
  const origin = req.headers.get('Origin');
  if ((origin !== null && origin !== url.origin) || isCrossSite(req, url)) {
    return rpcError(403, -32000, 'Not allowed from this origin');
  }
  if (req.method !== 'POST') {
    return rpcError(405, -32000, 'Method not allowed', { Allow: 'POST' });
  }

  try {
    const bytes = await readBody(req, MAX_REQUEST_BYTES);
    if (bytes === 'too large') return rpcError(413, -32000, 'Request body too large');
    if (bytes === 'too slow') return rpcError(408, -32000, 'Request body took too long to send');
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return rpcError(400, -32700, 'Invalid JSON');
    }
    if (parsedBody == null || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
      return rpcError(400, -32600, 'Send one JSON-RPC message');
    }

    const server = new McpServer(
      { name: 'mahnee', version: '1.0.0' },
      // The SDK's default schema validator requires runtime code generation.
      { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
    );
    const writable = mode === 'write';
    registerLedgerTools(server, env.DB, email, writable);
    if (writable) registerExpenseTool(server, env, email);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      const response = await transport.handleRequest(req, { parsedBody });
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'private, no-store');
      return new Response(response.body, { status: response.status, headers });
    } finally {
      await server.close();
    }
  } catch {
    return rpcError(500, -32603, 'Internal server error');
  }
}
