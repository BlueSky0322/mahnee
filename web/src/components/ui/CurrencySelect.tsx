import type { ComboboxItem, OptionsFilter, SelectProps } from '@mantine/core';
import { Select } from '@mantine/core';
import { CaretDown } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import { COMMON_CURRENCIES } from '@shared/rates';
import { listCurrencies } from '../../utils/money';

type CurrencySelectProps = Omit<
  SelectProps,
  'data' | 'value' | 'onChange' | 'searchable' | 'searchValue' | 'onSearchChange'
> & {
  value: string;
  onChange: (code: string) => void;
  /** Listed first, before the common ones and then every other currency */
  first?: string[];
};

/** "Japanese Yen" for JPY, from the browser */
const namesByCode = () => new Map(listCurrencies().map((c) => [c.value, c.name]));

// A currency picked by its code: tapping selects the code so typing replaces it, typing
// is upper case and letters only, and a search also matches names ("YEN" finds JPY)
const CurrencySelect = ({ value, onChange, first = [], ...props }: CurrencySelectProps) => {
  const names = useMemo(namesByCode, []);
  // About 170 codes, listed only while the list is open: closed, the select would still
  // draw every one, each time the form around it changes
  const [open, setOpen] = useState(false);
  const codes = open
    ? [...new Set([...first, value, ...COMMON_CURRENCIES, ...names.keys()])]
    : [value];
  const data = codes.map((code) => ({ value: code, label: code }));
  const [search, setSearch] = useState(value);
  useEffect(() => setSearch(value), [value]);

  const filter: OptionsFilter = ({ options, search: query }) => {
    const q = query.trim().toUpperCase();
    // Showing the chosen code, not searching yet: list everything
    if (q === '' || q === value) return options;
    const items = options as ComboboxItem[];
    const byCode = items.filter((o) => o.value.startsWith(q));
    const byName = items.filter(
      (o) => !o.value.startsWith(q) && (names.get(o.value) ?? '').toUpperCase().includes(q),
    );
    return [...byCode, ...byName];
  };

  return (
    <Select
      {...props}
      data={data}
      value={value}
      onChange={(v) => v && onChange(v)}
      onDropdownOpen={() => {
        setOpen(true);
        props.onDropdownOpen?.();
      }}
      onDropdownClose={() => {
        setOpen(false);
        props.onDropdownClose?.();
      }}
      allowDeselect={false}
      searchable
      searchValue={search}
      onSearchChange={(text) =>
        setSearch(
          text
            .toUpperCase()
            .replace(/[^A-Z]/g, '')
            .slice(0, 3),
        )
      }
      filter={filter}
      limit={60}
      maxDropdownHeight={280}
      onFocus={(e) => {
        e.currentTarget.select();
        props.onFocus?.(e);
      }}
      onClick={(e) => {
        e.currentTarget.select();
        props.onClick?.(e);
      }}
      onBlur={(e) => {
        // Left with a part-typed code: go back to the chosen one
        setSearch(value);
        props.onBlur?.(e);
      }}
      rightSection={<CaretDown size={12} />}
      rightSectionPointerEvents="none"
      renderOption={({ option }) => (
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="font-medium">{option.value}</span>
          <span className="sf-muted truncate text-xs">{names.get(option.value)}</span>
        </span>
      )}
      inputMode="text"
      autoCapitalize="characters"
      autoComplete="off"
      spellCheck={false}
    />
  );
};

export default CurrencySelect;
