import { Button, Modal, NativeSelect, SegmentedControl } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { FileArrowUp } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import type { Account, Category, LedgerChange } from '@shared/api';
import { MAX_FILE_NAME } from '@shared/api';
import type { CategoryKind } from '@shared/categories';
import type { ColumnMapping } from '@shared/csv-import';
import {
  MAX_IMPORT_ROWS,
  isMahneeExport,
  parseCsv,
  readBankRows,
  readExportRange,
  readExportRows,
} from '@shared/csv-import';
import type { AccountKind } from '@shared/ledger';
import { ACCOUNT_KINDS, MAX_NOTE, MAX_PAYEE } from '@shared/ledger';
import { api } from '../../api';
import { goUp, navigate } from '../../hooks/useRoute';
import { useIsDesktop } from '../../hooks/useBreakpoints';
import { change, loadedLedger, transactionsSince } from '../../ledger/ledger';
import { isOfflineFailure } from '../../offline/network';
import { useAccounts, useCategories } from '../../ledger/useLedger';
import { useProfile } from '../../profile/ProfileContext';
import { dayText, toDateInput } from '../../utils/date-input';
import { formatAmount, formatMoney } from '../../utils/money';
import { showError } from '../../utils/notify';
import { KIND_LABELS } from '../accounts/account-text';
import { categoryName } from '../common/category-name';
import { scheduleText } from '../home/recurring-text';
import { newId } from '../../utils/id';
import { askFocusBack, takeHandedFile } from './handed-file';
import type { Plan, PlannedRow } from './import-plan';
import {
  accountsToCheck,
  adds,
  earliestDay,
  importChanges,
  markSaved,
  otherCategory,
  planBankFile,
  planExport,
} from './import-plan';
import { rememberMapping, rememberedMapping } from './remembered-mapping';
import classes from './Import.module.css';
import BackButton from '../ui/BackButton';
import { CloseIcon } from '../ui/icons';
import Settings from '../settings/SettingsPage';

// The Import page (?import): pick an account and a CSV file, say which column holds what
// (remembered per account on this device), and look over every row before anything is
// saved: the category each goes in (the one its payee was filed under before, else
// Other), the ones that look already saved (left unticked) and the ones that can't be
// imported, and why. Mahnee's own export needs no mapping: it names its accounts and
// categories, and sets its repeating items up again. Import makes every change through the
// ledger's change(), so it shows at once, works offline and is saved through the outbox,
// counted once.

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
  /** The file's name, as Recent imports lists it */
  name: string;
  /** A Mahnee export of some dates: the days it holds; null for everything or a bank's file */
  range: { from: string; to: string } | null;
}

