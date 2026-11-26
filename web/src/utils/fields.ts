// Where the keyboard is, for keys that do something on the page (useShortcuts, Esc putting
// a message away): never while a person types in a field, or while a dialog is open.

/** The kinds of input a person types into; a tick box, a choice or a button isn't one */
const TYPED_INPUTS = new Set([
  'text',
  'search',
  'number',
  'date',
  'datetime-local',
  'month',
  'week',
  'time',
  'email',
  'tel',
  'url',
  'password',
]);

/**
 * Whether `target` is where a person types: a text-like field, a list to pick from (the
 * browser's, or the app's pickers, open or closed), or editable text
 */
export function inField(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (
    target.isContentEditable ||
    target.closest('[contenteditable]:not([contenteditable="false"])')
  ) {
    return true;
  }
  const field = target.closest('input, textarea, select, [role="combobox"], [role="listbox"]');
  if (field == null) return false;
  return field instanceof HTMLInputElement ? TYPED_INPUTS.has(field.type) : true;
}

/** Whether a dialog or sheet is open, which takes the keys itself */
export const dialogOpen = () => document.querySelector('[role="dialog"]') != null;
