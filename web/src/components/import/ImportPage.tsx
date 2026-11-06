import { Button, NativeSelect, SegmentedControl } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { CaretLeft, FileArrowUp } from '@phosphor-icons/react';
import { useRef, useState } from 'react';
import type { Account, Category } from '@shared/api';
import type { CategoryKind } from '@shared/categories';
import type { ColumnMapping } from '@shared/csv-import';
import {
  MAX_IMPORT_ROWS,
  isMahneeExport,
  parseCsv,
  readBankRows,
  readExportRows,
} from '@shared/csv-import';
import type { AccountKind } from '@shared/ledger';
import { ACCOUNT_KINDS, MAX_NOTE, MAX_PAYEE } from '@shared/ledger';
import { api } from '../../api';
import { goUp, navigate } from '../../hooks/useRoute';
import { change, transactionsSince } from '../../ledger/ledger';
import { isOfflineFailure } from '../../offline/network';
import { useAccounts, useCategories } from '../../ledger/useLedger';
import { useProfile } from '../../profile/ProfileContext';
import { dayText } from '../../utils/date-input';
import { formatMoney } from '../../utils/money';
import { showError } from '../../utils/notify';
import { KIND_LABELS } from '../accounts/account-text';
import { categoryName } from '../common/category-name';
import type { Plan, PlannedRow } from './import-plan';
import {
  accountsToCheck,
  earliestDay,
  importChanges,
  markSaved,
  planBankFile,
  planExport,
} from './import-plan';
import { rememberMapping, rememberedMapping } from './remembered-mapping';
import classes from './Import.module.css';

// The Import page (?import): pick an account and a CSV file, say which column holds what
// (remembered per account on this device), and look over every row before anything is
// saved: the category each goes in (the one its payee was filed under before, else
// Other), the ones that look already saved (left unticked) and the ones that can't be
// imported, and why. Mahnee's own export needs no mapping: it names its accounts and
// categories. Import makes every change through the ledger's change(), so it shows at
// once, works offline and is saved through the outbox, counted once.

/** How many rows the preview shows at first, and each time it's asked for more */
const ROWS_AT_A_TIME = 100;

/** A mapping as picked so far: '' for a column not picked */
type Picked = Record<keyof ColumnMapping, string>;
const NOTHING_PICKED: Picked = {
  date: '',
  amount: '',
  moneyIn: '',
  moneyOut: '',
  payee: '',
  note: '',
};

interface LoadedFile {
  table: string[][];
  isExport: boolean;
}

/** What the person has said about the preview: which rows, categories and kinds */
interface Choices {
  ticked: Set<number>;
  categoryOf: Map<number, string>;
  kinds: Map<string, AccountKind>;
  openingsTicked: Set<string>;
}

const count = (n: number) =>
  `${n.toLocaleString('en')} ${n === 1 ? 'transaction' : 'transactions'}`;

