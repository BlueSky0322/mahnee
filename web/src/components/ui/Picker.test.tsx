// @vitest-environment jsdom
import { Modal } from '@mantine/core';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { atSize, setupPartTests, showPart as show } from '../../testing/parts';
import Picker from './Picker';
import type { PickerOption } from './Picker';

// The app's own picker, in place of the browser's list: a list under the field on a
// computer, a sheet on a phone that Back closes, worked by keys as well as taps.

setupPartTests();

const ACCOUNTS: PickerOption[] = [
  { value: 'a1', label: 'Maybank', group: 'Banks' },
  { value: 'a2', label: 'CIMB', group: 'Banks' },
  { value: 'a3', label: 'Wallet', group: 'Cash' },
  { value: 'a4', label: 'Coins jar', group: 'Cash', disabled: true },
  { value: 'a5', label: 'Card', group: 'Cash' },
];

/** A picker that keeps what's picked, and says each change */
function Kept({
  options = ACCOUNTS,
  start = 'a1',
  onChange = () => {},
}: {
  options?: (PickerOption | string)[];
  start?: string;
  onChange?: (value: string) => void;
}) {
  const [value, setValue] = useState(start);
  return (
    <Picker
      label="Account"
      value={value}
      options={options}
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
    />
  );
}

const field = () => screen.getByRole('combobox', { name: /^Account / });
const activeName = (list: HTMLElement) =>
  document.getElementById(list.getAttribute('aria-activedescendant') ?? '')?.textContent;

