import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Kept apart from vite.config.ts so tests don't load vite-plugin-mkcert, which calls
// the GitHub API to fetch mkcert and fails when rate-limited.
export default defineConfig({
  // The same as web/tsconfig.json's paths
  resolve: { alias: { '@shared': fileURLToPath(new URL('./shared', import.meta.url)) } },
  test: {
    // A screen test renders the whole app and takes 1 to 4 s alone. With every file
    // running at once, or right after the pre-commit hook's build, the same test has
    // taken three to seven times as long, so the default 5 s failed correct tests at
    // random. 30 s leaves room for that; a test that hangs still fails, and a waitFor
    // gives up after 4 s (testing/app.ts) and says what it was waiting for.
    testTimeout: 30_000,
  },
});
