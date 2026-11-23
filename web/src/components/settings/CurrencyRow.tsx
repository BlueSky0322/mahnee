import { Button, Popover } from '@mantine/core';
import { useNetwork } from '@mantine/hooks';
import { useId, useState } from 'react';
import type { Conversion, Profile, Settings } from '@shared/api';
import { isConverting } from '@shared/api';
import { MAX_TRANSACTION } from '@shared/ledger';
import { HOME_CURRENCIES } from '@shared/rates';
import { api } from '../../api';
import { useConversionProgress, useProfile } from '../../profile/ProfileContext';
import { currencySign } from '../../utils/currencies';
import { showError } from '../../utils/notify';
import CurrencyList from '../common/CurrencyList';
import { convertedPercent, convertingText } from '../common/freshness-text';
import { DownIcon, ForwardIcon } from '../ui/icons';
import ResponsiveDialog from '../ui/ResponsiveDialog';
import classes from './Settings.module.css';
import money from './MoneyPage.module.css';

// Settings › Money › Main currency (R-Set-Money-Cur, R-Desk-Set-Money-Cur; owner decisions D2
// to D5): the home currency every amount is kept and shown in, reading "MYR, RM". It opens a
// picker (a sheet on phones, a panel under the row on computers) with a search and the
// groups "You use" and "All currencies"; picking one closes it and saves it at once, through
// the profile. The server then converts every amount into it in the background: until it's
// done the row says "Converting to USD…" and can't be changed again. A change refused for an
// amount past its limit is said under the row. It needs a connection.

/** How long to wait for a frame: a hidden tab or a backgrounded app draws none */
const FRAME_WAIT_MS = 100;

/**
 * Resolves once what's changed so far has been drawn (the next frame, then a turn after
 * it), or after FRAME_WAIT_MS without a frame, whichever comes first
 */
const afterPaint = () =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, FRAME_WAIT_MS);
    if (typeof requestAnimationFrame !== 'function') return;
    requestAnimationFrame(() =>
      setTimeout(() => {
        clearTimeout(timer);
        resolve();
      }, 0),
    );
  });

/** "MYR, RM", as the row reads */
const currencyValue = (code: string) => `${code}, ${currencySign(code)}`;

/** The most an amount can be, as the refusal says it: "10,000,000" */
const MOST = MAX_TRANSACTION.toLocaleString('en-US');

/** Why a change of currency was refused, naming the limit and the currency kept */
function refusedText({ from, to, refused }: Conversion) {
  const what = {
    amount: `an entry would come to more than ${MOST} ${to}`,
    opening: `an opening balance would come to more than ${MOST} ${to} either way`,
    budget: `a budget would come to more than ${MOST} ${to}`,
    scheduled: `a scheduled item would come to more than ${MOST} ${to}`,
    rates: `rates for ${to} weren't available, so nothing was converted. Try again later`,
  }[refused ?? 'amount'];
  return `Kept ${from}: ${what}`;
}

/** What's said under the row: converting, refused, or that it needs a connection */
function statusOf(profile: Profile, online: boolean, progress: Conversion['progress'] | null) {
  const { conversion } = profile;
  if (conversion != null && isConverting(profile)) {
    return convertingText(conversion.to, convertedPercent(progress ?? undefined));
  }
  if (!online) return 'Connect to change the currency';
  if (conversion?.refused != null) return refusedText(conversion);
  return null;
}

export default function CurrencyRow({
  settings,
  isDesktop,
  rowClass,
  name,
  line,
  settingKey,
}: {
  settings: Settings;
  isDesktop: boolean;
  rowClass: string;
  name: string;
  line: string;
  settingKey: string;
}) {
  const { profile, change } = useProfile();
  const progress = useConversionProgress();
  const { online } = useNetwork();
  const [open, setOpen] = useState(false);
  const panelName = useId();
  if (profile == null) return null;
  const value = currencyValue(settings.currency);
  const status = statusOf(profile, online, progress);
  const locked = !online || isConverting(profile);

  const pick = (currency: string) => {
    setOpen(false);
    if (currency === profile.settings.currency) return;
    // The picker closes and that's drawn first; the new currency, which every screen draws,
    // follows on the next turn, so the tap answers at once however much there is to draw
    void afterPaint().then(() =>
      change(
        (p) => ({
          ...p,
          settings: { ...p.settings, currency },
          conversion: { from: p.settings.currency, to: currency, since: Date.now(), refused: null },
        }),
        () => api.updateMe({ settings: { currency } }),
      ).catch((err: unknown) => showError(err, 'Could not change the currency')),
    );
  };

  const statusLine = status != null && (
    <span
      className={classes.detail}
      role="status"
    >
      {status}
    </span>
  );
  // Refused (an amount past its limit, or rates that never came): the same change can be
  // asked for again from here
  const refusedTo = profile.conversion?.refused != null && !locked ? profile.conversion.to : null;
  const retry = refusedTo != null && (
    <Button
      variant="subtle"
      size="compact-sm"
      className={money.retry}
      onClick={() => pick(refusedTo)}
    >
      {`Try ${refusedTo} again`}
    </Button>
  );
  const picker = (
    <Picker
      current={settings.currency}
      onPick={pick}
    />
  );

  if (isDesktop) {
    return (
      <div
        className={rowClass}
        data-setting={settingKey}
        tabIndex={-1}
      >
        <div className={classes.rowText}>
          <div className={classes.label}>{name}</div>
          <div className={classes.detail}>{line}</div>
          {statusLine}
          {retry}
        </div>
        <Popover
          opened={open}
          onChange={setOpen}
          position="bottom-end"
          offset={6}
          width={360}
          trapFocus
          returnFocus
          classNames={{ dropdown: money.pop }}
        >
          <Popover.Target>
            <Button
              variant="default"
              size="xs"
              aria-label={`${name}: ${value}`}
              aria-haspopup="dialog"
              aria-expanded={open}
              disabled={locked}
              rightSection={<DownIcon size={14} />}
              onClick={() => setOpen((o) => !o)}
            >
              {value}
            </Button>
          </Popover.Target>
          <Popover.Dropdown aria-labelledby={panelName}>
            <h2
              id={panelName}
              className="sr-only"
            >
              {name}
            </h2>
            {open && picker}
          </Popover.Dropdown>
        </Popover>
      </div>
    );
  }

  return (
    <>
      <div
        className={`${rowClass} ${money.rowHolder}`}
        data-setting={settingKey}
        tabIndex={-1}
      >
        <button
          type="button"
          className={money.rowButton}
          disabled={locked}
          onClick={() => setOpen(true)}
        >
          <span className={classes.rowText}>
            <span className={classes.label}>{name}</span>
            <span className={classes.detail}>{line}</span>
            {statusLine}
          </span>
          <span className={classes.value}>{value}</span>
          <ForwardIcon
            size={16}
            className={classes.caret}
          />
        </button>
        {retry}
      </div>
      <ResponsiveDialog
        opened={open}
        onClose={() => setOpen(false)}
        title={name}
        closeLabel="Done"
      >
        {open && picker}
      </ResponsiveDialog>
    </>
  );
}

/** The search, then the one in use and every other, each with its name and symbol */
const Picker = ({ current, onPick }: { current: string; onPick: (code: string) => void }) => (
  <CurrencyList
    groups={[
      ['You use', [current]],
      ['All currencies', HOME_CURRENCIES.filter((c) => c !== current)],
    ]}
    current={current}
    onPick={onPick}
    note="Every amount is converted at the rate on its own day. Changing back restores them exactly."
  />
);