export default function ImportPage() {
  const { profile } = useProfile();
  const email = profile?.email ?? null;
  const { accounts } = useAccounts();
  const { categories } = useCategories();
  const listed = accounts?.filter((a) => !a.archived) ?? [];
  const [chosenAccount, setChosenAccount] = useState<string | null>(null);
  const accountId = chosenAccount ?? listed[0]?.id ?? '';
  const account = listed.find((a) => a.id === accountId) ?? null;

  const [file, setFile] = useState<LoadedFile | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [twoColumns, setTwoColumns] = useState(false);
  const [picked, setPicked] = useState<Picked>(NOTHING_PICKED);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [choices, setChoices] = useState<Choices | null>(null);
  const [preparing, setPreparing] = useState(false);
  /** Categories used before couldn't be looked up (the server failed) */
  const [filedUnknown, setFiledUnknown] = useState(false);
  const [shown, setShown] = useState(ROWS_AT_A_TIME);
  // Only the latest preview asked for is shown
  const asked = useRef(0);

  const header = file?.table[0] ?? [];

  /** The mapping remembered for `id`, as far as this file has those columns */
  function pickRemembered(id: string, columns: string[]) {
    const kept = id === '' ? null : rememberedMapping(email, id);
    const has = (name: string | null) => (name != null && columns.includes(name) ? name : '');
    setTwoColumns(kept != null && kept.amount == null);
    setPicked(
      kept == null
        ? NOTHING_PICKED
        : {
            date: has(kept.date),
            amount: has(kept.amount),
            moneyIn: has(kept.moneyIn),
            moneyOut: has(kept.moneyOut),
            payee: has(kept.payee),
            note: has(kept.note),
          },
    );
  }

  function startOver() {
    asked.current++;
    setPlan(null);
    setChoices(null);
    setPreparing(false);
    setShown(ROWS_AT_A_TIME);
  }

  function chooseAccount(id: string) {
    setChosenAccount(id);
    startOver();
    if (file != null && !file.isExport) pickRemembered(id, file.table[0]);
  }

  async function chooseFile(picked: File | undefined) {
    startOver();
    setFile(null);
    setFileProblem(null);
    if (picked == null) return;
    let table: string[][];
    try {
      table = parseCsv(new TextDecoder().decode(await picked.arrayBuffer()));
    } catch {
      setFileProblem("Couldn't read that file.");
      return;
    }
    const rows = table.length - 1;
    if (rows < 1) {
      setFileProblem('This file has no rows to import.');
      return;
    }
    if (rows > MAX_IMPORT_ROWS) {
      setFileProblem(
        `This file has ${rows.toLocaleString('en')} rows. Mahnee imports up to ` +
          `${MAX_IMPORT_ROWS.toLocaleString('en')} at a time.`,
      );
      return;
    }
    const isExport = isMahneeExport(table[0]);
    setFile({ table, isExport });
    if (isExport) void preview({ table, isExport });
    else pickRemembered(accountId, table[0]);
  }

  const mapping: ColumnMapping | null =
    picked.date === '' ||
    (twoColumns ? picked.moneyIn === '' && picked.moneyOut === '' : picked.amount === '')
      ? null
      : {
          date: picked.date,
          amount: twoColumns ? null : picked.amount,
          moneyIn: twoColumns && picked.moneyIn !== '' ? picked.moneyIn : null,
          moneyOut: twoColumns && picked.moneyOut !== '' ? picked.moneyOut : null,
          payee: picked.payee === '' ? null : picked.payee,
          note: picked.note === '' ? null : picked.note,
        };

  async function preview(loaded: LoadedFile) {
    if (accounts == null || categories == null) return;
    const mine = ++asked.current;
    setPreparing(true);
    let lookupFailed = false;
    try {
      let next: Plan;
      if (loaded.isExport) {
        next = planExport(readExportRows(loaded.table), accounts, categories);
      } else {
        if (account == null || mapping == null) return;
        rememberMapping(email, account.id, mapping);
        // Not known offline: everything goes to Other until it's changed. Online, a failure
        // is said, so rows aren't filed under Other without the person knowing why.
        const filed = await api
          .getPayeeCategories(account.id)
          .then((answer) => answer.payees)
          .catch((err: unknown) => {
            if (!isOfflineFailure(err)) lookupFailed = true;
            return [];
          });
        next = planBankFile(readBankRows(loaded.table, mapping), account, categories, filed);
      }
      const from = earliestDay(next);
      const saved = new Map(
        from == null
          ? []
          : await Promise.all(
              accountsToCheck(next).map(
                async (id) => [id, await transactionsSince(id, from)] as const,
              ),
            ),
      );
      next = markSaved(next, saved);
      if (mine !== asked.current) return;
      setPlan(next);
      setFiledUnknown(lookupFailed);
      setChoices({
        ticked: new Set(
          next.rows.filter((r) => r.transaction != null && !r.looksSaved).map((r) => r.row),
        ),
        categoryOf: new Map(),
        kinds: new Map(),
        openingsTicked: new Set(),
      });
    } catch (err) {
      if (mine === asked.current) showError(err, "Couldn't check the file against what's saved.");
    } finally {
      if (mine === asked.current) setPreparing(false);
    }
  }

  const tickedRows = plan?.rows.filter((r) => choices?.ticked.has(r.row)).length ?? 0;
  const canImport =
    plan != null &&
    choices != null &&
    plan.problem == null &&
    (tickedRows > 0 || choices.openingsTicked.size > 0);

  function importNow() {
    if (plan == null || choices == null || !canImport) return;
    change(...importChanges(plan, choices));
    if (tickedRows > 0) notifications.show({ message: `Imported ${count(tickedRows)}` });
    if (plan.source === 'bank' && account != null) {
      navigate(`?account=${account.id}`, { replace: true });
    } else goUp('');
  }

  const update = (fn: (c: Choices) => void) =>
    setChoices((c) => {
      if (c == null) return c;
      const next = {
        ticked: new Set(c.ticked),
        categoryOf: new Map(c.categoryOf),
        kinds: new Map(c.kinds),
        openingsTicked: new Set(c.openingsTicked),
      };
      fn(next);
      return next;
    });

  const columnSelect = (label: string, key: keyof ColumnMapping, optional = false) => (
    <NativeSelect
      label={label}
      value={picked[key]}
      onChange={(e) => {
        const value = e.currentTarget.value;
        setPicked((p) => ({ ...p, [key]: value }));
        startOver();
      }}
      data={[
        { value: '', label: optional ? 'None' : 'Pick a column' },
        ...[...new Set(header)].filter((h) => h !== '').map((h) => ({ value: h, label: h })),
      ]}
    />
  );

  return (
    <div className={classes.page}>
      <header className={classes.header}>
        <Button
          variant="subtle"
          color="gray"
          size="compact-md"
          className={classes.back}
          leftSection={<CaretLeft size={16} />}
          onClick={() => goUp('')}
        >
          Home
        </Button>
        <h1 className={classes.title}>Import</h1>
      </header>

      <section className={classes.card}>
        <p className={classes.muted}>
          A CSV file from your bank, or one exported from Mahnee. Nothing is saved until you look it
          over and say Import.
        </p>
        <NativeSelect
          label="Account"
          value={accountId}
          onChange={(e) => chooseAccount(e.currentTarget.value)}
          data={
            listed.length === 0
              ? [{ value: '', label: 'No accounts yet' }]
              : listed.map((a) => ({ value: a.id, label: a.name }))
          }
        />
        <label className={classes.fileButton}>
          <FileArrowUp size={18} />
          <span>{file == null ? 'Pick a CSV file' : 'Pick another file'}</span>
          <input
            type="file"
            accept=".csv,text/csv"
            aria-label="CSV file"
            className={classes.fileInput}
            onChange={(e) => {
              void chooseFile(e.currentTarget.files?.[0]);
              e.currentTarget.value = '';
            }}
          />
        </label>
        {fileProblem != null && (
          <p
            className={classes.problem}
            role="alert"
          >
            {fileProblem}
          </p>
        )}
      </section>

      {file != null && file.isExport && (
        <p className={classes.muted}>
          This is a Mahnee export: it names its own accounts and categories, so the account above
          isn't used.
        </p>
      )}

      {file != null && !file.isExport && (
        <section className={classes.card}>
          <h2 className={classes.sectionTitle}>Which column is which</h2>
          <SegmentedControl
            fullWidth
            value={twoColumns ? 'two' : 'one'}
            onChange={(v) => {
              setTwoColumns(v === 'two');
              startOver();
            }}
            data={[
              { value: 'one', label: 'One amount column' },
              { value: 'two', label: 'Money in and out' },
            ]}
          />
          {columnSelect('Date', 'date')}
          {twoColumns ? (
            <>
              {columnSelect('Money in', 'moneyIn')}
              {columnSelect('Money out', 'moneyOut')}
            </>
          ) : (
            columnSelect('Amount', 'amount')
          )}
          {columnSelect('Payee', 'payee', true)}
          {columnSelect('Note', 'note', true)}
          <p className={classes.muted}>
            {twoColumns
              ? 'Money in is income, money out is spending.'
              : 'Amounts below zero, or in brackets, are spending; the rest is income.'}{' '}
            Dates are read as day, month, year (31/01/2026).
          </p>
          <Button
            onClick={() => void preview(file)}
            disabled={account == null || mapping == null}
            loading={preparing}
          >
            Preview
          </Button>
          {account == null && <p className={classes.muted}>Add an account to import into first.</p>}
        </section>
      )}

      {file?.isExport && preparing && plan == null && (
        <p className={classes.muted}>Reading the file…</p>
      )}

      {plan != null && filedUnknown && (
        <p
          className={classes.problem}
          role="alert"
        >
          Couldn't look up categories you've used before, so these rows are under Other. Change them
          below or try again.
        </p>
      )}

      {plan != null && choices != null && categories != null && (
        <Preview
          plan={plan}
          table={file?.table ?? []}
          choices={choices}
          update={update}
          accounts={accounts ?? []}
          categories={categories}
          shown={shown}
          showMore={() => setShown((n) => n + ROWS_AT_A_TIME)}
        />
      )}

      {plan != null && choices != null && (
        <div className={classes.importBar}>
          {plan.problem != null && <p className={classes.problem}>{plan.problem}</p>}
          <Button
            size="md"
            fullWidth
            disabled={!canImport}
            onClick={importNow}
          >
            Import {count(tickedRows)}
          </Button>
        </div>
      )}
    </div>
  );
}

