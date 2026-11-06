import { useEffect, useState } from 'react';
import { useDataAge } from '../../ledger/useLedger';
import classes from './HomePage.module.css';

// How old the numbers on Home are, said only while they came from the copy kept on this
// device (offline, or the server hasn't answered yet): "Updated 2 hours ago". Fresh from
// the server, nothing is said.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const count = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;

/** How long ago `at` was, in words; `at` 0 when that isn't known */
function ago(at: number, now: number) {
  if (at === 0) return 'a while ago';
  const ms = now - at;
  if (ms < MINUTE_MS) return 'less than a minute ago';
  if (ms < HOUR_MS) return count(Math.floor(ms / MINUTE_MS), 'minute');
  if (ms < DAY_MS) return count(Math.floor(ms / HOUR_MS), 'hour');
  return count(Math.floor(ms / DAY_MS), 'day');
}

export default function Staleness({ month }: { month: string }) {
  const at = useDataAge(month);
  const [now, setNow] = useState(Date.now);
  // Kept up to date while it's shown
  useEffect(() => {
    if (at == null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [at]);
  if (at == null) return null;
  return <p className={classes.age}>Updated {ago(at, now)}</p>;
}
