import { SearchIcon } from '../ui/icons';
import { forwardRef } from 'react';
import { navigate } from '../../hooks/useRoute';
import Key from '../ui/Key';
import type { SettingResult } from './settings-search';
import { searchSettings } from './settings-search';
import classes from './Settings.module.css';

// Searching settings: the box ("Search settings", with Ctrl K beside it on a computer) and
// what it finds, each setting with its section and, when it was found by what it's for,
// those words quoted with the match marked. Enter opens the first.

/** Opens the section a setting is in, with that setting in view */
function open(result: SettingResult, desktop: boolean) {
  // A computer moves between panes of one Settings; a phone opens the section's page
  navigate(`?settings=${result.section}&setting=${result.key}`, { replace: desktop });
}

interface SearchProps {
  words: string;
  onChange: (words: string) => void;
  /** A computer's: Ctrl K beside it, and Enter's line under what's found */
  desktop?: boolean;
}

export const SettingsSearch = forwardRef<HTMLInputElement, SearchProps>(function SettingsSearch(
  { words, onChange, desktop = false },
  ref,
) {
  return (
    <label className={classes.search}>
      <SearchIcon
        size={16}
        aria-hidden
      />
      <input
        ref={ref}
        type="search"
        placeholder="Search settings"
        aria-label="Search settings"
        value={words}
        onChange={(e) => onChange(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          const [first] = searchSettings(words);
          if (first == null) return;
          e.preventDefault();
          onChange('');
          open(first, desktop);
        }}
      />
      {words !== '' ? (
        <button
          type="button"
          className={classes.clear}
          aria-label="Clear search"
          onClick={() => onChange('')}
        >
          ×
        </button>
      ) : (
        desktop && <Key>Ctrl K</Key>
      )}
    </label>
  );
});

/** What the words find, or that nothing matches */
export function SearchResults({
  words,
  onOpen,
  desktop,
}: {
  words: string;
  /** Called as one opens, so the search is left behind */
  onOpen: () => void;
  desktop: boolean;
}) {
  const found = searchSettings(words);
  if (found.length === 0) {
    return <p className={classes.muted}>No settings match "{words.trim()}"</p>;
  }
  const count = `${found.length} ${found.length === 1 ? 'setting' : 'settings'}`;
  return (
    <>
      <p className={classes.foundCount}>{desktop ? `${count} · Enter opens the first` : count}</p>
      <section
        className={classes.card}
        aria-label="Search results"
      >
        {found.map((r) => (
          <a
            key={r.key}
            href={`?settings=${r.section}&setting=${r.key}`}
            className={`${classes.row} ${classes.result}`}
            onClick={(e) => {
              e.preventDefault();
              onOpen();
              open(r, desktop);
            }}
          >
            <div className={classes.rowText}>
              <div className={classes.label}>
                {r.matched.in === 'name' ? (
                  <Marked
                    text={r.name}
                    result={r}
                  />
                ) : (
                  r.name
                )}
              </div>
              <div className={classes.detail}>
                {r.phrase == null ? (
                  r.sectionName
                ) : (
                  <Marked
                    text={r.phrase}
                    result={r}
                    before={`${r.sectionName} · "`}
                    after={'"'}
                  />
                )}
              </div>
            </div>
          </a>
        ))}
      </section>
    </>
  );
}

/** `text` with the words found in it marked, and what goes before and after it */
function Marked({
  text,
  result,
  before = '',
  after = '',
}: {
  text: string;
  result: SettingResult;
  before?: string;
  after?: string;
}) {
  const { start, length } = result.matched;
  return (
    <>
      {before + text.slice(0, start)}
      <mark>{text.slice(start, start + length)}</mark>
      {text.slice(start + length) + after}
    </>
  );
}
