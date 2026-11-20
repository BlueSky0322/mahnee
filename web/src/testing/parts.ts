import { MantineProvider } from '@mantine/core';
import { cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { afterEach, beforeEach, vi } from 'vitest';
import { buildTheme } from '../theme/theme';

// For tests of a single part (a picker, say) drawn on its own, at a phone's or a
// computer's width, without the whole app around it.

const WIDTHS = { desktop: 1280, phone: 390 };
export type PartSize = keyof typeof WIDTHS;

/** Sets the screen's width, as the breakpoints read it */
export function atSize(size: PartSize) {
  const width = WIDTHS[size];
  vi.stubGlobal('innerWidth', width);
  window.matchMedia = (query: string) => {
    const m = /\((min|max)-width:\s*([\d.]+)(em|px)\)/.exec(query);
    const px = m == null ? 0 : Number(m[2]) * (m[3] === 'em' ? 16 : 1);
    return {
      matches: m != null && (m[1] === 'min' ? width >= px : width <= px),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    };
  };
}

/** What jsdom lacks, set up before each test and taken down after */
export function setupPartTests() {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    window.history.replaceState(null, '', '/');
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
}

/** Draws `ui` in the app's theme */
export const showPart = (ui: ReactNode) =>
  render(createElement(MantineProvider, { theme: buildTheme() }, ui));
