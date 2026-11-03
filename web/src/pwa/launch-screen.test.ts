// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { URL as NodeURL, fileURLToPath } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import { APPEARANCE_KEY } from '../profile/ProfileContext';
import { hideLaunchScreen } from './launch-screen';

// The first screen itself is index.html's (web/build/launch-images.test.ts runs it)

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

test('the first screen reads the theme where the app saves it', () => {
  const indexHtml = readFileSync(
    fileURLToPath(new NodeURL('../../index.html', import.meta.url)),
    'utf8',
  );
  expect(indexHtml).toContain(`localStorage.getItem('${APPEARANCE_KEY}')`);
});

test('the first screen gets out of the way once the app is up, even with motion turned down', async () => {
  document.body.innerHTML = '<div id="launch"></div>';
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  hideLaunchScreen();
  await vi.waitFor(() => expect(document.getElementById('launch')).toBeNull(), {
    timeout: 2000,
  });
});
