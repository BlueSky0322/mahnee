import type { ReactNode } from 'react';
import classes from './Chip.module.css';

interface ChipProps {
  /** Chosen: drawn in ink, and read as pressed */
  on: boolean;
  onClick?: () => void;
  /** It opens a list to choose from (a dialog), rather than turning on by itself */
  opens?: boolean;
  children: ReactNode;
}

/** A choice to tap on or off, such as a category to filter by */
const Chip = ({ on, onClick, opens, children }: ChipProps) => (
  <button
    type="button"
    className={classes.chip}
    aria-pressed={on}
    aria-haspopup={opens ? 'dialog' : undefined}
    onClick={onClick}
  >
    {children}
  </button>
);

export default Chip;
