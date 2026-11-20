import { useThisMonth } from '../../ledger/month-start';
import { Button } from '@mantine/core';
import { useNetwork } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Fragment, useEffect, useRef, useState } from 'react';
import type { ExportRange, ExportSummary, ImportRecord } from '@shared/api';
import type { ColumnMapping } from '@shared/csv-import';
import { exportFileName } from '@shared/export';
import { api } from '../../api';
import { useIsDesktop } from '../../hooks/useBreakpoints';
import { navigate } from '../../hooks/useRoute';
import { change } from '../../ledger/ledger';
import { useAccounts, useImports, useUnsaved } from '../../ledger/useLedger';
import { isOfflineFailure } from '../../offline/network';
import { useProfile } from '../../profile/ProfileContext';
import { dayText, toDateInput } from '../../utils/date-input';
import { deliverFile } from '../../utils/deliver-file';
import { quietly } from '../../utils/quietly';
import { SettingsFooter } from '../common/Freshness';
import { handFile, takeFocusBack } from '../import/handed-file';
import { forgetMapping, rememberedMappings } from '../import/remembered-mapping';
import ResponsiveDialog from '../ui/ResponsiveDialog';
import Skeleton, { Loading } from '../ui/Skeleton';
import { dayOf, importLine } from './settings-text';
import { SectionHeader } from './SettingsPage';
import classes from './Settings.module.css';

// Import and export (?settings=data; R-Set-Data, R-Empty-Data, R-Desk-Data): choosing a
// file to import (or dropping one, on a computer), the imports recorded on the server with
// Undo for each, the bank layouts this device remembers with Forget, and the export:
// everything (the default), this calendar year or picked dates. A file of some dates says it
// holds only those, and can't restore balances on its own. On a phone the export comes
// second once there are imports to list under it, and before the short "No imports yet"
// otherwise; on a computer the imports and banks are listed inside the Import card.
export default function DataPage() {
  // The person's month (shared/period.ts)
  const month = useThisMonth();
  const isDesktop = useIsDesktop();
  const { imports } = useImports();
  const listed = imports != null && imports.length > 0;
  return (
    <div className={classes.page}>
      <SectionHeader title="Import and export" />
      {isDesktop ? (
        <div className={classes.dataCards}>
          <ImportSection>
            <RecentImports />
            <RememberedLayouts />
          </ImportSection>
          <ExportSection />
        </div>
      ) : (
        // Moved, not drawn afresh, as the imports arrive
        (listed ? PHONE_LISTED : PHONE_NONE).map((card) => (
          <Fragment key={card}>{PHONE_CARDS[card]}</Fragment>
        ))
      )}
      {!isDesktop && (
        <SettingsFooter
          month={month}
          onlyStale
        />
      )}
    </div>
  );
}

const PHONE_CARDS = {
  import: <ImportSection />,
  recent: <RecentImports />,
  banks: <RememberedLayouts />,
  export: <ExportSection />,
};
type PhoneCard = keyof typeof PHONE_CARDS;
const PHONE_LISTED: PhoneCard[] = ['import', 'export', 'recent', 'banks'];
const PHONE_NONE: PhoneCard[] = ['import', 'recent', 'banks', 'export'];

/** A list's heading over it: an eyebrow over its card on a phone, a line in a computer's card */
function ListHeading({ children, spaced = false }: { children: string; spaced?: boolean }) {
  const isDesktop = useIsDesktop();
  return (
    <p
      className={`${isDesktop ? classes.dataSub : classes.eyebrow} ${spaced ? classes.spaced : ''}`}
      aria-hidden
    >
      {children}
    </p>
  );
}

/** Opens the import with `file` */
function importFile(file: File | undefined) {
  if (file == null) return;
  handFile(file);
  navigate('?import');
}

/**
 * "Import": a bank's CSV or a Mahnee export, chosen (or dropped on a computer); a computer's
 * card holds the lists of imports and banks too (`children`)
 */
