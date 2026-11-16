import { useNetwork } from '@mantine/hooks';
import { useEffect, useState } from 'react';
import { useDataAge, useLedgerShown, useUnsaved } from '../../ledger/useLedger';
import { freshnessText } from './freshness-text';
import classes from './Freshness.module.css';

// How fresh the figures are, always said: "Up to date" with a green dot once the server
// has confirmed them and nothing waits; an amber dot with "From this device, 3 h old"
// while they come from the copy kept on this device, or "Offline · 2 changes waiting to
// save" while changes wait without a connection. Home's open month (this month elsewhere)
// is what's judged, with the balances. Nothing is said until the accounts first load.

/** The label's words and kind, kept up to date as time passes; null while loading */
function useFreshness(month: string) {
  const shown = useLedgerShown();
  const { online } = useNetwork();
  const { waiting, signedOut } = useUnsaved();
  const at = useDataAge(month);
  const [now, setNow] = useState(Date.now);
  // An age keeps counting while it's shown
  useEffect(() => {
    if (at == null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [at]);
  if (!shown) return null;
  return freshnessText({ online, waiting, signedOut, at, now });
}

/**
 * The label, a dot then its words. `onlyStale` says nothing while it's up to date (pages
 * the design doesn't draw it on, so changes waiting still show there). `reserve` keeps its
 * line while loading, so what's under it doesn't move.
 */
export default function Freshness({
  month,
  onlyStale = false,
  reserve = false,
  className,
}: {
  month: string;
  onlyStale?: boolean;
  reserve?: boolean;
  className?: string;
}) {
  const label = useFreshness(month);
  if (label == null) {
    return reserve ? (
      <span
        aria-hidden
        className={`${classes.reserve} ${className ?? ''}`}
      />
    ) : null;
  }
  if (onlyStale && label.fresh) return null;
  return (
    <span className={`${classes.fresh} ${label.fresh ? '' : classes.old} ${className ?? ''}`}>
      {label.text}
    </span>
  );
}

/**
 * The foot of Settings: "Mahnee · Up to date". `onlyStale` says nothing while it's up to
 * date, for Settings' own pages on phones and tablets, which the design draws without it.
 */
export function SettingsFooter({
  month,
  onlyStale = false,
}: {
  month: string;
  onlyStale?: boolean;
}) {
  const label = useFreshness(month);
  if (label == null || (onlyStale && label.fresh)) return null;
  return <p className={classes.footer}>Mahnee · {label.text}</p>;
}
