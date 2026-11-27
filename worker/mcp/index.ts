import { getAccessSignIn, type AuthEnv } from '../accounts/auth';
import type { McpEnv } from '../app';
import { fail, notFound } from '../http';
import { handleMcp } from './server';

type Bindings = McpEnv &
  Pick<AuthEnv, 'ACCESS_TEAM_DOMAIN' | 'ACCESS_AUD' | 'ACCESS_MCP_AUD' | 'ACCESS_MCP_WRITE_AUD'>;

/** The dedicated workers.dev origin accepts only the audience assigned to the requested tool set. */
export default {
  async fetch(req, env): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path !== '/api/mcp' && path !== '/api/mcp/write') return notFound();
    const writer = path === '/api/mcp/write';
    const team = env.ACCESS_TEAM_DOMAIN?.trim();
    const web = env.ACCESS_AUD?.trim();
    const readerAudience = env.ACCESS_MCP_AUD?.trim();
    const writerAudience = env.ACCESS_MCP_WRITE_AUD?.trim();
    const audience = writer ? writerAudience : readerAudience;
    if (!team || !web || !audience || audience === web || readerAudience === writerAudience)
      return fail('Not signed in', 401);

    try {
      const signIn = await getAccessSignIn(req, team, audience);
      if (!signIn) return fail('Not signed in', 401);
      return handleMcp(req, env, signIn.email, writer ? 'write' : 'read');
    } catch {
      return fail('Could not verify sign-in. Try again.', 503);
    }
  },
} satisfies ExportedHandler<Bindings>;