function ImportSection({ children }: { children?: ReactNode }) {
  const isDesktop = useIsDesktop();
  const [over, setOver] = useState(false);
  const label = isDesktop ? 'Import a file' : 'Choose a file';
  return (
    <section
      className={`${classes.card} ${isDesktop ? classes.importCard : classes.dataCard}`}
      aria-labelledby="data-import"
      tabIndex={-1}
    >
      <div className={isDesktop ? classes.importHead : undefined}>
        <div className={classes.dataHead}>
          <h2
            id="data-import"
            className={classes.dataTitle}
          >
            Import
          </h2>
          <p className={classes.dataLine}>A bank's CSV or a Mahnee export</p>
        </div>
        {isDesktop && <FileButton label={label} />}
      </div>
      {!isDesktop && <FileButton label={label} />}
      {isDesktop && (
        <div
          className={`${classes.dropZone} ${over ? classes.dropOver : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            importFile(e.dataTransfer?.files?.[0]);
          }}
        >
          Or drop a CSV here
        </div>
      )}
      {children}
    </section>
  );
}

/** The file picker, drawn as the board's filled pill */
function FileButton({ label }: { label: string }) {
  const input = useRef<HTMLInputElement>(null);
  // Back from an import left without importing, the keyboard is here again
  useEffect(() => {
    if (takeFocusBack()) input.current?.focus({ preventScroll: true });
  }, []);
  return (
    <label className={classes.fileButton}>
      {label}
      <input
        ref={input}
        type="file"
        accept=".csv,text/csv"
        aria-label={label}
        className={classes.fileInput}
        onChange={(e) => importFile(e.currentTarget.files?.[0])}
      />
    </label>
  );
}

/** Recent imports, as every device lists them, each with Undo */
function RecentImports() {
  const isDesktop = useIsDesktop();
  const { imports, failed } = useImports();
  const { accounts } = useAccounts();
  const [undoing, setUndoing] = useState<ImportRecord | null>(null);
  const nameOf = (id: string | null) =>
    id == null ? null : accounts?.find((a) => a.id === id)?.name ?? null;

  const listed = imports != null && imports.length > 0;
  let said = null;
  if (imports == null) {
    said = failed ? (
      <p className={classes.dataNone}>Couldn't load recent imports.</p>
    ) : (
      <Loading label="Loading recent imports">
        <Skeleton
          width="70%"
          height={14}
        />
      </Loading>
    );
  } else if (!listed) said = <p className={classes.dataNone}>No imports yet</p>;

  return (
    <>
      {/* With none yet, a phone's is a small card of its own, named inside it */}
      {(listed || isDesktop) && <ListHeading>Recent imports</ListHeading>}
      <section
        className={
          isDesktop ? classes.dataList : `${classes.card} ${listed ? '' : classes.emptyCard}`
        }
        aria-label="Recent imports"
      >
        {!listed && !isDesktop && (
          <h2
            className={classes.emptyTitle}
            aria-hidden
          >
            Recent imports
          </h2>
        )}
        {listed ? (
          <ul className={classes.list}>
            {imports.map((record) => {
              const line = importLine(record, nameOf(record.accountId));
              return (
                <li
                  key={record.id}
                  className={classes.dataRow}
                >
                  <div className={classes.rowText}>
                    <div className={classes.dataName}>{record.fileName}</div>
                    <div className={classes.dataDetail}>{isDesktop ? line.where : line.line}</div>
                  </div>
                  {isDesktop && <span className={classes.dataCounts}>{line.counts}</span>}
                  <Button
                    variant="light"
                    size="xs"
                    onClick={() => setUndoing(record)}
                  >
                    {isDesktop ? 'Undo import' : 'Undo'}
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          said
        )}
      </section>
      <UndoImport
        record={undoing}
        onClose={() => setUndoing(null)}
      />
    </>
  );
}

/**
 * Asks before undoing an import: its entries are deleted on the server, wherever they are
 * now, through the outbox like any change (so offline it's sent once back)
 */
function UndoImport({ record, onClose }: { record: ImportRecord | null; onClose: () => void }) {
  // Kept while the dialog closes, so its words don't go blank
  const [shown, setShown] = useState<ImportRecord | null>(null);
  if (record != null && record !== shown) setShown(record);
  const entries = shown?.addedCount ?? 0;
  return (
    <ResponsiveDialog
      opened={record != null}
      onClose={onClose}
      title={`Undo ${shown?.fileName ?? ''}?`}
      width={420}
      floating
    >
      <div className={classes.dialogForm}>
        <p className={classes.dialogText}>
          {`Its ${entries.toLocaleString('en')} ${entries === 1 ? 'entry is' : 'entries are'} deleted${shown?.openingChanged === true ? ' and the opening balance it changed goes back' : ''}, on every device. Accounts and categories it added stay.`}
        </p>
        <div className={classes.dialogActions}>
          <Button
            variant="default"
            onClick={onClose}
          >
            Keep it
          </Button>
          <Button
            color="red"
            onClick={() => {
              if (shown != null) change({ op: 'undoImport', id: shown.id });
              onClose();
            }}
          >
            Undo import
          </Button>
        </div>
      </div>
    </ResponsiveDialog>
  );
}

/** "Transaction Date, Description, Amount (MYR)": the columns a layout reads, in order */
const columnsOf = (m: ColumnMapping) =>
  [m.date, m.payee, m.amount, m.moneyOut, m.moneyIn, m.note]
    .filter((c): c is string => c != null)
    .join(', ');

/** The bank layouts this device remembers, by account, each with Forget */
function RememberedLayouts() {
  const isDesktop = useIsDesktop();
  const { profile } = useProfile();
  const { accounts } = useAccounts();
  const email = profile?.email ?? null;
  // Read afresh after each Forget
  const [, setForgotten] = useState(0);
  const layouts = rememberedMappings(email).flatMap(({ accountId, mapping }) => {
    const account = accounts?.find((a) => a.id === accountId);
    return account == null ? [] : [{ account, mapping }];
  });
  if (layouts.length === 0) return null;
  return (
    <>
      <ListHeading
        // A line's room further from Recent imports, as the boards leave it
        spaced
      >
        Banks it remembers
      </ListHeading>
      <section
        className={isDesktop ? classes.dataList : classes.card}
        aria-label={isDesktop ? 'Remembered column layouts' : 'Banks it remembers'}
      >
        <ul className={classes.list}>
          {layouts.map(({ account, mapping }) => (
            <li
              key={account.id}
              className={classes.dataRow}
            >
              <div className={classes.rowText}>
                <div className={classes.dataName}>{account.name}</div>
                <div className={classes.dataDetail}>{columnsOf(mapping)}</div>
              </div>
              <Button
                variant="light"
                size="xs"
                onClick={() => {
                  forgetMapping(email, account.id);
                  setForgotten((n) => n + 1);
                }}
              >
                Forget
              </Button>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

type Which = 'everything' | 'year' | 'pick';
const WHICH: { value: Which; label: string }[] = [
  { value: 'everything', label: 'Everything' },
  { value: 'year', label: 'This year' },
  { value: 'pick', label: 'Pick dates' },
];

const LAST_DOWNLOADED = 'mahnee:lastDownloaded:';

/** "1 thing", "3 things", with thousands marked */
const count = (n: number, one: string, many: string) =>
  `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

/**
 * The export: which entries (everything, this calendar year or picked dates, both days
 * included), what the file holds, counted by the server, and Download CSV. The file comes
 * from the server, so it needs a connection, and changes still waiting on this device
 * aren't in it yet.
 */
function ExportSection() {
  const isDesktop = useIsDesktop();
  const { online } = useNetwork();
  const { waiting } = useUnsaved();
  const { profile } = useProfile();
  const email = profile?.email ?? null;
  const today = toDateInput(new Date());
  const year = today.slice(0, 4);
  const [which, setWhich] = useState<Which>('everything');
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When this person last downloaded one on this device, kept once it's known whose it is
  const [downloaded, setDownloaded] = useState<{ at: string; kept: boolean } | null>(null);
  // Someone else signed in on the open page: the last person's is theirs, not shown here
  const [shownFor, setShownFor] = useState(email);
  if (shownFor !== email) {
    setShownFor(email);
    if (shownFor != null) setDownloaded(null);
  }
  useEffect(() => {
    if (email == null) return;
    if (downloaded != null && !downloaded.kept) {
      quietly(() => localStorage.setItem(LAST_DOWNLOADED + email, downloaded.at));
      setDownloaded({ ...downloaded, kept: true });
    } else if (downloaded == null) {
      const at = quietly(() => localStorage.getItem(LAST_DOWNLOADED + email)) ?? null;
      if (at != null) setDownloaded({ at, kept: true });
    }
  }, [email, downloaded]);

  const picked = from !== '' && to !== '' && from <= to;
  const range: ExportRange | null =
    which === 'everything'
      ? null
      : which === 'year'
        ? { from: `${year}-01-01`, to: `${year}-12-31` }
        : picked
          ? { from, to }
          : null;
  const ready = which !== 'pick' || picked;
  // Counted afresh for each choice, and again as waiting changes are saved
  const { data, isError } = useQuery({
    queryKey: ['export-summary', waiting, range?.from ?? '', range?.to ?? ''],
    queryFn: () => api.getExportSummary(range),
    enabled: ready,
    staleTime: 0,
    gcTime: 0,
  });

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const file = await api.getExport(range);
      const delivery = await deliverFile(file, exportFileName(today, range), {
        title: 'Mahnee export',
        share: !isDesktop,
      });
      if (delivery !== 'cancelled') setDownloaded({ at: String(Date.now()), kept: false });
    } catch (err) {
      setError(
        isOfflineFailure(err)
          ? "Couldn't reach Mahnee. Check the connection and try again."
          : "Couldn't download the file. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  const empty = data != null && data.transactions === 0;
  return (
    <section
      className={`${classes.card} ${classes.dataCard}`}
      aria-labelledby="data-export"
      tabIndex={-1}
    >
      <div className={classes.dataHead}>
        <h2
          id="data-export"
          className={classes.dataTitle}
        >
          Export
        </h2>
        <p className={classes.dataLine}>CSV for Excel, Numbers or Google Sheets</p>
      </div>
      <div
        role="radiogroup"
        aria-label="Which entries"
        className={classes.segmented}
      >
        {WHICH.map((w) => (
          <label
            key={w.value}
            className={classes.segment}
            data-on={which === w.value || undefined}
          >
            <input
              type="radio"
              name="which-entries"
              aria-label={w.label}
              className={classes.fileInput}
              checked={which === w.value}
              onChange={() => setWhich(w.value)}
            />
            {w.label}
          </label>
        ))}
      </div>
      {which === 'pick' && (
        <div className={classes.days}>
          <label className={classes.dayField}>
            From
            <input
              type="date"
              value={from}
              min="2000-01-01"
              onChange={(e) => setFrom(e.currentTarget.value)}
            />
          </label>
          <label className={classes.dayField}>
            To
            <input
              type="date"
              value={to}
              min="2000-01-01"
              onChange={(e) => setTo(e.currentTarget.value)}
            />
          </label>
        </div>
      )}
      {!ready ? (
        <p
          className={classes.problem}
          role="alert"
        >
          Pick a From day on or before the To day
        </p>
      ) : (
        <Holds
          data={data ?? null}
          failed={isError}
          online={online}
          ranged={range != null}
        />
      )}
      {waiting > 0 && (
        <p
          className={classes.detail}
          role="status"
        >
          {count(waiting, 'change', 'changes')} still being saved won't be in the file yet.
        </p>
      )}
      <Button
        className={classes.primaryPill}
        disabled={!online || !ready || empty || data == null}
        loading={busy}
        onClick={() => void download()}
      >
        {online ? 'Download CSV' : 'Connect to download'}
      </Button>
      {isDesktop && downloaded != null && (
        <p className={classes.detail}>Last downloaded {dayOf(Number(downloaded.at))}</p>
      )}
      {error && (
        <p
          className={classes.problem}
          role="alert"
        >
          {error}
        </p>
      )}
    </section>
  );
}

/** What the file holds: a line on phones, its figures listed on a computer */
function Holds({
  data,
  failed,
  online,
  ranged,
}: {
  data: ExportSummary | null;
  failed: boolean;
  online: boolean;
  ranged: boolean;
}) {
  const isDesktop = useIsDesktop();
  if (data == null) {
    if (failed) return <p className={classes.holds}>Couldn't count what's in it.</p>;
    if (!online) return null;
    return (
      <Loading label="Counting what's in it">
        <Skeleton
          width="85%"
          height={14}
        />
      </Loading>
    );
  }
  if (data.transactions === 0 || data.firstDate == null || data.lastDate == null) {
    return (
      <p className={classes.holds}>
        {ranged ? 'Nothing to export on these days' : 'Nothing to export yet'}
      </p>
    );
  }
  if (!isDesktop) {
    return (
      <p className={classes.holds}>
        {`${count(data.transactions, 'entry', 'entries')} · ${count(data.accounts, 'account', 'accounts')} · since ${dayText(data.firstDate)}`}
      </p>
    );
  }
  const facts: [string, string][] = [
    ['Entries', data.transactions.toLocaleString('en')],
    ['From', `${dayText(data.firstDate)} to ${dayText(data.lastDate)}`],
    ['Accounts', data.accounts.toLocaleString('en')],
    [
      'Categories',
      ranged
        ? data.categories.toLocaleString('en')
        : `${data.categories.toLocaleString('en')}, archived ones too`,
    ],
  ];
  return (
    <ul
      className={classes.facts}
      aria-label="What the file holds"
    >
      {facts.map(([label, value]) => (
        <li key={label}>
          <span className={classes.factLabel}>{label}</span>
          <span className={classes.factValue}>{value}</span>
        </li>
      ))}
    </ul>
  );
}
