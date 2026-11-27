import { fail } from '../http';
import { handleOAuth, type OAuthEnv } from './oauth';

export default {
  async fetch(req, env, ctx): Promise<Response> {
    try {
      return await handleOAuth(req, env, ctx);
    } catch {
      return fail('The connection service is unavailable. Try again.', 503);
    }
  },
} satisfies ExportedHandler<OAuthEnv>;