describe('a picker on a computer', () => {
  beforeEach(() => atSize('desktop'));

  test('says what is chosen, lists the choices in their groups, and picks by tapping', async () => {
    const onChange = vi.fn();
    show(<Kept onChange={onChange} />);
    const user = userEvent.setup();
    expect(field().textContent).toBe('Maybank');
    expect(field().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('listbox')).toBeNull();

    await user.click(field());
    const list = await screen.findByRole('listbox', { name: 'Account' });
    expect(field().getAttribute('aria-expanded')).toBe('true');
    // The list takes focus, on the one chosen, which is ticked
    await waitFor(() => expect(document.activeElement).toBe(list));
    expect(activeName(list)).toBe('Maybank');
    expect(
      within(list)
        .getAllByRole('option', { selected: true })
        .map((o) => o.textContent),
    ).toEqual(['Maybank']);
    const banks = within(list).getByRole('group', { name: 'Banks' });
    expect(
      within(banks)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Maybank', 'CIMB']);
    const cash = within(list).getByRole('group', { name: 'Cash' });
    expect(
      within(cash)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Wallet', 'Coins jar', 'Card']);
    // Short, so no search
    expect(screen.queryByRole('searchbox')).toBeNull();

    await user.click(within(list).getByRole('option', { name: 'Wallet' }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('a3');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(field().textContent).toBe('Wallet');
    expect(document.activeElement).toBe(field());
  });

  test('is worked by keys: arrows, Home and End past what is off, letters, Enter', async () => {
    const onChange = vi.fn();
    show(<Kept onChange={onChange} />);
    const user = userEvent.setup();
    act(() => field().focus());
    await user.keyboard('{ArrowDown}');
    const list = await screen.findByRole('listbox', { name: 'Account' });
    await waitFor(() => expect(document.activeElement).toBe(list));
    await user.keyboard('{ArrowDown}');
    expect(activeName(list)).toBe('CIMB');
    await user.keyboard('{ArrowDown}{ArrowDown}');
    // Coins jar can't be picked, so the keys go past it
    expect(activeName(list)).toBe('Card');
    await user.keyboard('{ArrowDown}');
    expect(activeName(list)).toBe('Card');
    await user.keyboard('{Home}');
    expect(activeName(list)).toBe('Maybank');
    await user.keyboard('{End}');
    expect(activeName(list)).toBe('Card');
    // A letter jumps to the first that starts with it, again to the next
    await user.keyboard('c');
    expect(activeName(list)).toBe('CIMB');
    await user.keyboard('c');
    expect(activeName(list)).toBe('Card');
    // Letters a moment apart start again
    await act(() => new Promise((r) => setTimeout(r, 750)));
    await user.keyboard('w');
    expect(activeName(list)).toBe('Wallet');
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledExactlyOnceWith('a3');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(document.activeElement).toBe(field());

    // A letter on the closed picker opens it at the first choice that letter starts
    await user.keyboard('c');
    const again = await screen.findByRole('listbox', { name: 'Account' });
    expect(activeName(again)).toBe('CIMB');
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('a2');
  });

  test('Escape closes it, changing nothing, and leaves the dialog it is in open', async () => {
    const onChange = vi.fn();
    show(
      <Modal
        opened
        onClose={() => {
          throw new Error('The dialog closed');
        }}
        title="Edit"
      >
        <Kept onChange={onChange} />
      </Modal>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: /^Account / }));
    await screen.findByRole('listbox', { name: 'Account' });
    await user.keyboard('{ArrowDown}{Escape}');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Edit' })).toBeTruthy();
    expect(field().textContent).toBe('Maybank');
  });

  test('a long list has a search, which narrows it and keeps the keys working', async () => {
    const onChange = vi.fn();
    const months = [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
      'Someday',
    ];
    show(
      <Kept
        options={months}
        start="May"
        onChange={onChange}
      />,
    );
    const user = userEvent.setup();
    await user.click(field());
    const search = await screen.findByRole('searchbox', { name: 'Search account' });
    await waitFor(() => expect(document.activeElement).toBe(search));
    await user.type(search, 'ber');
    const list = screen.getByRole('listbox', { name: 'Account' });
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['September', 'October', 'November', 'December']);
    expect(activeName(list)).toBe('September');
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(search.getAttribute('aria-activedescendant')).toBe(
      list.getAttribute('aria-activedescendant'),
    );
    expect(activeName(list)).toBe('November');
    await user.clear(search);
    await user.type(search, 'xyz');
    expect(within(list).queryAllByRole('option')).toEqual([]);
    expect(screen.getByText('Nothing matches “xyz”')).toBeTruthy();
    await user.keyboard('{Enter}');
    expect(onChange).not.toHaveBeenCalled();
    await user.clear(search);
    await user.type(search, 'nov{Enter}');
    expect(onChange).toHaveBeenCalledExactlyOnceWith('November');
  });

  test('a group named in two words names its options for a screen reader', async () => {
    show(
      <Kept
        start="f1"
        options={[
          { value: 'f1', label: 'Kopi', group: 'Eating out' },
          { value: 'f2', label: 'Nasi lemak', group: 'Eating out' },
          { value: 'g1', label: 'Rice', group: 'Food & drink' },
        ]}
      />,
    );
    await userEvent.setup().click(field());
    const list = await screen.findByRole('listbox', { name: 'Account' });
    const out = within(list).getByRole('group', { name: 'Eating out' });
    expect(
      within(out)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Kopi', 'Nasi lemak']);
    expect(within(list).getByRole('group', { name: 'Food & drink' })).toBeTruthy();
  });

  test.each(['field', 'row', 'plain'] as const)(
    'says its name and what is chosen, closed (%s)',
    async (look) => {
      function Looked() {
        const [chosen, choose] = useState('a1');
        return (
          <Picker
            look={look}
            label="Account"
            value={chosen}
            options={ACCOUNTS}
            onChange={choose}
          />
        );
      }
      show(<Looked />);
      const user = userEvent.setup();
      expect(screen.getByRole('combobox', { name: 'Account Maybank' })).toBeTruthy();
      await user.click(screen.getByRole('combobox', { name: 'Account Maybank' }));
      await user.click(await screen.findByRole('option', { name: 'Wallet' }));
      await waitFor(() =>
        expect(screen.getByRole('combobox', { name: 'Account Wallet' })).toBeTruthy(),
      );
    },
  );

  test('what is chosen but not listed shows its prompt, quieter', () => {
    show(
      <Picker
        label="Category"
        value=""
        placeholder="Pick a category"
        options={['Food', 'Bills']}
        onChange={() => {}}
      />,
    );
    const picker = screen.getByRole('combobox', { name: /^Category / });
    expect(picker.textContent).toBe('Pick a category');
    expect(picker.querySelector('[data-prompt]')).not.toBeNull();
  });
});

describe('a picker on a phone', () => {
  beforeEach(() => atSize('phone'));

  test('opens a sheet with the choices, ticks the chosen one, and picks with a tap', async () => {
    const onChange = vi.fn();
    show(<Kept onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(field());
    const sheet = await screen.findByRole('dialog', { name: 'Account' });
    const list = within(sheet).getByRole('listbox', { name: 'Account' });
    expect(within(list).getByRole('option', { selected: true }).textContent).toBe('Maybank');
    expect(within(list).getByRole('group', { name: 'Cash' })).toBeTruthy();
    await user.click(within(list).getByRole('option', { name: 'CIMB' }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('a2');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(field().textContent).toBe('CIMB');
  });

  test('Back closes the sheet and changes nothing', async () => {
    const onChange = vi.fn();
    show(<Kept onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(field());
    await screen.findByRole('dialog', { name: 'Account' });
    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 20));
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onChange).not.toHaveBeenCalled();
    expect(field().textContent).toBe('Maybank');
  });

  test('Cancel closes it too', async () => {
    show(<Kept />);
    const user = userEvent.setup();
    await user.click(field());
    const sheet = await screen.findByRole('dialog', { name: 'Account' });
    await user.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
