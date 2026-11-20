import { waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

// Choosing in the app's pickers (components/ui/Picker, RepeatsPicker) as a person does:
// open it, then tap the choice in the list or sheet it opens.

/** What a picker opened: its list, or its days */
async function opened(picker: HTMLElement) {
  return waitFor(() => {
    const id = picker.getAttribute('aria-controls');
    const found = id == null ? null : document.getElementById(id);
    if (found == null) throw new Error(`${picker.textContent ?? 'The picker'} isn't open`);
    return found;
  });
}

/** Opens a picker, and the list it opens */
export async function openPicker(user: UserEvent, picker: HTMLElement) {
  await user.click(picker);
  return within(await opened(picker));
}

/**
 * Waits, once a choice is made, until a phone's sheet has gone, so its title names nothing
 * any more; `sheet` is the sheet the panel was in while open
 */
async function closed(sheet: Element | null) {
  await waitFor(() => {
    if (sheet?.isConnected === true) throw new Error('The sheet is still closing');
  });
}

/** Picks the option named `option`, once it is listed */
export async function pick(user: UserEvent, picker: HTMLElement, option: string | RegExp) {
  await user.click(picker);
  const panel = await opened(picker);
  const sheet = panel.closest('[role="dialog"]');
  await user.click(await within(panel).findByRole('option', { name: option }));
  await closed(sheet);
}

/** Picks how often something repeats and its day: 12 of the month, or "Thursday" */
export async function pickRepeats(
  user: UserEvent,
  picker: HTMLElement,
  often: 'Monthly' | 'Weekly',
  day: number | string,
) {
  await user.click(picker);
  const panel = await opened(picker);
  const sheet = panel.closest('[role="dialog"]');
  const days = within(panel);
  await user.click(days.getByRole('radio', { name: often }));
  await user.click(days.getByRole('radio', { name: String(day) }));
  await closed(sheet);
}
