import { describe, expect, it } from 'vitest';
import { csvLine, openingCells } from './export';

describe('export lines', () => {
  it('keeps a negative amount a number, while text starting with "-" gets a \'', () => {
    const owed = openingCells({
      id: 'a'.repeat(16),
      name: '-Old card',
      currency: 'MYR',
      openingCents: -32_005,
      createdAt: Date.UTC(2026, 0, 3, 23, 59),
    });
    expect(csvLine(owed)).toBe(
      `2026-01-03,Opening balance,'-Old card,,-320.05,MYR,,,,,${'a'.repeat(16)}\r\n`,
    );
  });
});
