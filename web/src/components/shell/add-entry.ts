import { createContext, useContext } from 'react';

// A page's own way to open a new entry, the same one Add and New entry (or N) open: Activity's
// "Log your first one". Null outside the shell, or while no account can take one.
export const AddEntryContext = createContext<(() => void) | null>(null);

export const useAddEntry = () => useContext(AddEntryContext);
