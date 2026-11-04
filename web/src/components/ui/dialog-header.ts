import { createContext } from 'react';

/**
 * On a phone, the bottom sheet's header has room for a form's own buttons (Save, a
 * menu), where the keyboard can't cover them. Null on computers and outside a sheet.
 */
export const DialogHeaderSlot = createContext<HTMLElement | null>(null);
