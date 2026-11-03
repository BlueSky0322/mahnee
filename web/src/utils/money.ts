// Money is stored in whole cents and shown with its currency, like "RM 248.00"

const formatters = new Map<string, Intl.NumberFormat>();

function formatter(currency: string) {
  let f = formatters.get(currency);
  if (f == null) {
    try {
      f = new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency,
        currencyDisplay: 'narrowSymbol',
      });
    } catch {
      // An unknown code still shows as "XYZ 1.00"
      f = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'XXX' });
    }
    formatters.set(currency, f);
  }
  return f;
}

/** The currency's own symbol, such as RM for MYR */
export function currencySymbol(currency: string) {
  return (
    formatter(currency)
      .formatToParts(0)
      .find((p) => p.type === 'currency')?.value ?? currency
  );
}

/** The amount alone, as the currency writes it ("1,184.00", "3,000"): no symbol or sign */
export function formatAmount(cents: number, currency: string) {
  return formatter(currency)
    .formatToParts(Math.abs(cents) / 100)
    .filter((p) => p.type !== 'currency' && p.type !== 'literal' && p.type !== 'minusSign')
    .map((p) => p.value)
    .join('');
}

/** "RM 248.00": always the symbol, a space, then the unsigned amount */
export function formatMoney(cents: number, currency: string) {
  return `${currencySymbol(currency)} ${formatAmount(cents, currency)}`;
}

/** "+53.50" or "−102.50", for balances shown without a symbol */
export function formatSigned(cents: number) {
  const amount = (Math.abs(cents) / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (cents === 0) return amount;
  return `${cents > 0 ? '+' : '−'}${amount}`;
}

export interface CurrencyOption {
  /** The code, "MYR" */
  value: string;
  /** "MYR · Malaysian ringgit (RM)" */
  label: string;
  /** "Malaysian ringgit" */
  name: string;
  /** "Malaysian ringgit (RM)": the name, with the symbol where it isn't the code */
  detail: string;
}

let currencyOptions: CurrencyOption[] | null = null;

/** Every currency the browser knows, as "MYR · Malaysian ringgit (RM)" */
export function listCurrencies(): CurrencyOption[] {
  if (currencyOptions != null) return currencyOptions;
  // Intl.supportedValuesOf is missing from older browsers (and this TypeScript lib)
  const intl = Intl as unknown as { supportedValuesOf?: (key: 'currency') => string[] };
  const codes = intl.supportedValuesOf?.('currency') ?? [
    'MYR',
    'SGD',
    'USD',
    'EUR',
    'GBP',
    'JPY',
    'AUD',
    'IDR',
    'THB',
    'PHP',
    'VND',
    'CNY',
  ];
  const names = new Intl.DisplayNames(undefined, { type: 'currency' });
  currencyOptions = codes.map((code) => {
    const name = names.of(code) ?? code;
    const symbol = currencySymbol(code);
    const detail = symbol === code ? name : `${name} (${symbol})`;
    return { value: code, label: `${code} · ${detail}`, name, detail };
  });
  return currencyOptions;
}
