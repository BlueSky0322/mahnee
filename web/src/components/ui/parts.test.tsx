// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  addStyles,
  background,
  computed,
  moduleCss,
  readBeside,
  textColour,
  tokensCss,
} from '../../testing/css';
import { Badge, CountBadge, NewTag } from './Badge';
import badgeCss from './Badge.module.css';
import Bar from './Bar';
import barCss from './Bar.module.css';
import Chip from './Chip';
import chipCss from './Chip.module.css';
import Tile from './Tile';
import tileCss from './Tile.module.css';

// The small parts the "Paper ledger" screens are built from (the design's R-System
// board). Each says in words what its colour shows; the colours are read in the light
// theme through the parts' own stylesheets and the app's tokens.

const here = import.meta.url;
const sheets = [
  tokensCss(),
  moduleCss(readBeside('./Badge.module.css', here), badgeCss),
  moduleCss(readBeside('./Bar.module.css', here), barCss),
  moduleCss(readBeside('./Chip.module.css', here), chipCss),
  moduleCss(readBeside('./Tile.module.css', here), tileCss),
];

beforeEach(() => addStyles(sheets));
afterEach(cleanup);

describe('a chip', () => {
  test('is a button that says whether it is on, and turns on when tapped', async () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <Chip
        on={false}
        onClick={onClick}
      >
        Groceries
      </Chip>,
    );
    const chip = screen.getByRole('button', { name: 'Groceries' });
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    await userEvent.click(chip);
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <Chip
        on
        onClick={onClick}
      >
        Groceries
      </Chip>,
    );
    expect(screen.getByRole('button', { name: 'Groceries' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  test('works from the keyboard, with Enter and with Space', async () => {
    const onClick = vi.fn();
    render(
      <Chip
        on={false}
        onClick={onClick}
      >
        Today
      </Chip>,
    );
    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  test('is drawn on the surface when off, and in ink with ground-coloured text when on', () => {
    const { rerender } = render(<Chip on={false}>Groceries</Chip>);
    const off = screen.getByRole('button', { name: 'Groceries' });
    expect([background(off), textColour(off)]).toEqual(['#ffffff', '#15161a']);
    rerender(<Chip on>Groceries</Chip>);
    const on = screen.getByRole('button', { name: 'Groceries' });
    expect([background(on), textColour(on)]).toEqual(['#15161a', '#f3f1ec']);
  });
});

describe('a budget bar', () => {
  test('gives its facts in words, with how much is spent as its value', () => {
    render(
      <Bar
        label="Food: 27% of budget spent, a third of the month gone"
        spent={27}
        today={33}
        state="on-track"
      />,
    );
    const bar = screen.getByRole('meter', {
      name: 'Food: 27% of budget spent, a third of the month gone',
    });
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
    expect(bar.getAttribute('aria-valuenow')).toBe('27');
  });

  test('fills as far as is spent and marks how much of the month has gone', () => {
    render(
      <Bar
        label="Food"
        spent={79}
        today={33}
        state="faster"
      />,
    );
    const bar = screen.getByRole('meter', { name: 'Food' });
    expect(bar.querySelector<HTMLElement>('[data-part="fill"]')?.style.width).toBe('79%');
    expect(bar.querySelector<HTMLElement>('[data-part="today"]')?.style.left).toBe('33%');
  });

  test('over budget, it fills the whole track and no further', () => {
    render(
      <Bar
        label="Food: over budget"
        spent={140}
        today={50}
        state="over"
      />,
    );
    const bar = screen.getByRole('meter', { name: 'Food: over budget' });
    expect(bar.getAttribute('aria-valuenow')).toBe('100');
    expect(bar.querySelector<HTMLElement>('[data-part="fill"]')?.style.width).toBe('100%');
  });

  test.each([
    ['on-track', '#15161a'],
    ['faster', '#8a5300'],
    ['over', '#b1392a'],
  ] as const)(
    'when %s it fills in its colour, on a sunk track with a grey today marker',
    (state, fill) => {
      render(
        <Bar
          label="Food"
          spent={50}
          today={40}
          state={state}
        />,
      );
      const bar = screen.getByRole('meter', { name: 'Food' });
      expect({
        track: background(bar),
        fill: background(bar.querySelector('[data-part="fill"]')!),
        today: background(bar.querySelector('[data-part="today"]')!),
      }).toEqual({ track: '#ebe8e1', fill, today: '#66665f' });
    },
  );
});

describe('badges', () => {
  test('say what they mean in words, each in its own colours', () => {
    render(
      <>
        <Badge tone="neg">Over</Badge>
        <Badge tone="soft">Archived</Badge>
        <Badge tone="due">To check</Badge>
        <NewTag />
      </>,
    );
    const drawn = (word: string) => {
      const el = screen.getByText(word);
      return [background(el), textColour(el)];
    };
    expect({
      'Over': drawn('Over'),
      'Archived': drawn('Archived'),
      'To check': drawn('To check'),
      'New': drawn('New'),
    }).toEqual({
      'Over': ['#f8e4e0', '#b1392a'],
      'Archived': ['#ebe8e1', '#44454b'],
      'To check': ['#f7ecd8', '#8a5300'],
      'New': ['#e7ebfb', '#2d4bd8'],
    });
  });

  test('a count badge shows the number in red and is read as what it counts', () => {
    render(
      <CountBadge
        count={2}
        label="2 new"
      />,
    );
    const badge = screen.getByRole('img', { name: '2 new' });
    expect(badge.textContent).toBe('2');
    expect([background(badge), textColour(badge)]).toEqual(['#b1392a', '#ffffff']);
  });
});

describe('a tile', () => {
  test("shows a category's first letter in its colour on a tint of it, hidden from screen readers", () => {
    const { container } = render(
      <Tile
        name="Food"
        colour="var(--c3)"
      />,
    );
    const tile = container.firstElementChild as HTMLElement;
    expect(tile.textContent).toBe('F');
    expect(tile.getAttribute('aria-hidden')).toBe('true');
    expect(textColour(tile)).toBe('#17876a');
    expect(computed(tile, 'background-color') || computed(tile, 'background')).toBe(
      'color-mix(in srgb, #17876a 14%, #ffffff)',
    );
  });

  test.each([
    ['épicerie', 'É'],
    ['\u{1D509}ood', '\u{1D509}'],
  ])('takes the first whole letter of %s, in capitals', (name, letter) => {
    const { container } = render(
      <Tile
        name={name}
        colour="var(--c1)"
      />,
    );
    expect(container.firstElementChild?.textContent).toBe(letter);
  });

  test('without a name, shows its icon on the sunk colour, still hidden from screen readers', () => {
    const { container } = render(
      <Tile>
        <svg data-icon="transfer" />
      </Tile>,
    );
    const tile = container.firstElementChild as HTMLElement;
    expect(tile.querySelector('svg[data-icon="transfer"]')).not.toBeNull();
    expect(tile.getAttribute('aria-hidden')).toBe('true');
    expect([background(tile), textColour(tile)]).toEqual(['#ebe8e1', '#44454b']);
  });
});

test('clicking a chip leaves the form unsubmitted', async () => {
  const submit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
  render(
    <form onSubmit={submit}>
      <Chip
        on={false}
        onClick={() => {}}
      >
        Today
      </Chip>
    </form>,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Today' }));
  expect(submit).not.toHaveBeenCalled();
});
