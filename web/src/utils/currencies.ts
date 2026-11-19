// The currencies' names and symbols as the currency picker shows them (R-Set-Money-Cur:
// "MYR", "Malaysian ringgit", "RM"), written out rather than asked of the browser, whose
// names and symbols differ between browsers and languages ("US Dollar", "$" for SGD)

const CURRENCIES: Record<string, [name: string, sign: string]> = {
  AUD: ['Australian dollar', 'A$'],
  BRL: ['Brazilian real', 'R$'],
  CAD: ['Canadian dollar', 'C$'],
  CHF: ['Swiss franc', 'CHF'],
  CNY: ['Chinese yuan', 'CN¥'],
  CZK: ['Czech koruna', 'Kč'],
  DKK: ['Danish krone', 'kr'],
  EUR: ['Euro', '€'],
  GBP: ['British pound', '£'],
  HKD: ['Hong Kong dollar', 'HK$'],
  HUF: ['Hungarian forint', 'Ft'],
  IDR: ['Indonesian rupiah', 'Rp'],
  ILS: ['Israeli new shekel', '₪'],
  INR: ['Indian rupee', '₹'],
  ISK: ['Icelandic króna', 'kr'],
  JPY: ['Japanese yen', '¥'],
  KRW: ['South Korean won', '₩'],
  MXN: ['Mexican peso', 'MX$'],
  MYR: ['Malaysian ringgit', 'RM'],
  NOK: ['Norwegian krone', 'kr'],
  NZD: ['New Zealand dollar', 'NZ$'],
  PHP: ['Philippine peso', '₱'],
  PLN: ['Polish złoty', 'zł'],
  RON: ['Romanian leu', 'lei'],
  SEK: ['Swedish krona', 'kr'],
  SGD: ['Singapore dollar', 'S$'],
  THB: ['Thai baht', '฿'],
  TRY: ['Turkish lira', '₺'],
  TWD: ['New Taiwan dollar', 'NT$'],
  USD: ['US dollar', '$'],
  VND: ['Vietnamese dong', '₫'],
  ZAR: ['South African rand', 'R'],
};

/** "Malaysian ringgit"; the code itself for one not listed */
export const currencyName = (code: string) => CURRENCIES[code]?.[0] ?? code;

/** "RM"; the code itself for one not listed */
export const currencySign = (code: string) => CURRENCIES[code]?.[1] ?? code;
