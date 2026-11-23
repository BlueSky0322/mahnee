import type { CSSProperties, ReactNode } from 'react';
import classes from './Skeleton.module.css';

// Placeholders the shape of what a page is still waiting for, so it keeps its shape until it
// arrives. Each block stays clear for its first moments (Skeleton.module.css), so what comes
// quickly, or is read from the device, never flashes one on and off; with reduced motion
// they're still blocks, with no sweep of light. Hidden from screen readers: whatever holds
// them (Loading) is marked busy and says once what's loading.

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

/** A placeholder the size of something still loading */
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

/**
 * A card of list rows still loading, read out as `label`: each with a square for its
 * icon (unless `icons` is false), a title and a line under it, and an amount or value at
 * the end
 */
export const LoadingRows = ({
  label,
  rows = 4,
  icons = true,
  className,
}: {
  label: string;
  rows?: number;
  icons?: boolean;
  className?: string;
}) => (
  <Loading
    label={label}
    className={[classes.card, className].filter(Boolean).join(' ')}
  >
    {Array.from({ length: rows }, (_, i) => (
      <div
        key={i}
        className={classes.row}
      >
        {icons && (
          <Skeleton
            width={36}
            height={36}
            radius={10}
          />
        )}
        <span className={classes.text}>
          <Skeleton
            width={i % 2 === 0 ? '45%' : '35%'}
            height={14}
          />
          <Skeleton
            width={i % 2 === 0 ? '60%' : '50%'}
            height={10}
          />
        </span>
        <Skeleton
          width={56}
          height={14}
        />
      </div>
    ))}
  </Loading>
);
