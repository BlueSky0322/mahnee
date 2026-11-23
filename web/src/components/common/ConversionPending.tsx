import { isConverting } from '@shared/api';
import { useProfile } from '../../profile/ProfileContext';
import { CONVERSION_PENDING } from './typed-amount';
import classes from './MainAmount.module.css';

/**
 * Beside a total while every amount is being converted into a new home currency: "conversion
 * pending", as beside an entry waiting for its rate, saying the total is still in the old
 * currency and changes once it's done. Nothing otherwise.
 */
export default function ConversionPending() {
  const { profile } = useProfile();
  if (profile == null || !isConverting(profile)) return null;
  const { from, to } = profile.conversion!;
  return (
    <span
      className={classes.main}
      title={`In ${from} until every amount is converted to ${to}`}
    >
      {CONVERSION_PENDING}
    </span>
  );
}
