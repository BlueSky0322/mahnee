import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import mkcert from 'vite-plugin-mkcert';
import { fileURLToPath } from 'node:url';
import { launchImages } from './build/launch-images';
import { precacheList } from './build/precache';

// The browser app. Built into ../dist, which the Worker serves (see wrangler.jsonc), with
// the list of files the service worker keeps for offline use (build/precache.ts) and the
// iPhone launch screens (build/launch-images.ts).
export default defineConfig({
  plugins: [react(), mkcert(), precacheList(), launchImages()],
  base: '/',
  // The same as web/tsconfig.json's paths
  resolve: { alias: { '@shared': fileURLToPath(new URL('../shared', import.meta.url)) } },
  build: { outDir: '../dist', emptyOutDir: true },
});