interface PreviewProps {
  plan: Plan;
  /** The file's cells, header first */
  table: string[][];
  choices: Choices;
  update: (fn: (c: Choices) => void) => void;
  accounts: Account[];
  categories: Category[];
  shown: number;
  showMore: () => void;
}

/** Every row, ticked or not, with what's said about it; new accounts and openings first */
function Preview({
  plan,
  table,
  choices,
  update,
  accounts,
  categories,
  shown,
  showMore,
}: PreviewProps) {
  const saved = plan.rows.filter((r) => r.looksSaved).length;
  const unreadable = plan.rows.filter((r) => r.problem != null).length;
  const currency = accounts[0]?.currency ?? 'MYR';
  return (
    <>
      {plan.newAccounts.length > 0 && (
        <section className={classes.card}>
          <h2 className={classes.sectionTitle}>New accounts</h2>
          <p className={classes.muted}>The file doesn't say what kind each is, so pick one.</p>
          {plan.newAccounts.map((a) => (
            <div
              key={a.id}
              className={classes.newAccount}
            >
              <span className={classes.newAccountName}>
                {a.name}
                <span className={classes.muted}> {signedMoney(a.openingCents, currency)}</span>
              </span>
              <NativeSelect
                aria-label={`Kind of ${a.name}`}
                value={choices.kinds.get(a.id) ?? 'bank'}
                onChange={(e) => {
                  const kind = e.currentTarget.value as AccountKind;
                  update((c) => c.kinds.set(a.id, kind));
                }}
                data={ACCOUNT_KINDS.map((k) => ({ value: k, label: KIND_LABELS[k] }))}
              />
            </div>
          ))}
        </section>
      )}

      {plan.openings.length > 0 && (
        <section className={classes.section}>
          <h2 className={classes.sectionTitle}>Opening balances that differ</h2>
          <ul className={classes.list}>
            {plan.openings.map((o) => (
              <li
                key={o.accountId}
                className={classes.row}
              >
                <input
                  type="checkbox"
                  className={classes.tick}
                  aria-label={`Change ${o.name}'s opening balance`}
                  checked={choices.openingsTicked.has(o.accountId)}
                  onChange={(e) => {
                    const on = e.currentTarget.checked;
                    update((c) =>
                      on ? c.openingsTicked.add(o.accountId) : c.openingsTicked.delete(o.accountId),
                    );
                  }}
                />
                <span className={classes.rowText}>
                  Opening balance of {o.name}: {signedMoney(o.fromCents, currency)} now,{' '}
                  {signedMoney(o.toCents, currency)} in the file. Tick to change it.
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={classes.section}>
        <h2 className={classes.sectionTitle}>
          {plan.rows.length.toLocaleString('en')} rows
          {saved > 0 && `, ${saved.toLocaleString('en')} look already saved`}
          {unreadable > 0 && `, ${unreadable.toLocaleString('en')} can't be imported`}
        </h2>
        <ul className={classes.list}>
          {plan.rows.slice(0, shown).map((r) => (
            <PreviewRow
              key={r.row}
              planned={r}
              cells={table[r.row - 1] ?? []}
              ticked={choices.ticked.has(r.row)}
              categoryId={choices.categoryOf.get(r.row) ?? r.transaction?.categoryId ?? null}
              categories={categories}
              currency={currency}
              fromBank={plan.source === 'bank'}
              onTick={(on) => update((c) => (on ? c.ticked.add(r.row) : c.ticked.delete(r.row)))}
              onCategory={(id) => update((c) => c.categoryOf.set(r.row, id))}
            />
          ))}
        </ul>
        {plan.rows.length > shown && (
          <Button
            variant="default"
            onClick={showMore}
          >
            Show more ({(plan.rows.length - shown).toLocaleString('en')} left)
          </Button>
        )}
      </section>
    </>
  );
}

/** "RM 1,000.00", or "−RM 320.00" below zero */
const signedMoney = (cents: number, currency: string) =>
  `${cents < 0 ? '−' : ''}${formatMoney(Math.abs(cents), currency)}`;

/** The categories a row of `kind` can go in, as listed: each top-level one, then its own */
function categoryOptions(categories: Category[], kind: CategoryKind) {
  const listed = categories.filter((c) => c.kind === kind && !c.archived);
  const byPlace = (a: Category, b: Category) => a.position - b.position;
  return listed
    .filter((c) => c.parentId == null)
    .sort(byPlace)
    .flatMap((top) => [top, ...listed.filter((c) => c.parentId === top.id).sort(byPlace)])
    .map((c) => ({ value: c.id, label: categoryName(categories, c.id) }));
}

interface RowProps {
  planned: PlannedRow;
  /** The row's cells as the file has them */
  cells: string[];
  ticked: boolean;
  categoryId: string | null;
  categories: Category[];
  currency: string;
  fromBank: boolean;
  onTick: (on: boolean) => void;
  onCategory: (id: string) => void;
}

function PreviewRow({
  planned,
  cells,
  ticked,
  categoryId,
  categories,
  currency,
  fromBank,
  onTick,
  onCategory,
}: RowProps) {
  const t = planned.transaction;
  return (
    <li className={classes.row}>
      <input
        type="checkbox"
        className={classes.tick}
        aria-label={`Import row ${planned.row}`}
        checked={ticked}
        disabled={t == null}
        onChange={(e) => onTick(e.currentTarget.checked)}
      />
      <div className={classes.rowBody}>
        {t == null ? (
          <span className={classes.rowText}>
            Row {planned.row}: {cells.join(', ')}
          </span>
        ) : (
          <>
            <span className={classes.rowLine}>
              <span className={classes.rowText}>{t.payee ?? 'No payee'}</span>
              <span className={classes.amount}>
                {t.kind === 'income' ? '+' : t.kind === 'expense' ? '−' : ''}
                {formatMoney(t.amountCents, currency)}
              </span>
            </span>
            <span className={classes.detail}>
              {dayText(t.date)}
              {planned.names != null &&
                ` · ${planned.names.account}${
                  planned.names.toAccount != null ? ` to ${planned.names.toAccount}` : ''
                }`}
              {fromBank || t.categoryId == null
                ? ''
                : ` · ${
                    // A category the import adds isn't saved yet: named as the file names it
                    categories.some((c) => c.id === t.categoryId)
                      ? categoryName(categories, t.categoryId)
                      : planned.names?.category ?? ''
                  }`}
              {t.note != null && ` · ${t.note}`}
            </span>
          </>
        )}
        {planned.problem != null && <span className={classes.problem}>{planned.problem}</span>}
        {planned.looksSaved && <span className={classes.flag}>Looks already saved</span>}
        {planned.shortened.includes('payee') && (
          <span className={classes.flag}>Payee shortened to {MAX_PAYEE} characters</span>
        )}
        {planned.shortened.includes('note') && (
          <span className={classes.flag}>Note shortened to {MAX_NOTE} characters</span>
        )}
        {fromBank && t != null && t.categoryId != null && (
          <NativeSelect
            size="xs"
            label="Category"
            value={categoryId ?? ''}
            onChange={(e) => onCategory(e.currentTarget.value)}
            data={categoryOptions(categories, t.kind === 'income' ? 'income' : 'expense')}
          />
        )}
      </div>
    </li>
  );
}
