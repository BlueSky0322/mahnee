// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { hideStarted, isStartedHidden } from './getting-started';

// Hide on Getting started is kept on this device for the account signed in, and only for it

beforeEach(() => localStorage.clear());

describe('Getting started hidden', () => {
  it('is kept for the account that hid it, and no other', () => {
    hideStarted('ryan@example.com');
    expect(isStartedHidden('ryan@example.com')).toBe(true);
    expect(isStartedHidden('ann@example.com')).toBe(false);
  });

  it('is never kept, or read, without an account', () => {
    hideStarted('');
    expect(localStorage.length).toBe(0);
    localStorage.setItem('getting-started-hidden:', '1');
    expect(isStartedHidden('')).toBe(false);
  });
});
