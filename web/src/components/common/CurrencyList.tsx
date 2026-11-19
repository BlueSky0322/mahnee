import type { ReactNode } from 'react';
import { useState } from 'react';
import { currencyName, currencySign } from '../../utils/currencies';
import { CheckIcon, SearchIcon } from '../ui/icons';
import classes from './CurrencyList.module.css';

// A list of currencies to pick one from, as the main currency's picker draws it
// (R-Set-Money-Cur): a search named "Search currencies", then each group of currencies
// (a listbox named for the group), each with its code, name and symbol, the one in use
// ticked. Used for the main currency, adding another, and an entry's currency in Add.

export default function CurrencyList({
  groups,
  current,
  onPick,
  note,
}: {
  /** Each group's title and its currencies, in order; a group nothing matches isn't shown */
  groups: [title: string, codes: readonly string[]][];
  /** The one in use, ticked; null for none */
  current: string | null;
  onPick: (code: string) => void;
  /** Said under the list */
  note?: ReactNode;
}) {
  const [words, setWords] = useState('');
  const wanted = words.trim().toLowerCase();
  const matches = (code: string) =>
    wanted === '' ||
    code.toLowerCase().includes(wanted) ||
    currencyName(code).toLowerCase().includes(wanted);
  const shown = groups
    .map(([title, codes]) => [title, codes.filter(matches)] as const)
    .filter(([, codes]) => codes.length > 0);

  return (
    <div className={classes.list}>
      <label className={classes.search}>
        <SearchIcon
          size={16}
          aria-hidden
        />
        <input
          type="search"
          placeholder="Search by name or code"
          aria-label="Search currencies"
          value={words}
          onChange={(e) => setWords(e.currentTarget.value)}
        />
      </label>
      <div className={classes.scroll}>
        {shown.map(([title, codes]) => (
          <div key={title}>
            <p className={classes.group}>{title}</p>
            <div
              role="listbox"
              aria-label={title}
              className={classes.options}
            >
              {codes.map((code) => (
                <button
                  key={code}
                  type="button"
                  role="option"
                  aria-selected={code === current}
                  className={classes.option}
                  data-on={code === current || undefined}
                  onClick={() => onPick(code)}
                >
                  <span className={classes.code}>{code}</span>
                  <span className={classes.name}>{currencyName(code)}</span>
                  <span className={classes.sign}>{currencySign(code)}</span>
                  <span className={classes.tick}>
                    {code === current && (
                      <CheckIcon
                        size={16}
                        aria-hidden
                      />
                    )}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      {shown.length === 0 && (
        <p className={classes.note}>No currency matches &ldquo;{words.trim()}&rdquo;</p>
      )}
      {note != null && <p className={classes.note}>{note}</p>}
    </div>
  );
}
