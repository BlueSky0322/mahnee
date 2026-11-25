import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { TOKENS } from '../src/testing/css';
import { LAUNCH_BACKGROUNDS, solidPng } from './launch-images';

// The first screen in index.html runs before the app's code, so it keeps its own copy of
// the backgrounds; the iPhone launch screens use the same ones.

test("the iPhone launch screens use the app's own backgrounds", () => {
  const tokens = readFileSync(new URL('../src/theme/tokens.css', import.meta.url), 'utf8');
  // Each theme's ground from its own rule: light on :root, dark under the dark scheme
  const ground = (selector: string) => {
    const block = new RegExp(`^${selector} \\{([^}]*)\\}`, 'm').exec(tokens)?.[1] ?? '';
    return /^\s*--ground:\s*(#[0-9a-f]{6});/m.exec(block)?.[1];
  };
  const light = ground(':root');
  const dark = ground(":root\\[data-mantine-color-scheme='dark'\\]");
  expect({ dark, light }).toEqual({
    dark: TOKENS.dark['--ground'],
    light: TOKENS.light['--ground'],
  });
  expect(LAUNCH_BACKGROUNDS).toEqual({ dark, light });
});

test('an iPhone launch screen is exactly the size asked for, or iOS shows white instead', () => {
  const png = solidPng(1179, 2556, LAUNCH_BACKGROUNDS.dark);
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1179, 2556]);
});