/** "Oct 1", as the import says a day */
const shortDay = (day: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** Which of the lines the desktop's tabs show */
type Lines = 'all' | 'saved' | 'other';

/** What the person has said about the preview: which rows, categories and kinds */
interface Choices {
  ticked: Set<number>;
  categoryOf: Map<number, string>;
  kinds: Map<string, AccountKind>;
  openingsTicked: Set<string>;
}

const count = (n: number) =>
  `${n.toLocaleString('en')} ${n === 1 ? 'transaction' : 'transactions'}`;

/** "3 transactions", or with a file's repeating items "3 transactions and 2 repeating items" */
const countOf = (transactions: number, repeating: number | null) =>
  repeating == null
    ? count(transactions)
    : `${count(transactions)} and ${repeating.toLocaleString('en')} ${
        repeating === 1 ? 'repeating item' : 'repeating items'
      }`;

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
  const [lines_, setLines] = useState<Lines>('all');
  const isDesktop = useIsDesktop() === true;
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
    setLines('all');
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

  async function chooseFile(picked: File | null | undefined) {
    startOver();
    setFile(null);
    setFileProblem(null);
    if (picked == null) return;
    const name = picked.name.trim().slice(0, MAX_FILE_NAME) || 'file.csv';
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
    const loaded = { table, isExport, name, range: isExport ? readExportRange(table) : null };
    setFile(loaded);
    if (isExport) void preview(loaded);
    else pickRemembered(accountId, table[0]);
  }

  // A file chosen on Import and export comes with the page
  useEffect(() => {
    const handed = takeHandedFile();
    if (handed != null) void chooseFile(handed);
    // Once, as the page opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    const mine = ++asked.current;
    setPreparing(true);
    let lookupFailed = false;
    try {
      let next: Plan;
      if (loaded.isExport) {
        // A file picked before the accounts and categories have loaded waits for them
        const ledger = await loadedLedger();
        // The person's own day, for when a repeating item's next due date has passed
        next = planExport(
          readExportRows(loaded.table),
          ledger.accounts,
          ledger.categories,
          ledger.recurring ?? [],
          toDateInput(new Date()),
          loaded.range != null,
        );
      } else {
        if (account == null || categories == null || mapping == null) return;
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
        ticked: new Set(next.rows.filter((r) => adds(r) && !r.looksSaved).map((r) => r.row)),
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
  const tickedRepeating =
    plan?.rows.filter((r) => r.recurring != null && choices?.ticked.has(r.row)).length ?? 0;
  // How many of each, once the file has repeating items: none is said as 0 of each
  const toImport = countOf(
    tickedRows - tickedRepeating,
    plan?.rows.some((r) => r.recurring != null) ? tickedRepeating : null,
  );
  const canImport =
    plan != null &&
    choices != null &&
    plan.problem == null &&
    (tickedRows > 0 || choices.openingsTicked.size > 0);

  function importNow() {
    if (plan == null || choices == null || !canImport || file == null) return;
    change(...recorded(importChanges(plan, choices)));
    if (tickedRows > 0) notifications.show({ message: `Imported ${toImport}` });
    if (plan.source === 'bank' && account != null) {
      navigate(`?account=${account.id}`, { replace: true });
    } else goUp('?settings=data');
  }

  /**
   * The changes with the import recorded first and each transaction naming it, so every
   * device lists it under Recent imports and Undo can take exactly these out. Nothing is
   * recorded when no transaction is added.
   */
  function recorded(changes: LedgerChange[]): LedgerChange[] {
    if (plan == null || file == null) return changes;
    const added = changes.filter((c) => c.op === 'addTransaction').length;
    if (added === 0) return changes;
    const lines = plan.rows.filter((r) => r.repeats == null).length;
    const id = newId();
    return [
      {
        op: 'addImport',
        import: {
          id,
          fileName: file.name,
          accountId: plan.source === 'bank' ? account?.id ?? null : null,
          addedCount: added,
          skippedCount: Math.max(0, lines - added),
        },
      },
      ...changes.map((c): LedgerChange => (c.op === 'addTransaction' ? { ...c, importId: id } : c)),
    ];
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
      // A computer's: the name beside its column (R-Desk-Import)
      classNames={
        isDesktop
          ? { root: classes.map, label: classes.mapLabel, input: classes.mapInput }
          : undefined
      }
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

  const step = file == null ? 1 : plan == null ? 2 : 3;
  // Once the lines are being checked, the file and columns are done: a step taps back to them
  const checking = plan != null;
  const title =
    file == null
      ? 'Import'
      : isDesktop
        ? `Import ${file.name}`
        : file.isExport || account == null
          ? file.name
          : `${file.name} into ${account.name}`;
  const STEPS = isDesktop ? ['File and account', 'Columns', 'Check'] : ['File', 'Columns', 'Check'];
  const cancel = () => {
    askFocusBack();
    goUp('?settings=data');
  };

  const steps = (
    <ol
      className={classes.steps}
      aria-label="Steps"
    >
      {STEPS.map((name, i) => {
        const done = i + 1 < step;
        const mark = (
          <>
            <i
              className={classes.stepMark}
              aria-hidden={done && isDesktop ? true : undefined}
            >
              {done && isDesktop ? '✓' : i + 1}
            </i>
            {name}
          </>
        );
        return (
          <li
            key={name}
            className={classes.step}
            aria-current={i + 1 === step ? 'step' : undefined}
            data-done={done || undefined}
          >
            {done && checking ? (
              <button
                type="button"
                className={classes.stepBack}
                aria-label={`Back to ${name}`}
                onClick={startOver}
              >
                {mark}
              </button>
            ) : (
              mark
            )}
          </li>
        );
      })}
    </ol>
  );

  const heading = (
    <div className={classes.titleBlock}>
      <h1
        id="import-title"
        className={classes.title}
      >
        {title}
      </h1>
      {plan != null && file != null && (
        <p className={classes.soft}>
          {linesText(
            plan,
            isDesktop ? (file.isExport ? null : account?.name ?? null) : null,
            isDesktop,
          )}
        </p>
      )}
    </div>
  );

  const fileCard = (
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
  );

  const exportNotes = (
    <>
      {file != null && file.isExport && file.range == null && (
        <p className={classes.muted}>
          This is a Mahnee export: it names its own accounts and categories, so the account above
          isn't used.
        </p>
      )}
      {file?.range != null && (
        <p className={classes.muted}>
          {`This file holds ${shortDay(file.range.from)} to ${shortDay(file.range.to)} only, so it adds entries to accounts you have: no accounts, opening balances or repeating items.`}
        </p>
      )}
    </>
  );

  const counts =
    plan != null && choices != null && categories != null ? (
      <Counts
        plan={plan}
        choices={choices}
        categories={categories}
        desktop={isDesktop}
      />
    ) : null;

  const addButton =
    plan != null && choices != null ? (
      <Button
        size={isDesktop ? 'sm' : 'md'}
        fullWidth
        classNames={{ root: classes.importButton, label: classes.importButtonLabel }}
        disabled={!canImport}
        onClick={importNow}
      >
        Add {toImport}
      </Button>
    ) : null;

  // "Which column is which": on a computer the card down the left, with what's counted and
  // Add under the columns once the lines are being checked
  const columnsCard =
    file != null && !file.isExport ? (
      <section
        className={`${classes.card} ${classes.columns}`}
        aria-labelledby="import-columns"
      >
        <div className={classes.columnsHead}>
          <h2
            id="import-columns"
            className={classes.sectionTitle}
          >
            Which column is which
          </h2>
          {checking && <span className={classes.small}>Saved for this bank</span>}
        </div>
        <SegmentedControl
          fullWidth
          size={isDesktop ? 'xs' : 'sm'}
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
        {columnSelect('Payee', 'payee', true)}
        {twoColumns ? (
          <>
            {columnSelect('Money in', 'moneyIn')}
            {columnSelect('Money out', 'moneyOut')}
          </>
        ) : (
          columnSelect('Amount', 'amount')
        )}
        {columnSelect('Note', 'note', true)}
        {!checking && (
          <>
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
            {account == null && (
              <p className={classes.muted}>Add an account to import into first.</p>
            )}
          </>
        )}
        {isDesktop && counts != null && (
          <>
            <hr className={classes.rule} />
            {counts}
            {plan?.problem != null && <p className={classes.problem}>{plan.problem}</p>}
            {addButton}
          </>
        )}
      </section>
    ) : null;

  const lines =
    plan != null && choices != null && categories != null ? (
      <section
        className={isDesktop ? `${classes.card} ${classes.lines}` : classes.section}
        aria-label="Lines in the file"
      >
        {isDesktop && (
          <LineTabs
            plan={plan}
            choices={choices}
            categories={categories}
            lines={lines_}
            onLines={(l) => {
              setLines(l);
              setShown(ROWS_AT_A_TIME);
            }}
          />
        )}
        <Preview
          plan={plan}
          table={file?.table ?? []}
          choices={choices}
          update={update}
          accounts={accounts ?? []}
          categories={categories}
          shown={shown}
          showMore={() => setShown((n) => n + ROWS_AT_A_TIME)}
          only={isDesktop ? lineFilter(lines_, choices, categories) : null}
          desktop={isDesktop}
        />
      </section>
    ) : null;

  const lookupProblem = plan != null && filedUnknown && (
    <p
      className={classes.problem}
      role="alert"
    >
      Couldn't look up categories you've used before, so these rows are under Other. Change them
      below or{' '}
      <button
        type="button"
        className={classes.inlineLink}
        onClick={() => file != null && void preview(file)}
      >
        Try again
      </button>
    </p>
  );
  const reading = file?.isExport && preparing && plan == null && (
    <p className={classes.muted}>Reading the file…</p>
  );

  const bankChecking = columnsCard != null && checking;
  if (isDesktop) {
    // A computer's import is a large dialog over Settings › Import and export (R-Desk-Import):
    // it takes the keyboard and keeps it, and Esc or its X leave it, saving nothing
    return (
      <>
        <div
          className={classes.behind}
          aria-hidden
          // Seen, not reached: the keyboard and clicks stay in the import
          {...{ inert: '' }}
        >
          <Settings section="data" />
        </div>
        <Modal.Root
          opened
          onClose={cancel}
          // A stray click on the dimmed page keeps the file being looked over; Esc and X cancel
          closeOnClickOutside={false}
          size={1200}
          yOffset={48}
          // Import and export takes the keyboard back as it opens again (askFocusBack)
          returnFocus={false}
          classNames={{ content: classes.dialog, inner: classes.dialogInner }}
        >
          <Modal.Overlay
            backgroundOpacity={0.45}
            color="#0f1012"
          />
          <Modal.Content>
            <header className={classes.deskHeader}>
              <div className={classes.titleBlock}>
                <Modal.Title
                  component="h1"
                  className={classes.title}
                >
                  {title}
                </Modal.Title>
                {plan != null && file != null && (
                  <p className={classes.soft}>
                    {linesText(plan, file.isExport ? null : account?.name ?? null, true)}
                  </p>
                )}
              </div>
              {steps}
              <button
                type="button"
                className={classes.closeButton}
                aria-label="Cancel import, nothing is saved"
                onClick={cancel}
              >
                <CloseIcon size={20} />
              </button>
            </header>
            <div className={classes.deskBody}>
              <div className={classes.deskSide}>
                {!bankChecking && fileCard}
                {exportNotes}
                {columnsCard}
                {reading}
                {columnsCard == null && counts != null && (
                  <section className={`${classes.card} ${classes.columns}`}>
                    {counts}
                    {plan?.problem != null && <p className={classes.problem}>{plan.problem}</p>}
                    {addButton}
                  </section>
                )}
              </div>
              {lines != null && (
                <div className={classes.deskMain}>
                  {lookupProblem}
                  {lines}
                </div>
              )}
            </div>
          </Modal.Content>
        </Modal.Root>
      </>
    );
  }

  return (
    <div className={classes.page}>
      <header className={classes.header}>
        <div className={classes.headerRow}>
          <BackButton onClick={cancel}>Import and export</BackButton>
        </div>
        {steps}
        {heading}
      </header>

      {/* Checking a bank's lines, its file and columns are done (the steps go back to them);
          Mahnee's own export has no columns, so its file stays, to pick another */}
      {!bankChecking && fileCard}
      {exportNotes}
      {!checking && columnsCard}
      {reading}
      {lookupProblem}
      {counts}
      {lines}

      {addButton != null && (
        <div className={classes.importBar}>
          {plan?.problem != null && <p className={classes.problem}>{plan.problem}</p>}
          {addButton}
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
  /** Only the rows a tab picks; null for every row */
  only: ((r: PlannedRow) => boolean) | null;
  /** A computer's table, rather than a phone's list */
  desktop: boolean;
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
  only,
  desktop,
}: PreviewProps) {
  const rows = only == null ? plan.rows : plan.rows.filter(only);
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
                  className={`sf-tick ${classes.tick}`}
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
        <h2 className="sr-only">
          {plan.rows.length.toLocaleString('en')} rows
          {saved > 0 && `, ${saved.toLocaleString('en')} look already saved`}
          {unreadable > 0 && `, ${unreadable.toLocaleString('en')} can't be imported`}
        </h2>
        {desktop && (
          <div
            className={`${classes.tableRow} ${classes.tableHead}`}
            aria-hidden
          >
            <span />
            <span>Date</span>
            <span>Payee, as the bank wrote it</span>
            <span>Category</span>
            <span className={classes.right}>Amount</span>
          </div>
        )}
        <ul className={desktop ? classes.table : classes.list}>
          {rows.slice(0, shown).map((r) => (
            <PreviewRow
              key={r.row}
              planned={r}
              cells={table[r.row - 1] ?? []}
              ticked={choices.ticked.has(r.row)}
              categoryId={choices.categoryOf.get(r.row) ?? r.transaction?.categoryId ?? null}
              picked={choices.categoryOf.has(r.row)}
              categories={categories}
              currency={currency}
              fromBank={plan.source === 'bank'}
              desktop={desktop}
              onTick={(on) => update((c) => (on ? c.ticked.add(r.row) : c.ticked.delete(r.row)))}
              onCategory={(id) => update((c) => c.categoryOf.set(r.row, id))}
            />
          ))}
        </ul>
        {rows.length > shown && (
          <Button
            variant="subtle"
            className={classes.showMore}
            onClick={showMore}
          >
            Show more ({(rows.length - shown).toLocaleString('en')} left)
          </Button>
        )}
      </section>
    </>
  );
}

/**
 * "42 lines from Oct 1 to Oct 31"; a computer's "Into Maybank Savings · 42 lines, Oct 1 to
 * Oct 31"
 */
function linesText(plan: Plan, into: string | null, desktop: boolean) {
  const n = plan.rows.filter((r) => r.repeats == null).length;
  const lines = `${n.toLocaleString('en')} ${n === 1 ? 'line' : 'lines'}`;
  const days = plan.rows.flatMap((r) => (r.transaction == null ? [] : [r.transaction.date])).sort();
  const span =
    days.length === 0 ? '' : `${shortDay(days[0])} to ${shortDay(days[days.length - 1])}`;
  if (!desktop) return span === '' ? lines : `${lines} from ${span}`;
  const said = span === '' ? lines : `${lines}, ${span}`;
  return into == null ? said : `Into ${into} · ${said}`;
}

/** The ids of Other and Other income, where a row goes when nothing better is known */
const otherIds = (categories: Category[]) =>
  new Set(
    [otherCategory(categories, 'expense')?.id, otherCategory(categories, 'income')?.id].filter(
      (id): id is string => id != null,
    ),
  );

/** A transaction row's category as it will be saved: as picked, else as planned */
const categoryOfRow = (r: PlannedRow, choices: Choices) =>
  choices.categoryOf.get(r.row) ?? r.transaction?.categoryId ?? null;

/** Which rows a tab shows */
function lineFilter(lines: Lines, choices: Choices, categories: Category[]) {
  if (lines === 'all') return null;
  if (lines === 'saved') return (r: PlannedRow) => r.looksSaved;
  const other = otherIds(categories);
  return (r: PlannedRow) =>
    r.transaction != null &&
    choices.ticked.has(r.row) &&
    other.has(categoryOfRow(r, choices) ?? '');
}

/** How many of each, as the check step says them */
function countsOf(plan: Plan, choices: Choices, categories: Category[]) {
  const other = otherIds(categories);
  const ticked = plan.rows.filter((r) => r.transaction != null && choices.ticked.has(r.row));
  const toOther = ticked.filter((r) => other.has(categoryOfRow(r, choices) ?? '')).length;
  return {
    toAdd: ticked.length,
    saved: plan.rows.filter((r) => r.looksSaved).length,
    toOther,
    lastTime: plan.source === 'bank' ? ticked.length - toOther : 0,
  };
}

/** The check step's counts: what's added, what looks saved, where they go */
function Counts({
  plan,
  choices,
  categories,
  desktop,
}: {
  plan: Plan;
  choices: Choices;
  categories: Category[];
  desktop: boolean;
}) {
  const c = countsOf(plan, choices, categories);
  const n = (v: number) => v.toLocaleString('en');
  const items: [string, string][] = desktop
    ? [
        ['Ticked, to add', n(c.toAdd)],
        ['Look already saved, unticked', n(c.saved)],
        ['Category from last time', n(c.lastTime)],
        ['Going to Other', n(c.toOther)],
      ]
    : [
        [n(c.toAdd), 'to add'],
        [n(c.saved), 'already saved, left out'],
        [n(c.toOther), 'going to Other'],
      ];
  return (
    <ul
      className={desktop ? classes.facts : classes.counts}
      aria-label="Counts"
    >
      {items.map(([first, second], i) => (
        <li
          key={desktop ? first : second}
          // What looks already saved, in amber as the boards draw it
          data-saved={i === 1 || undefined}
        >
          <span className={desktop ? classes.countLabel : classes.countNumber}>{first}</span>
          <span className={desktop ? classes.countNumber : classes.countLabel}>{second}</span>
        </li>
      ))}
    </ul>
  );
}

/** A computer's tabs over the lines: all of them, those already saved, those going to Other */
function LineTabs({
  plan,
  choices,
  categories,
  lines,
  onLines,
}: {
  plan: Plan;
  choices: Choices;
  categories: Category[];
  lines: Lines;
  onLines: (lines: Lines) => void;
}) {
  const c = countsOf(plan, choices, categories);
  const tabs: [Lines, string][] = [
    ['all', `All ${plan.rows.filter((r) => r.repeats == null).length.toLocaleString('en')}`],
    ['saved', `Already saved ${c.saved.toLocaleString('en')}`],
    ['other', `Going to Other ${c.toOther.toLocaleString('en')}`],
  ];
  return (
    <div
      role="tablist"
      className={classes.tabs}
    >
      {tabs.map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={lines === value}
          className={classes.tab}
          onClick={() => onLines(value)}
        >
          {label}
        </button>
      ))}
    </div>
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
  /** The person picked its category here, rather than it coming from last time */
  picked: boolean;
  categories: Category[];
  currency: string;
  fromBank: boolean;
  desktop: boolean;
  onTick: (on: boolean) => void;
  onCategory: (id: string) => void;
}

/**
 * A line of the file: ticked to add or not, its payee, day, category and amount, and what's
 * said about it. A phone's reads as a list item (R-Import), a computer's as a table row
 * (R-Desk-Import). A bank line's category is picked in place: in the accent while it's going
 * to Other, else said as it came ("Groceries, as last time").
 */
function PreviewRow({
  planned,
  cells,
  ticked,
  categoryId,
  picked,
  categories,
  currency,
  fromBank,
  desktop,
  onTick,
  onCategory,
}: RowProps) {
  const t = planned.transaction ?? planned.recurring ?? null;
  const repeats = planned.recurring;
  const other = otherIds(categories).has(categoryId ?? '');
  const day =
    repeats != null
      ? `Repeating: ${scheduleText(repeats)}, next due ${dayText(repeats.nextDue)}`
      : planned.transaction != null
        ? shortDay(planned.transaction.date)
        : null;
  // What a line says beyond its day: the accounts it's in, its category (an export's), its note
  const more = [
    planned.names == null
      ? null
      : `${planned.names.account}${
          planned.names.toAccount != null ? ` to ${planned.names.toAccount}` : ''
        }`,
    fromBank || t == null || t.categoryId == null
      ? null
      : // A category the import adds isn't saved yet: named as the file names it
        categories.some((c) => c.id === t.categoryId)
        ? categoryName(categories, t.categoryId)
        : planned.names?.category ?? null,
    planned.transaction?.note ?? null,
  ].filter((part): part is string => part != null && part !== '');
  const tick = (
    <input
      type="checkbox"
      className={`sf-tick ${classes.tick}`}
      aria-label={`Import row ${planned.row}`}
      checked={ticked}
      disabled={t == null}
      onChange={(e) => onTick(e.currentTarget.checked)}
    />
  );
  const select =
    fromBank && t != null && t.categoryId != null ? (
      <NativeSelect
        size="xs"
        aria-label="Category"
        classNames={{
          root: desktop ? classes.categoryPick : classes.inlinePick,
          input: desktop ? classes.categoryButton : classes.inlineSelect,
          section: classes.inlineArrow,
        }}
        data-other={other || undefined}
        value={categoryId ?? ''}
        onChange={(e) => onCategory(e.currentTarget.value)}
        data={categoryOptions(categories, t.kind === 'income' ? 'income' : 'expense')}
      />
    ) : null;
  const amount =
    t == null ? null : (
      <span className={classes.amount}>
        {t.kind === 'income' ? '+' : t.kind === 'expense' ? '−' : ''}
        {/* In the account's own currency, so said without its symbol, as the boards do */}
        {formatAmount(t.amountCents, currency)}
      </span>
    );
  const said = (
    <>
      {planned.problem != null && <span className={classes.problem}>{planned.problem}</span>}
      {planned.shortened.includes('payee') && (
        <span className={classes.note}>Payee shortened to {MAX_PAYEE} characters</span>
      )}
      {planned.shortened.includes('note') && (
        <span className={classes.note}>Note shortened to {MAX_NOTE} characters</span>
      )}
    </>
  );
  const flag = planned.looksSaved && <span className={classes.flag}>Looks already saved</span>;
  const payee = t == null ? `Row ${planned.row}: ${cells.join(', ')}` : t.payee ?? 'No payee';

  if (desktop) {
    return (
      <li
        className={classes.tableRow}
        data-saved={planned.looksSaved || undefined}
        data-income={t?.kind === 'income' || undefined}
      >
        <span>{tick}</span>
        <span className={classes.date}>{repeats == null ? day : null}</span>
        <span className={classes.payeeCell}>
          <span className={classes.payee}>{payee}</span>
          {flag}
          {(repeats != null || more.length > 0) && (
            <span className={classes.note}>
              {[repeats != null ? day : null, ...more].filter(Boolean).join(' · ')}
            </span>
          )}
          {said}
        </span>
        <span className={classes.categoryCell}>{select}</span>
        <span className={classes.right}>{amount}</span>
      </li>
    );
  }

  return (
    <li
      className={classes.item}
      data-income={t?.kind === 'income' || undefined}
    >
      {tick}
      <div className={classes.main}>
        <span className={classes.payee}>{payee}</span>
        {t != null && (
          <span className={classes.line}>
            {[day, ...more].filter(Boolean).join(' · ')}
            {flag != null && flag !== false && <> · {flag}</>}
            {select != null && !planned.looksSaved && (
              <>
                {' · '}
                {select}
                {!other && !picked && <span>, as last time</span>}
              </>
            )}
          </span>
        )}
        {said}
      </div>
      {amount}
    </li>
  );
}
