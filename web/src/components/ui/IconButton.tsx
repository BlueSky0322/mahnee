import type { ReactNode } from 'react';
import classes from './IconButton.module.css';

interface IconButtonProps {
  /** What it does, in words: it shows only an icon */
  label: string;
  onClick?: () => void;
  children: ReactNode;
}

/** A round 44px button holding an icon, such as Previous month or Close */
const IconButton = ({ label, onClick, children }: IconButtonProps) => (
  <button
    type="button"
    aria-label={label}
    className={classes.button}
    onClick={onClick}
  >
    {children}
  </button>
);

export default IconButton;
