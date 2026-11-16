import { createContext, useContext } from 'react';
import type { AddRequest } from '../entry/AddEntry';

// A page's own way to open a new entry, the same one Add and New entry (or N) open: Activity's
// "Log your first one", an account's Add here and Transfer. Without a request it opens as Add
// does; with one, as asked. Null outside the shell, or while no account can take one.
export const AddEntryContext = createContext<((request?: AddRequest) => void) | null>(null);

export const useAddEntry = () => useContext(AddEntryContext);
