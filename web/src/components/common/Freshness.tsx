import { CloudArrowUp, CloudCheck, CloudSlash } from '@phosphor-icons/react';
import { useNetwork } from '@mantine/hooks';
import type { ReactNode } from 'react';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useDataAge, useLedgerShown, useUnsaved } from '../../ledger/useLedger';
import { isConverting } from '@shared/api';
import { useConversionProgress, useProfile, useSettingsSaving } from '../../profile/ProfileContext';
import type { FreshnessLabel } from './freshness-text';
import { convertedPercent, freshnessText } from './freshness-text';
import { useSaveTiming } from './useSaveTiming';
import classes from './Freshness.module.css';

// How fresh the figures are, always said, as a small cloud and a few words on one line
// that never grows: "Up to date" with a green tick once the server has confirmed them and
// nothing waits; "Saving" once a save has taken a moment, then "Saved" for a couple of
// seconds; an amber struck-through cloud with "From this device, 3 h old" while they come
// from the copy kept on this device, or "Offline · 2 changes waiting" while changes wait
// without a connection. Words that don't fit end in an ellipsis, whole in the tooltip and
// for screen readers. Home's open month (this month elsewhere) is what's judged, with the
// balances. Nothing is said until the accounts first load.

const ICONS = { check: CloudCheck, up: CloudArrowUp, slash: CloudSlash };
/** How long one label fades into the next; none where motion is reduced */
const FADE_MS = 160;

/** Whether to say "Saving" or "Saved" now, worked out once around every page */
const SaveTiming = createContext({ savingShown: false, justSaved: false });

/** What the label is worked out from, kept up to date as time passes; null while loading */
function useFreshnessState(month: string) {
  const shown = useLedgerShown();
  const { online } = useNetwork();
  const unsaved = useUnsaved();
  const { signedOut, refused } = unsaved;
  // Settings on their way count too, while there's a connection to send them on (offline,
  // they're kept on the device and said so when changed)
  const settingsSaving = useSettingsSaving();
  const waiting = unsaved.waiting + (online ? settingsSaving : 0);
  const at = useDataAge(month);
  const { profile } = useProfile();
  const converting = profile != null && isConverting(profile) ? profile.conversion! : null;
  const convertingTo = converting?.to ?? null;
  const percent = convertedPercent(useConversionProgress() ?? undefined);
  const [now, setNow] = useState(Date.now);
  // An age keeps counting while it's shown
  useEffect(() => {
    if (at == null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [at]);
  const state = {
    online,
    waiting,
    signedOut,
    convertingTo,
    convertedPercent: percent,
    at,
    now,
  };
  // Changes are on their way to a server that's answering
  const sending = online && !signedOut && convertingTo == null && at == null && waiting > 0;
  return { shown, state, sending, refused };
}

/** The label's words and look; null while loading */
function useFreshness(month: string) {
  const { shown, state } = useFreshnessState(month);
  const timing = useContext(SaveTiming);
  return shown ? freshnessText({ ...state, ...timing }) : null;
}

/**
 * Around every page: when to say "Saving" and "Saved", the same for every label however
 * many are drawn or opened meanwhile, and the label's problems said to screen readers,
 * once, politely (offline, signed out, the device's copy). Saving, saved and an age
 * counting up are never announced.
 */
export function FreshnessProvider({ month, children }: { month: string; children: ReactNode }) {
  const { shown, state, sending, refused } = useFreshnessState(month);
  const { savingShown, justSaved } = useSaveTiming({ sending, waiting: state.waiting, refused });
  const timing = useMemo(() => ({ savingShown, justSaved }), [savingShown, justSaved]);
  const say = shown ? freshnessText(state).say : null;
  return (
    <SaveTiming.Provider value={timing}>
      {children}
      <span
        aria-live="polite"
        data-freshness
        className={classes.unseen}
      >
        {say ?? ''}
      </span>
    </SaveTiming.Provider>
  );
}

/** The label before this one, for a moment while it fades out */
function useLeaving(label: FreshnessLabel | null) {
  const [leaving, setLeaving] = useState<FreshnessLabel | null>(null);
  const shown = useRef(label);
  const last = useRef(label);
  shown.current = label;
  const text = label?.text ?? null;
  useEffect(() => {
    const before = last.current;
    last.current = shown.current;
    if (before == null || text == null || before.text === text) return;
    setLeaving(before);
    const timer = setTimeout(() => setLeaving(null), FADE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  return leaving;
}

/**
 * The label, a cloud then its words. `onlyStale` says nothing while all is well (up to
 * date, saving or saved), for pages the design doesn't draw it on, so changes waiting still
 * show there. `reserve` keeps its line while loading, so what's under it doesn't move.
 * `compact` shows it in a few words ("3 waiting"), for the little room beside "Mahnee";
 * the whole words are still the tooltip and what's read out.
 */
export default function Freshness({
  month,
  onlyStale = false,
  reserve = false,
  compact = false,
  className,
}: {
  month: string;
  onlyStale?: boolean;
  reserve?: boolean;
  compact?: boolean;
  className?: string;
}) {
  const label = useFreshness(month);
  const leaving = useLeaving(label);
  if (label == null) {
    return reserve ? (
      <span
        aria-hidden
        className={`${classes.reserve} ${className ?? ''}`}
      />
    ) : null;
  }
  if (onlyStale && label.tone !== 'old') return null;
  const Icon = ICONS[label.icon];
  // The cloud fades only when it changes; the words whenever they do
  const iconChanged =
    leaving != null && (leaving.icon !== label.icon || leaving.tone !== label.tone);
  const Gone = iconChanged ? ICONS[leaving.icon] : null;
  const words = (shown: FreshnessLabel) => (compact ? shown.short : shown.text);
  return (
    <span
      className={`${classes.status} ${className ?? ''}`}
      title={label.text}
    >
      {/* The cloud keeps one place, whatever the words after it */}
      <span
        aria-hidden
        className={classes.iconSlot}
      >
        {Gone != null && (
          <Gone
            size={14}
            weight="bold"
            className={classes.leaving}
            data-tone={leaving!.tone}
          />
        )}
        <Icon
          key={`${label.icon} ${label.tone}`}
          size={14}
          weight="bold"
          data-tone={label.tone}
          data-entering={iconChanged || undefined}
        />
      </span>
      <span className={classes.words}>
        {leaving != null && (
          // Drawn from its attribute, so it's seen fading but never read or found as text
          <span
            aria-hidden
            className={`${classes.word} ${classes.leaving}`}
            data-text={words(leaving)}
          />
        )}
        {compact && label.short !== label.text ? (
          <span
            key={label.text}
            className={classes.word}
            data-entering={leaving != null || undefined}
          >
            <span aria-hidden>{label.short}</span>
            <span className={classes.unseen}>{label.text}</span>
          </span>
        ) : (
          <span
            key={label.text}
            className={classes.word}
            data-entering={leaving != null || undefined}
          >
            {label.text}
          </span>
        )}
      </span>
    </span>
  );
}

/**
 * The foot of Settings: "Mahnee · Up to date". `onlyStale` says nothing while all is well,
 * for Settings' own pages on phones and tablets, which the design draws without it.
 */
export function SettingsFooter({
  month,
  onlyStale = false,
}: {
  month: string;
  onlyStale?: boolean;
}) {
  const label = useFreshness(month);
  if (label == null || (onlyStale && label.tone !== 'old')) return null;
  return (
    <p
      className={classes.footer}
      title={`Mahnee · ${label.text}`}
    >
      Mahnee · {label.text}
    </p>
  );
}
