import type { ReactNode } from 'react';
import classes from './Chip.module.css';

interface ChipProps {
  /** Chosen: drawn in ink, and read as pressed */
  on: boolean;
  onClick?: () => void;
  children: ReactNode;
}

/** A choice to tap on or off, such as a category to filter by */
const Chip = ({ on, onClick, children }: ChipProps) => (
  <button
    type="button"
    className={classes.chip}
    aria-pressed={on}
    onClick={onClick}
  >
    {children}
  </button>
);

export default Chip;
