import { useState } from 'react';
import classes from './YouPicture.module.css';

/**
 * Inside the round initial: the person's picture when there is one, filling the circle
 * the initial is drawn in (its size and shape come from the caller's class), else the
 * initial. One that can't be loaded (offline with no copy kept) shows the initial.
 */
export default function YouPicture({
  initial,
  picture,
}: {
  initial: string;
  picture: string | null;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (picture == null || failed === picture) return initial;
  return (
    <img
      className={classes.picture}
      src={picture}
      alt="Your picture"
      draggable={false}
      onError={() => setFailed(picture)}
    />
  );
}
