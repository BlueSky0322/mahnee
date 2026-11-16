// Reading colours and fonts in a test (jsdom) the way a browser draws them. Tests don't
// process CSS, so a test puts the stylesheets it needs into the page itself, and these read
// what an element comes to through the cascade.
//
// jsdom cascades custom properties and lets them inherit, but leaves var() unresolved;
// resolve() finishes the job. It substitutes at the element read rather than where each
// variable is declared, and jsdom orders rules by where they are in the sheet rather than
// by specificity, so a pass here can still be wrong in a browser: each piece's sweep is
// the real-browser check.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { URL as NodeURL, fileURLToPath } from 'node:url';

/** The text of a file beside `base` (a test's import.meta.url) */
export const readBeside = (path: string, base: string) =>
  readFileSync(fileURLToPath(new NodeURL(path, base)), 'utf8');

/** Mantine's own stylesheet, as Root.tsx imports it */
export const mantineCss = () =>
  readFileSync(createRequire(import.meta.url).resolve('@mantine/core/styles.css'), 'utf8');

/** The app's tokens (theme/tokens.css) */
export const tokensCss = () => readBeside('../theme/tokens.css', import.meta.url);

/**
 * A CSS module's text with each class renamed as the module's import names it in tests, so
 * the page's elements match its rules
 */
export const moduleCss = (css: string, classes: Record<string, string>) =>
  css.replace(/\.([a-zA-Z_][\w-]*)/g, (whole, name: string) =>
    /^\d/.test(name) ? whole : `.${classes[name]}`,
  );

/** Puts `sheets` into the page, in order; returns what takes them out again */
export function addStyles(sheets: string[]) {
  const added = sheets.map((css) => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    return style;
  });
  return () => added.forEach((s) => s.remove());
}

/** Where `s` has its first comma outside brackets, or -1 */
function topLevelComma(s: string) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) return i;
  }
  return -1;
}

/** `value` with every var() replaced by what it comes to on `el` */
export function resolve(value: string, el: Element): string {
  let out = '';
  let i = 0;
  for (;;) {
    const at = value.indexOf('var(', i);
    if (at < 0) return (out + value.slice(i)).trim();
    out += value.slice(i, at);
    let depth = 0;
    let end = at + 3;
    for (; end < value.length; end++) {
      if (value[end] === '(') depth++;
      else if (value[end] === ')' && --depth === 0) break;
    }
    const inner = value.slice(at + 4, end);
    const comma = topLevelComma(inner);
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma < 0 ? '' : inner.slice(comma + 1);
    const own = getComputedStyle(el).getPropertyValue(name).trim();
    out += own !== '' ? resolve(own, el) : resolve(fallback, el);
    i = end + 1;
  }
}

/** A colour as lowercase #rrggbb, from hex or rgb(); anything else as it is, lowercased */
export function hex(colour: string) {
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*1)?\)$/.exec(colour);
  if (rgb == null) return colour.toLowerCase();
  return (
    '#' +
    rgb
      .slice(1, 4)
      .map((n) => Number(n).toString(16).padStart(2, '0'))
      .join('')
  );
}

/** What one property of `el` comes to, var()s resolved */
export const computed = (el: Element, property: string) =>
  resolve(getComputedStyle(el).getPropertyValue(property), el);

/** The background `el` is drawn with */
export function background(el: Element) {
  const style = getComputedStyle(el);
  const shorthand = style.getPropertyValue('background');
  const own = shorthand.includes('var(') ? shorthand : style.getPropertyValue('background-color');
  return hex(resolve(own, el));
}

/** The colour of `el`'s text */
export const textColour = (el: Element) => hex(computed(el, 'color'));

/** The font families `el` is set in, first choice first, without quotes */
export const fontFamilies = (el: Element) =>
  resolve(getComputedStyle(el).fontFamily, el)
    .split(',')
    .map((f) => f.trim().replace(/['"]/g, ''))
    .filter((f) => f !== '');

/** The design's colours (R-System board, paper-ledger.css), light and dark */
export const TOKENS = {
  light: {
    '--ground': '#f3f1ec',
    '--surface': '#ffffff',
    '--sunk': '#ebe8e1',
    '--ink': '#15161a',
    '--ink-2': '#44454b',
    '--ink-3': '#66665f',
    '--line': '#e2ded5',
    '--line-2': '#d3cec2',
    '--accent': '#2d4bd8',
    '--accent-ink': '#ffffff',
    '--accent-tint': '#e7ebfb',
    '--pos': '#1b7346',
    '--neg': '#b1392a',
    '--neg-tint': '#f8e4e0',
    '--due': '#8a5300',
    '--due-tint': '#f7ecd8',
    '--c1': '#3b6fd8',
    '--c2': '#d2652c',
    '--c3': '#17876a',
    '--c4': '#b8487a',
    '--c5': '#b58300',
    '--c6': '#7b62d0',
    '--float': '#15161a',
    '--float-ink': '#f3f1ec',
  },
  dark: {
    '--ground': '#0f1012',
    '--surface': '#18191c',
    '--sunk': '#222327',
    '--ink': '#edece7',
    '--ink-2': '#c2c1bb',
    '--ink-3': '#96958f',
    '--line': '#2a2b30',
    '--line-2': '#3a3b41',
    '--accent': '#93a5ff',
    '--accent-ink': '#0f1012',
    '--accent-tint': '#1f2440',
    '--pos': '#62c993',
    '--neg': '#f28b7c',
    '--neg-tint': '#3a1f1b',
    '--due': '#e8b25a',
    '--due-tint': '#33280f',
    '--c1': '#6f9bf0',
    '--c2': '#ef8a55',
    '--c3': '#45b896',
    '--c4': '#e07aa6',
    '--c5': '#d9a826',
    '--c6': '#a28ef0',
    '--float': '#2a2b30',
    '--float-ink': '#edece7',
  },
} as const;
