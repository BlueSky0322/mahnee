import { Menu } from '@mantine/core';
import { useState } from 'react';
import type { Settings } from '@shared/api';
import { ENTRY_CURRENCIES, MAX_OTHER_CURRENCIES } from '@shared/rates';
import { useProfile } from '../../profile/ProfileContext';
import { currencyName } from '../../utils/currencies';
import CurrencyList from '../common/CurrencyList';
import ResponsiveDialog from '../ui/ResponsiveDialog';
import { OnOff } from './setting-parts';
import classes from './Settings.module.css';
import money from './MoneyPage.module.css';

// Settings › Money › Other currencies (R-Set-Money, R-Desk-Prefs): the currencies Add offers
// after the main one, as chips in the person's order, with "Add". Add opens every currency
// not in use yet, with a search; a chip opens Move earlier, Move later and Remove. At most
// MAX_OTHER_CURRENCIES. With any, "Follow where I am" (travel sense) can be turned off.
// Each saves at once through the profile.

export default function OtherCurrencies({
  settings,
  rowClass,
  name,
  line,
  settingKey,
  travelClass,
  travel,
}: {
  settings: Settings;
  rowClass: string;
  name: string;
  line: string;
  settingKey: string;
  travelClass: string;
  travel: { key: string; name: string; line: string };
}) {
  const { rememberSettings } = useProfile();
  const [adding, setAdding] = useState(false);
  const list = settings.otherCurrencies;
  const full = list.length >= MAX_OTHER_CURRENCIES;
  const save = (otherCurrencies: string[]) => rememberSettings({ otherCurrencies });
  const move = (at: number, by: -1 | 1) => {
    const next = [...list];
    [next[at], next[at + by]] = [next[at + by], next[at]];
    save(next);
  };
  const offered = ENTRY_CURRENCIES.filter((c) => c !== settings.currency && !list.includes(c));

  return (
    <>
      <div
        className={`${rowClass} ${money.wrapRow}`}
        data-setting={settingKey}
        tabIndex={-1}
      >
        <div className={classes.rowText}>
          <div className={classes.label}>{name}</div>
          <div className={classes.detail}>{line}</div>
          {full && (
            <div className={classes.detail}>{`Up to ${MAX_OTHER_CURRENCIES} other currencies`}</div>
          )}
        </div>
        <div className={money.chips}>
          <ul
            className={money.chipList}
            aria-label={name}
          >
            {list.map((code, at) => (
              <li key={code}>
                <Menu position="bottom-end">
                  <Menu.Target>
                    <button
                      type="button"
                      className={money.chip}
                      aria-label={`${code}, ${currencyName(code)}`}
                    >
                      {code}
                    </button>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item
                      disabled={at === 0}
                      onClick={() => move(at, -1)}
                    >
                      Move earlier
                    </Menu.Item>
                    <Menu.Item
                      disabled={at === list.length - 1}
                      onClick={() => move(at, 1)}
                    >
                      Move later
                    </Menu.Item>
                    <Menu.Item
                      className="sf-danger"
                      onClick={() => save(list.filter((c) => c !== code))}
                    >
                      {`Remove ${code}`}
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className={money.addChip}
            aria-label="Add a currency"
            disabled={full}
            onClick={() => setAdding(true)}
          >
            Add
          </button>
        </div>
      </div>
      {list.length > 0 && (
        <div
          className={travelClass}
          data-setting={travel.key}
          tabIndex={-1}
        >
          <div className={classes.rowText}>
            <div className={classes.label}>{travel.name}</div>
            <div className={classes.detail}>{travel.line}</div>
          </div>
          <OnOff
            label={travel.name}
            checked={settings.travelSense}
            onChange={(travelSense) => rememberSettings({ travelSense })}
          />
        </div>
      )}
      <ResponsiveDialog
        opened={adding}
        onClose={() => setAdding(false)}
        title="Add a currency"
      >
        {adding && (
          <CurrencyList
            groups={[['All currencies', offered]]}
            current={null}
            onPick={(code) => {
              setAdding(false);
              if (!full && !list.includes(code)) save([...list, code]);
            }}
            note="Add offers them after your main currency, in this order. Each entry keeps the rate it was converted at."
          />
        )}
      </ResponsiveDialog>
    </>
  );
}
