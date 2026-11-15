import type { ReactNode } from 'react';
import classes from './Badge.module.css';

/** A word in a pill: amber for something due, red for over, grey for set aside */
export const Badge = ({
  tone,
  children,
}: {
  tone: 'due' | 'neg' | 'soft';
  children: ReactNode;
}) => (
  <span
    className={classes.badge}
    data-tone={tone}
  >
    {children}
  </span>
);

/** A small red count, read as what it counts ("2 new") */
export const CountBadge = ({ count, label }: { count: number; label: string }) => (
  <span
    role="img"
    aria-label={label}
    className={classes.count}
  >
    {count}
  </span>
);

/** Marks something new */
export const NewTag = () => <span className={classes.new}>New</span>;
