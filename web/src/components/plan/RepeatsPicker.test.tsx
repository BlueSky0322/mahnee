// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { atSize, setupPartTests, showPart as show } from '../../testing/parts';
import RepeatsPicker from './RepeatsPicker';

// When a schedule repeats: Monthly or Weekly, then a day from a calendar or the week's row,
// under its row on a computer and in a sheet on a phone.

setupPartTests();

/** A Repeats picker that keeps what's picked, said as the schedule screens say it */
function KeptRepeats({ onChange }: { onChange: (schedule: string, day: number) => void }) {
  const [repeats, setRepeats] = useState<{ schedule: 'monthly' | 'weekly'; day: number }>({
    schedule: 'monthly',
    day: 18,
  });
  return (
    <RepeatsPicker
      label="Repeats"
      schedule={repeats.schedule}
      day={repeats.day}
      shown={`${repeats.schedule} ${repeats.day}`}
      onChange={(schedule, day) => {
        setRepeats({ schedule, day });
        onChange(schedule, day);
      }}
    />
  );
}

describe('the Repeats picker', () => {
  const repeats = () => screen.getByRole('combobox', { name: /^Repeats / });
  const checked = (group: HTMLElement) =>
    within(group)
      .getAllByRole('radio')
      .filter((r) => r.getAttribute('aria-checked') === 'true')
      .map((r) => r.getAttribute('aria-label') ?? r.textContent);

  test.each(['desktop', 'phone'] as const)(
    'picks a day of the month from a calendar, or a weekday from a row (%s)',
    async (size) => {
      atSize(size);
      const onChange = vi.fn();
      show(<KeptRepeats onChange={onChange} />);
      const user = userEvent.setup();
      expect(repeats().textContent).toBe('monthly 18');
      await user.click(repeats());
      const panel = await screen.findByRole('group', { name: 'Repeats' });
      if (size === 'phone') expect(screen.getByRole('dialog', { name: 'Repeats' })).toBeTruthy();
      expect(checked(within(panel).getByRole('radiogroup', { name: 'How often' }))).toEqual([
        'Monthly',
      ]);
      const month = within(panel).getByRole('radiogroup', { name: 'Day of the month' });
      expect(within(month).getAllByRole('radio')).toHaveLength(31);
      expect(checked(month)).toEqual(['18']);
      expect(within(panel).getByText(/or the month’s last day when it’s shorter/)).toBeTruthy();
      await user.click(within(month).getByRole('radio', { name: '31' }));
      expect(onChange).toHaveBeenCalledExactlyOnceWith('monthly', 31);
      await waitFor(() => expect(screen.queryByRole('group', { name: 'Repeats' })).toBeNull());
      expect(repeats().textContent).toBe('monthly 31');

      await user.click(repeats());
      const again = await screen.findByRole('group', { name: 'Repeats' });
      await user.click(within(again).getByRole('radio', { name: 'Weekly' }));
      const week = within(again).getByRole('radiogroup', { name: 'Day of the week' });
      expect(
        within(week)
          .getAllByRole('radio')
          .map((r) => r.textContent),
      ).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
      // Monthly on the 31st isn't a weekday: none is chosen yet, and nothing changed
      expect(checked(week)).toEqual([]);
      expect(within(again).queryByText(/last day/)).toBeNull();
      expect(onChange).toHaveBeenCalledTimes(1);
      await user.click(within(week).getByRole('radio', { name: 'Thursday' }));
      expect(onChange).toHaveBeenLastCalledWith('weekly', 4);
      await waitFor(() => expect(repeats().textContent).toBe('weekly 4'));
    },
  );

  test('on a computer, opens on the chosen day, and the arrows move through the calendar', async () => {
    atSize('desktop');
    const onChange = vi.fn();
    show(<KeptRepeats onChange={onChange} />);
    const user = userEvent.setup();
    act(() => repeats().focus());
    await user.keyboard('{Enter}');
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-checked')).toBe('true'));
    expect(document.activeElement?.textContent).toBe('18');
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement?.textContent).toBe('19');
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement?.textContent).toBe('26');
    await user.keyboard('{ArrowDown}');
    // No 33rd: the last day stays
    expect(document.activeElement?.textContent).toBe('31');
    await user.keyboard('{Home}{ArrowUp}{ArrowLeft}');
    expect(document.activeElement?.textContent).toBe('1');
    await user.keyboard('{End}{ArrowUp}{Enter}');
    expect(onChange).toHaveBeenCalledExactlyOnceWith('monthly', 24);
    await waitFor(() => expect(document.activeElement).toBe(repeats()));

    await user.keyboard('{Enter}');
    await screen.findByRole('group', { name: 'Repeats' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Repeats' })).toBeNull());
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('on a computer, Tab closes it, changing nothing, as a list does', async () => {
    atSize('desktop');
    const onChange = vi.fn();
    show(<KeptRepeats onChange={onChange} />);
    const user = userEvent.setup();
    expect(screen.getByRole('combobox', { name: 'Repeats monthly 18' })).toBeTruthy();
    await user.click(repeats());
    await screen.findByRole('group', { name: 'Repeats' });
    await waitFor(() => expect(document.activeElement?.textContent).toBe('18'));
    await user.keyboard('{Tab}');
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Repeats' })).toBeNull());
    expect(onChange).not.toHaveBeenCalled();
  });

  test('on a phone, Back closes its sheet and changes nothing', async () => {
    atSize('phone');
    const onChange = vi.fn();
    show(<KeptRepeats onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(repeats());
    await screen.findByRole('dialog', { name: 'Repeats' });
    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 20));
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onChange).not.toHaveBeenCalled();
  });
});
