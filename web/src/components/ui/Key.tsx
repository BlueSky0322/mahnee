import type { ReactNode } from 'react';
import classes from './Key.module.css';

/** A key to press, drawn as a keycap; hidden from screen readers, which read the label */
const Key = ({ children }: { children: ReactNode }) => (
  <kbd
    className={classes.key}
    aria-hidden
  >
    {children}
  </kbd>
);

export default Key;
