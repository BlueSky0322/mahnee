import type { CSSProperties, ReactNode } from 'react';
import classes from './Skeleton.module.css';

interface SkeletonProps {
  /** A CSS width; a number is pixels */
  width?: number | string;
  /** A CSS height; a number is pixels */
  height?: number | string;
  /** Round, for an avatar */
  circle?: boolean;
  radius?: number | string;
  className?: string;
  style?: CSSProperties;
}

/**
 * A placeholder the size of something still loading, so the page keeps its shape until
 * it arrives. Hidden from screen readers; whatever holds it says what's loading.
 */
const Skeleton = ({ width, height = 12, circle, radius, className, style }: SkeletonProps) => (
  <span
    aria-hidden
    className={[classes.block, circle && classes.circle, className].filter(Boolean).join(' ')}
    style={{ width, height, borderRadius: radius, ...style }}
  />
);

export default Skeleton;

/** Skeletons standing in for a part of the page, read out to screen readers as `label` */
export const Loading = ({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) => (
  <div
    className={className}
    aria-busy
  >
    <span className="sr-only">{label}</span>
    {children}
  </div>
);
