import { Modal } from '@mantine/core';
import { CalendarIcon, CloseIcon, DownIcon, ForwardIcon, RepeatIcon } from '../ui/icons';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import type { LedgerChange, Original } from '@shared/api';
import type { CategoryKind } from '@shared/categories';
import type { Keypad, KeypadKey } from '@shared/keypad';
import {
  EMPTY_KEYPAD,
  amountShown,
  centsShown,
  expressionLine,
  press,
  totalCents,
  typeKeys,
} from '@shared/keypad';
import type { TransactionKind } from '@shared/ledger';
import {
  MAX_PAYEE,
  MAX_TRANSACTION,
  MAX_TRANSACTION_CENTS,
  categoryKindFor,
  readOptionalText,
} from '@shared/ledger';
import { ENTRY_CURRENCIES, MAX_TYPED_CENTS, convertCents } from '@shared/rates';
import type { Schedule } from '@shared/recurring';
import { dayFor, nextAfter } from '@shared/recurring';
import { useBackDismiss } from '../../hooks/useBackDismiss';
import { useIsDesktop } from '../../hooks/useBreakpoints';
import { useRate } from '../../hooks/useRate';
import { change, changeTyped } from '../../ledger/ledger';
import { isOffline } from '../../offline/network';
import { lastUsed, recentCategoryIds, rememberUsed } from '../../ledger/last-used';
import { useAccounts, useCategories } from '../../ledger/useLedger';
import { useProfile, useCurrency } from '../../profile/ProfileContext';
import { categoryColour } from '../../utils/category-colour';
import { api } from '../../api';
import { clockText, dayHeading, isPastDay, toDateInput, toTimeInput } from '../../utils/date-input';
import { newId } from '../../utils/id';
import { showRefusal } from '../../utils/notify';
import { currencySymbol, formatMoney } from '../../utils/money';
import CurrencyList from '../common/CurrencyList';
import { SOURCE_NAMES, rateDate, shortDay } from '../common/typed-amount';
import { showUndo } from '../common/undo-toast';
import AccountForm from '../accounts/AccountForm';
import { balanceText } from '../accounts/account-text';
import BackButton from '../ui/BackButton';
import Key from '../ui/Key';
import { useReturnFocus } from '../ui/return-focus';
import type { AddDraft } from './add-draft';
import { dropDraft, keepDraft, readDraft } from './add-draft';
import {
  LIMIT_TEXT,
  limitText,
  listedCategories,
  recentCategories,
  saveLabel,
  suggestedPayees,
} from './add-text';
import type { NewCategory } from './CategoryPicker';
import CategoryPicker from './CategoryPicker';
import {
  noteEntryCurrency,
  pickTodaysCurrency,
  todaysEntryCurrencies,
  travelCurrency,
} from './travel-sense';
import classes from './AddEntry.module.css';

// Add (R-Add, R-Desk-Add): a new transaction. On phones and tablets it covers the screen,
// with a keypad that works sums out in whole cents (shared/keypad.ts); on a computer it's a
// dialog, "New entry", whose figure takes the same sums typed (R-Desk-Add). Which way it went;
// the account it's From (Into, for income) and the category it's For (From), or for a
// transfer the two accounts with their balances; the five recent categories as chips; one
// "Payee or note" field, which fills the payee (owner decision D10: the note stays apart,
// edited on the entry); Today (the day) and Repeat. Save says what it will do, or why it
// can't yet. What's typed is kept as a draft on this device when Add is closed any way but
// Save, and Add says so, with Discard draft to throw it away. It opens on the amount, or on the categories when the person chose to start with
// the category (D9). Saving is one change() through the ledger and its outbox, a new
// category first. The figure's currency is a pill before it, with an arrow: a tap opens every
// currency, the home currency and the person's other currencies first, then the ones used
// today on this device. In another currency it says what that comes to at
// today's rate, and the entry is sent as typed (changeTyped) for the server to convert at
// its own day's rate. Travel sense (travel-sense.ts) may open it in the day's currency.

/** What Add was opened for: a new entry, on `accountId` when it's that account's page */
export interface AddRequest {
  accountId?: string;
  /** Which way it opens (an account's Transfer), over a kept draft's */
  kind?: TransactionKind;
  /**
   * The account was asked for by name (an account's Add here or Transfer): it's in From
   * over a kept draft's, the rest of the draft kept
   */
  fromHere?: boolean;
}

export default function AddEntry({
  open,
  onClose,
}: {
  open: AddRequest | null;
  onClose: () => void;
}) {
  const isDesktop = useIsDesktop() === true;
  // Back closes it on phones and tablets, keeping the draft
  useBackDismiss(open != null, onClose, { tablets: true });
  // Focus goes back to Add or New entry once it closes, unless it went somewhere since
  const root = useReturnFocus(open != null);

  return (
    <Modal.Root
      ref={root}
      opened={open != null}
      returnFocus={false}
      onClose={onClose}
      fullScreen={!isDesktop}
      size={560}
      // A computer's opens 72px down the page, over a darker scrim
      yOffset={72}
      closeOnEscape={false}
      classNames={{ content: isDesktop ? classes.dialog : classes.screen, body: classes.body }}
      transitionProps={{ duration: isDesktop ? 150 : 0 }}
    >
      <Modal.Overlay
        backgroundOpacity={isDesktop ? 0.5 : 0.38}
        color="#0f1012"
      />
      <Modal.Content aria-label={isDesktop ? undefined : 'New entry'}>
        <Modal.Body>
          {/* A fresh form each time it opens, from the draft if one was left */}
          {open != null && (
            <AddForm
              request={open}
              desktop={isDesktop}
              onDone={onClose}
            />
          )}
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}

/** Closes Add; with something typed it says the draft is kept */
const CloseButton = ({ onClose, keeps }: { onClose: () => void; keeps: boolean }) => (
  <button
    type="button"
    className={classes.close}
    aria-label={keeps ? 'Keep draft and close' : 'Close'}
    onClick={onClose}
  >
    <CloseIcon
      size={20}
      aria-hidden
    />
  </button>
);

const KINDS: { value: TransactionKind; label: string }[] = [
  { value: 'expense', label: 'Expense' },
  { value: 'income', label: 'Income' },
  { value: 'transfer', label: 'Transfer' },
];

const KEYS: { key: KeypadKey; label: string; name: string; look?: 'fn' | 'op' | 'eq' }[] = [
  { key: '1', label: '1', name: '1' },
  { key: '2', label: '2', name: '2' },
  { key: '3', label: '3', name: '3' },
  { key: 'delete', label: '⌫', name: 'Delete, hold to clear', look: 'fn' },
  { key: '4', label: '4', name: '4' },
  { key: '5', label: '5', name: '5' },
  { key: '6', label: '6', name: '6' },
  { key: '×', label: '×', name: 'Times', look: 'op' },
  { key: '7', label: '7', name: '7' },
  { key: '8', label: '8', name: '8' },
  { key: '9', label: '9', name: '9' },
  { key: '−', label: '−', name: 'Minus', look: 'op' },
  { key: '.', label: '.', name: 'Decimal point', look: 'fn' },
  { key: '0', label: '0', name: '0' },
  { key: '=', label: '=', name: 'Work it out', look: 'eq' },
  { key: '+', label: '+', name: 'Plus', look: 'op' },
];

/** How long Delete is held to clear the amount */
const HOLD_MS = 500;

const NO_DESTINATION = 'Add another account to move money to';
const BAD_DAY = 'Pick a day from 2000 up to today';
const REPEATS: { value: Schedule | ''; label: string }[] = [
  { value: '', label: "Doesn't repeat" },
  { value: 'monthly', label: 'Monthly' },
  { value: 'weekly', label: 'Weekly' },
];

/** What's open over or under the entry; `today` is the day's currency, from travel sense */
type Picking = 'from' | 'to' | 'category' | 'currency' | 'today' | null;

function AddForm({
  request,
  desktop,
  onDone,
}: {
  request: AddRequest;
  desktop: boolean;
  onDone: () => void;
}) {
  const homeCurrency = useCurrency();
  const { accounts } = useAccounts();
  const { categories, tree } = useCategories();
  const { profile } = useProfile();
  const email = profile?.email ?? null;
  const settings = profile?.settings;
  const [remembered] = useState(() => lastUsed(email));
  const [draft] = useState(() => readDraft(email));

  const [kind, setKind] = useState<TransactionKind>(request.kind ?? draft?.kind ?? 'expense');
  const [keypad, setKeypad] = useState<Keypad>(
    draft == null ? EMPTY_KEYPAD : { expr: draft.expr, fresh: false, tooMuch: false },
  );
  const [accountId, setAccountId] = useState<string | null>(
    request.fromHere ? request.accountId ?? null : draft?.accountId ?? null,
  );
  const [toAccountId, setToAccountId] = useState<string | null>(draft?.toAccountId ?? null);
  const [picked, setPicked] = useState<Partial<Record<CategoryKind, string>>>(() => {
    const kindOf = draft == null ? null : categoryKindFor(draft.kind);
    return kindOf != null && draft?.categoryId != null ? { [kindOf]: draft.categoryId } : {};
  });
  const [made, setMade] = useState<NewCategory | null>(draft?.newCategory ?? null);
  const [payee, setPayee] = useState(draft?.payee ?? '');
  const [date, setDate] = useState<string | null>(draft?.date ?? null);
  // Ask for a time: the time Add was opened, until another is typed; what the day says is
  // what's saved
  const askForTime = settings?.askForTime === true;
  const [time, setTime] = useState(() => toTimeInput(new Date()));
  const [timeTyped, setTimeTyped] = useState(time);
  const [repeat, setRepeat] = useState<Schedule | ''>(draft?.repeat ?? '');
  // The currency it's typed in: the draft's, else the day's (travel sense), else the home one
  const others = (settings?.otherCurrencies ?? []).filter((c) => c !== homeCurrency);
  const [travel, setTravel] = useState(() =>
    travelCurrency({
      email,
      home: homeCurrency,
      others,
      on: settings?.travelSense !== false,
      today: toDateInput(new Date()),
    }),
  );
  const [typedIn, setTypedIn] = useState(draft?.currency ?? travel ?? homeCurrency);
  const [showRate, setShowRate] = useState(false);
  const [picking, setPicking] = useState<Picking>(
    draft == null && settings?.startWith === 'category' ? 'category' : null,
  );
  const [showDate, setShowDate] = useState(false);
  // Add account, over a transfer with nowhere to go; the one made is where it goes
  const [addingAccount, setAddingAccount] = useState(false);
  const [showRepeat, setShowRepeat] = useState(false);
  const ids = { hint: useId(), way: useId() };
  // A computer's For row, where the category is typed while its list is open
  const [forSlot, setForSlot] = useState<HTMLElement | null>(null);
  // A phone's entry under a list's sheet takes no focus or taps until the sheet closes
  const phoneForm = useRef<HTMLFormElement>(null);
  useEffect(() => {
    phoneForm.current?.toggleAttribute('inert', picking != null);
  }, [picking]);

  // Back closes a phone's list first, then Add
  useBackDismiss(!desktop && picking != null, () => setPicking(null), { tablets: true });

  // Accounts: the page's own, else the one set to use, else the one used last, else the first
  const running = (accounts ?? []).filter((a) => !a.archived);
  const runningOne = (id: string | null | undefined) => running.find((a) => a.id === id);
  const fromDefault =
    runningOne(request.accountId) ?? runningOne(settings?.defaultAccountId) ?? undefined;
  const fromRemembered = fromDefault == null ? runningOne(remembered.accountId) : undefined;
  const account = runningOne(accountId) ?? fromDefault ?? fromRemembered ?? running[0];
  const lastUsedHint =
    account != null && fromRemembered?.id === account.id && runningOne(accountId) == null;
  const destinations = running.filter((a) => a.id !== account?.id);
  const toAccount =
    destinations.find((a) => a.id === toAccountId) ??
    destinations.find((a) => a.id === remembered.toAccountId) ??
    destinations[0];
  const currency = account?.currency ?? homeCurrency;
  const elsewhere = typedIn !== currency;
  const rate = useRate(typedIn, currency, { enabled: elsewhere });
  const quote = elsewhere ? rate.data ?? null : null;
  const suggestions = useSuggestions(
    settings?.suggestAsYouType === true ? account?.id ?? null : null,
  );
  const suggestionsId = useId();

  // Categories: a new one being made, else the one picked, else the one used last, else the first
  const transfer = kind === 'transfer';
  const categoryKind = categoryKindFor(kind);
  const nodes = categoryKind == null ? [] : tree?.listed[categoryKind] ?? [];
  const listed = listedCategories(nodes);
  const listedOne = (id: string | null | undefined) => listed.find((c) => c.id === id);
  const category =
    categoryKind == null
      ? undefined
      : listedOne(picked[categoryKind]) ??
        listedOne(remembered.categoryIds[categoryKind]) ??
        listed[0];
  const madeParent = made == null ? null : nodes.find((n) => n.id === made.parentId);
  const newCategory = made != null && (made.parentId == null || madeParent != null) ? made : null;
  const categoryId = newCategory?.id ?? category?.id;
  const recent =
    categoryKind == null ? [] : recentCategories(recentCategoryIds(email, categoryKind), nodes);

  // The day: Today unless another was picked, read afresh each time it's drawn
  const today = toDateInput(new Date());
  const day = date ?? today;
  const dayOk = isPastDay(day);
  const total = totalCents(keypad.expr);
  // In another currency: what it comes to in the home one, at the rate this device has
  const estimate =
    !elsewhere || total <= 0
      ? null
      : quote == null
        ? null
        : Math.max(1, convertCents(total, quote.rate));
  // Offline with no rate on this device (a pair never asked for here): saved as typed, its
  // conversion pending until the server makes it at the entry's own day's rate. Only for
  // want of a connection: online, a rate that can't be had still stops Add. Not for a
  // repeating one, whose amount is needed as it's set up.
  const conversionPending =
    elsewhere &&
    total > 0 &&
    quote == null &&
    repeat === '' &&
    (rate.fetchStatus === 'paused' || (rate.isError && isOffline()));
  const rateReason =
    !elsewhere || total <= 0
      ? null
      : quote == null
        ? conversionPending
          ? null
          : `Needs a rate for ${typedIn}`
        : estimate! > MAX_TRANSACTION_CENTS
          ? `Comes to more than ${MAX_TRANSACTION.toLocaleString('en')} ${currency}`
          : null;
  // Typed in another currency it may go past the home one's limit, up to its own; switched
  // back, a figure past the home one's is too much
  const typedLimit = elsewhere ? MAX_TYPED_CENTS : MAX_TRANSACTION_CENTS;
  const tooMuchText = elsewhere ? limitText(MAX_TYPED_CENTS) : LIMIT_TEXT;
  const tooMuch = keypad.tooMuch || Math.abs(total) > typedLimit;
  const reason = tooMuch ? tooMuchText : total <= 0 ? null : !dayOk ? BAD_DAY : rateReason;
  const label = reason ?? saveLabel(kind, keypad, typedIn, currency);
  const savable =
    !tooMuch &&
    total > 0 &&
    dayOk &&
    rateReason == null &&
    account != null &&
    (transfer ? toAccount != null : categoryId != null);

  // What's typed is kept as it changes, so Close, Back and Esc all keep it; an Add with
  // nothing typed in it keeps none, so what was used last still decides next time
  const typedSomething =
    keypad.expr !== '' || payee.trim() !== '' || made != null || date != null || repeat !== '';
  // A currency picked alone isn't kept: next time opens as it would
  const kept: AddDraft = {
    kind,
    expr: keypad.expr,
    accountId: runningOne(accountId)?.id ?? null,
    toAccountId: transfer ? destinations.find((a) => a.id === toAccountId)?.id ?? null : null,
    categoryId: categoryKind == null ? null : listedOne(picked[categoryKind])?.id ?? null,
    newCategory,
    payee,
    date: dayOk ? date : null,
    repeat,
    ...(typedIn !== homeCurrency && { currency: typedIn }),
  };
  const keptText = JSON.stringify(kept);
  const saved = useRef(false);
  useEffect(() => {
    if (saved.current) return;
    if (typedSomething) keepDraft(email, JSON.parse(keptText) as AddDraft);
    else dropDraft(email);
  }, [email, keptText, typedSomething]);

  const pickKind = (next: TransactionKind) => {
    setKind(next);
    setMade(null);
  };
  const pickCategory = (id: string) => {
    if (categoryKind != null) setPicked((before) => ({ ...before, [categoryKind]: id }));
    setMade(null);
    setPicking(null);
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!savable || account == null) return;
    const fields = {
      kind,
      accountId: account.id,
      toAccountId: transfer ? toAccount?.id ?? null : null,
      amountCents: total,
      categoryId: transfer ? null : categoryId ?? null,
      payee: readOptionalText(payee, MAX_PAYEE) ?? null,
      note: null,
      date: day,
      ...(askForTime && { time }),
    };
    const changes: LedgerChange[] = [];
    if (!transfer && newCategory != null && categoryKind != null) {
      changes.push({
        op: 'addCategory',
        category: {
          id: newCategory.id,
          name: newCategory.name,
          kind: categoryKind,
          parentId: newCategory.parentId,
        },
      });
    }
    changes.push({ op: 'addTransaction', transaction: { id: newId(), ...fields } });
    if (repeat !== '') {
      // From its day, first due on the next one after the person's today
      const repeatDay = dayFor(repeat, day);
      changes.push({
        op: 'addRecurring',
        recurring: {
          id: newId(),
          kind,
          accountId: fields.accountId,
          toAccountId: fields.toAccountId,
          amountCents: fields.amountCents,
          categoryId: fields.categoryId,
          payee: fields.payee,
          schedule: repeat,
          day: repeatDay,
          startDate: day,
          nextDue: nextAfter(repeat, repeatDay, today),
        },
      });
    }
    if (!elsewhere) change(...changes);
    else {
      // Sent as typed; shown until saved at the rate this device has, saying what was typed,
      // or with no rate here, at nothing and marked as pending
      const original: Original =
        quote == null
          ? {
              currency: typedIn,
              cents: total,
              rate: 0,
              source: 'wise',
              at: Date.parse(`${day}T12:00:00Z`),
              day,
              pending: true,
            }
          : {
              currency: typedIn,
              cents: total,
              rate: quote.rate,
              source: quote.source,
              at: quote.fetchedAt,
              ...(quote.day != null && { day: quote.day }),
            };
      const shownCents = quote == null ? 0 : estimate!;
      const shown = changes.map((c): LedgerChange => {
        if (c.op === 'addTransaction') {
          return {
            ...c,
            transaction: {
              ...c.transaction,
              amountCents: shownCents,
              original,
            } as typeof c.transaction,
          };
        }
        if (c.op === 'addRecurring') {
          return { ...c, recurring: { ...c.recurring, amountCents: shownCents } };
        }
        return c;
      });
      changeTyped(typedIn, changes, shown);
    }
    noteEntryCurrency(email, today, typedIn);
    if (fields.toAccountId != null) rememberUsed(email, { toAccountId: fields.toAccountId });
    else if (categoryKind != null && fields.categoryId != null) {
      rememberUsed(email, {
        accountId: account.id,
        kind: categoryKind,
        categoryId: fields.categoryId,
      });
    }
    saved.current = true;
    dropDraft(email);
    onDone();
  };

  // Discard draft: closes Add with nothing kept, so it opens fresh, and Undo puts it back
  const discard = () => {
    const was = JSON.parse(keptText) as AddDraft;
    saved.current = true;
    dropDraft(email);
    onDone();
    // Undo brings it back unless a newer draft has been kept since
    showUndo('Draft discarded', () => {
      if (readDraft(email) == null) keepDraft(email, was);
      else showRefusal("A newer draft is kept, so the discarded one can't come back");
    });
  };
  // Says that what's typed is kept, and how to throw it away
  const draftLine = typedSomething && (
    <div className={classes.draftLine}>
      <span>{draft != null ? 'Draft kept from last time' : 'Kept as a draft until saved'}</span>
      <button
        type="button"
        className={classes.discard}
        onClick={discard}
      >
        Discard draft
      </button>
    </div>
  );

  // Esc closes what's open in Add first, then Add, keeping the draft
  const onKeyDown = (e: KeyboardEvent) => {
    // Add account's own keys are its own (its dialog is drawn inside Add)
    if (e.key !== 'Escape' || addingAccount) return;
    e.preventDefault();
    e.stopPropagation();
    if (picking != null) setPicking(null);
    else if (showRepeat) setShowRepeat(false);
    else onDone();
  };

  const forLabel =
    newCategory != null
      ? madeParent != null
        ? `${madeParent.name} › ${newCategory.name}`
        : newCategory.name
      : category?.fullName ?? 'No category';
  const forDot = categoryColour(categories ?? [], madeParent?.id ?? category?.id ?? '');

  const accountPicker = (which: 'from' | 'to') => {
    const list = which === 'from' ? running : destinations;
    const chosen = which === 'from' ? account : toAccount;
    const name = which === 'to' ? 'To' : kind === 'income' ? 'Into' : 'From';
    return (
      <Picker
        page={!desktop}
        title={name}
        onBack={() => setPicking(null)}
      >
        <div
          role="radiogroup"
          aria-label={name}
          className={classes.pickCard}
        >
          {list.map((a) => (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={a.id === chosen?.id}
              aria-label={`${a.name} ${balanceText(a)}`}
              className={`${classes.option} ${a.id === chosen?.id ? classes.optionOn : ''}`}
              onClick={() => {
                if (which === 'from') setAccountId(a.id);
                else setToAccountId(a.id);
                setPicking(null);
              }}
            >
              <span className={classes.optionText}>{a.name}</span>
              <span className={classes.why}>{balanceText(a)}</span>
            </button>
          ))}
        </div>
      </Picker>
    );
  };

  const categoryPicker =
    categoryKind == null ? null : (
      <CategoryPicker
        kind={categoryKind}
        categories={categories ?? []}
        nodes={nodes}
        recent={recent}
        payee={payee}
        accountId={account?.id ?? null}
        page={!desktop}
        inputSlot={forSlot}
        onPick={pickCategory}
        onCreate={(next) => {
          setMade({ id: newId(), ...next });
          setPicking(null);
        }}
        onBack={() => setPicking(null)}
      />
    );
  // Every currency, the person's own first, then the ones used today on this device; picking
  // one for the day (travel sense) keeps it
  const yours = [currency, ...others];
  const usedToday = todaysEntryCurrencies(email, today).filter((c) => !yours.includes(c));
  const pickCurrency = (code: string) => {
    if (picking === 'today') {
      pickTodaysCurrency(email, today, code);
      setTravel(code === currency ? null : code);
    }
    setTypedIn(code);
    setShowRate(false);
    setPicking(null);
  };
  const currencyPicker = (
    <Picker
      page={!desktop}
      title={picking === 'today' ? 'Today’s currency' : 'Currency'}
      onBack={() => setPicking(null)}
    >
      <CurrencyList
        groups={[
          ['Yours', yours],
          ...(usedToday.length > 0 ? [['Used today', usedToday] as [string, string[]]] : []),
          [
            'All currencies',
            ENTRY_CURRENCIES.filter((c) => !yours.includes(c) && !usedToday.includes(c)),
          ],
        ]}
        current={typedIn}
        onPick={pickCurrency}
      />
    </Picker>
  );
  const pickerShown =
    picking === 'category'
      ? categoryPicker
      : picking === 'currency' || picking === 'today'
        ? currencyPicker
        : picking == null
          ? null
          : accountPicker(picking);

  const rows = transfer ? (
    <>
      <Row
        k="From"
        value={account?.name ?? ''}
        hint={account == null ? '' : balanceText(account)}
        onClick={() => setPicking(picking === 'from' ? null : 'from')}
      />
      {desktop && picking === 'from' && pickerShown}
      {toAccount == null ? (
        <div className={classes.rowNote}>
          <span>{NO_DESTINATION}</span>
          <button
            type="button"
            className={classes.noteAction}
            onClick={() => setAddingAccount(true)}
          >
            Add account
          </button>
        </div>
      ) : (
        <Row
          k="To"
          value={toAccount.name}
          hint={balanceText(toAccount)}
          onClick={() => setPicking(picking === 'to' ? null : 'to')}
        />
      )}
      {desktop && picking === 'to' && pickerShown}
    </>
  ) : (
    <>
      <Row
        k={kind === 'income' ? 'Into' : 'From'}
        value={account?.name ?? ''}
        hint={lastUsedHint ? 'last used' : ''}
        onClick={() => setPicking(picking === 'from' ? null : 'from')}
      />
      {desktop && picking === 'from' && pickerShown}
      {desktop && picking === 'category' ? (
        // Typed into in place (R-Desk-Add-Pick)
        <div
          className={classes.row}
          data-row
          data-focus
        >
          <span className={classes.k}>{kind === 'income' ? 'From' : 'For'}</span>
          <span
            ref={setForSlot}
            className={classes.v}
          />
          <ForwardIcon
            size={16}
            aria-hidden
            className={classes.caret}
          />
        </div>
      ) : (
        <Row
          k={kind === 'income' ? 'From' : 'For'}
          value={forLabel}
          dot={forDot}
          onClick={() => setPicking(picking === 'category' ? null : 'category')}
        />
      )}
    </>
  );

  const shownCurrency = elsewhere ? typedIn : currencySymbol(currency);
  const pill = (
    <CurrencyPill
      label={`${kind === 'income' ? '+ ' : ''}${shownCurrency}`}
      onOpen={() => setPicking('currency')}
      listOpen={picking === 'currency' || picking === 'today'}
    />
  );

  // Under the figure: what an amount in another currency comes to, or the day's currency
  const quoteDay = quote == null ? '' : rateDate(quote.fetchedAt, quote.day);
  // An earlier day's entry is saved at that day's rate, which may differ
  const savedAt = day === today ? '' : `, saved at the rate of ${shortDay(day)}`;
  const lines =
    elsewhere && total > 0 ? (
      <div className={classes.rateLines}>
        {conversionPending ? (
          <span className={classes.rateHint}>
            {`Conversion pending: converted at the rate of ${shortDay(day)} once online`}
          </span>
        ) : quote == null ? (
          !rate.isPending && (
            <span className={classes.rateHint}>
              {`No rate for ${typedIn} yet. Connect to fetch one.`}
            </span>
          )
        ) : (
          <button
            type="button"
            className={classes.rateHint}
            aria-expanded={showRate}
            onClick={() => setShowRate((shown) => !shown)}
          >
            {`about ${formatMoney(estimate!, currency)} at ${
              quote.fromDevice ? 'the last rate known' : "today's rate"
            }${savedAt}`}
          </button>
        )}
        {showRate && quote != null && (
          <span className={classes.rateDetail}>
            {`1 ${typedIn} = ${Number(quote.rate.toPrecision(6))} ${currency}, from ${
              SOURCE_NAMES[quote.source]
            }${quote.fromDevice ? ` on ${quoteDay}` : ''}`}
          </span>
        )}
      </div>
    ) : travel != null && typedIn === travel && keypad.expr === '' ? (
      <div className={classes.rateLines}>
        <button
          type="button"
          className={classes.rateHint}
          onClick={() => setPicking('today')}
        >
          {`In ${travel} today. Tap to change.`}
        </button>
      </div>
    ) : null;

  const status = (
    <div
      role="status"
      aria-live="polite"
      aria-label={`Amount, ${shownCurrency} ${centsShown(total)}${
        tooMuch ? `. ${tooMuchText}` : ''
      }`}
      className={desktop ? classes.deskStatus : classes.amount}
    >
      <span className={classes.expression}>{expressionLine(keypad.expr)}</span>
      <span className={classes.figure}>
        {/* A computer's pill sits beside the field, outside its label; the figure still says
            its currency */}
        {desktop ? (
          <span className="sr-only">{`${kind === 'income' ? '+ ' : ''}${shownCurrency}`}</span>
        ) : (
          pill
        )}
        <span
          data-amount
          className={classes.number}
          data-tone={
            total < 0 ? 'neg' : kind === 'income' ? 'pos' : keypad.expr === '' ? 'empty' : 'ink'
          }
        >
          {amountShown(keypad)}
        </span>
      </span>
      {/* A refused key is said as well as shown on Save: the live region speaks its content */}
      {tooMuch && <span className="sr-only">{tooMuchText}</span>}
    </div>
  );

  const chips =
    !transfer && !(desktop && picking === 'category') ? (
      <div
        role="radiogroup"
        aria-label="Recent categories"
        className={classes.recent}
      >
        {recent.map((c) => {
          const on = newCategory == null && c.id === category?.id;
          return (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={on}
              title={c.fullName}
              className={`${classes.chip} ${on ? classes.chipOn : ''}`}
              onClick={() => pickCategory(c.id)}
            >
              <span
                className={classes.dot}
                style={{ background: categoryColour(categories ?? [], c.id) }}
              />
              {c.name}
            </button>
          );
        })}
      </div>
    ) : null;

  const options = (
    <>
      <div className={classes.options}>
        <button
          type="button"
          className={classes.opt}
          aria-expanded={showDate}
          onClick={() => setShowDate((shown) => !shown)}
        >
          <CalendarIcon
            size={16}
            aria-hidden
          />
          {dayOk ? dayHeading(day) : 'Day'}
          {askForTime && dayOk && `, ${clockText(time)}`}
        </button>
        <button
          type="button"
          className={classes.opt}
          aria-expanded={showRepeat}
          onClick={() => setShowRepeat((shown) => !shown)}
        >
          <RepeatIcon
            size={16}
            aria-hidden
          />
          {REPEATS.find((r) => r.value === repeat && r.value !== '')?.label ?? 'Repeat'}
        </button>
      </div>
      {showDate && (
        <label className={classes.dateRow}>
          <span>Date</span>
          <input
            type="date"
            className={classes.input}
            aria-label="Date"
            value={day}
            min="2000-01-01"
            max={today}
            onChange={(e) => {
              const value = e.currentTarget.value;
              setDate(value === today ? null : value);
            }}
          />
        </label>
      )}
      {showDate && askForTime && (
        <label className={classes.dateRow}>
          <span>Time</span>
          <input
            type="time"
            className={classes.input}
            aria-label="Time"
            value={timeTyped}
            onChange={(e) => {
              // Cleared part way while typing: the time stays as it was until it's whole
              const typed = e.currentTarget.value;
              setTimeTyped(typed);
              if (/^\d{2}:\d{2}$/.test(typed)) setTime(typed);
            }}
          />
        </label>
      )}
      {showRepeat && (
        <div
          role="radiogroup"
          aria-label="Repeat"
          className={classes.repeat}
        >
          {REPEATS.map((r) => (
            <button
              key={r.value}
              type="button"
              role="radio"
              aria-checked={r.value === repeat}
              className={`${classes.chip} ${r.value === repeat ? classes.chipOn : ''}`}
              onClick={() => {
                setRepeat(r.value);
                setShowRepeat(false);
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}
    </>
  );

  const save = (
    <button
      type="submit"
      className={desktop ? classes.saveSmall : classes.save}
      aria-disabled={!savable}
    >
      {label}
      {desktop && <Key>Enter</Key>}
    </button>
  );

  const way = (
    <div
      role="radiogroup"
      aria-label="Which way"
      id={ids.way}
      className={classes.seg}
    >
      {KINDS.map((k) => (
        <button
          key={k.value}
          type="button"
          role="radio"
          aria-checked={k.value === kind}
          className={k.value === kind ? classes.segOn : undefined}
          onClick={() => pickKind(k.value)}
        >
          {k.label}
        </button>
      ))}
    </div>
  );

  const note = (
    <label className={classes.row}>
      <span className={classes.k}>Note</span>
      <input
        className={classes.note}
        aria-label="Payee or note"
        placeholder="Payee or note, optional"
        value={payee}
        maxLength={MAX_PAYEE}
        autoComplete="off"
        list={suggestions == null ? undefined : suggestionsId}
        onChange={(e) => setPayee(e.currentTarget.value)}
        onKeyDown={(e) => {
          // Enter in the note saves, as in any form, but only what can be saved
          if (e.key === 'Enter' && !savable) e.preventDefault();
        }}
      />
      {suggestions != null && (
        <datalist id={suggestionsId}>
          {suggestions.map((name) => (
            <option
              key={name}
              value={name}
            />
          ))}
        </datalist>
      )}
    </label>
  );

  // Drawn outside the entry's form, so its own Save sends nothing of the entry's
  const accountForm = (
    <AccountForm
      open={addingAccount ? { account: null } : null}
      count={accounts?.length ?? 0}
      onClose={() => setAddingAccount(false)}
      onAdded={setToAccountId}
    />
  );

  if (desktop) {
    return (
      <>
        <form
          aria-label="Add a transaction"
          className={classes.deskForm}
          onSubmit={submit}
          onKeyDown={onKeyDown}
          noValidate
        >
          <div className={classes.dialogHeader}>
            <Modal.Title className={classes.dialogTitle}>New entry</Modal.Title>
            <CloseButton
              onClose={onDone}
              keeps={typedSomething}
            />
          </div>
          {draftLine}
          <div className={classes.deskTop}>
            {way}
            {/* The figure is the field: what's typed is worked out as it's shown */}
            <div className={classes.deskFigure}>
              {pill}
              <label className={classes.deskAmount}>
                <input
                  className={classes.amountField}
                  aria-label="Amount"
                  aria-describedby={ids.hint}
                  inputMode="decimal"
                  autoComplete="off"
                  value={keypad.expr}
                  data-autofocus={picking == null ? true : undefined}
                  onFocus={(e) => {
                    const end = e.currentTarget.value.length;
                    e.currentTarget.setSelectionRange(end, end);
                  }}
                  onChange={(e) =>
                    setKeypad(typeKeys(e.currentTarget.value, undefined, typedLimit))
                  }
                />
                {status}
              </label>
            </div>
          </div>
          {lines}
          {(picking === 'currency' || picking === 'today') && pickerShown}
          <div className={classes.fields}>
            {rows}
            {note}
          </div>
          {picking === 'category' && pickerShown}
          {chips}
          {options}
          <div className={classes.deskFoot}>
            <span
              id={ids.hint}
              className={classes.hint}
            >
              Sums work: 8+4.5
            </span>
            <button
              type="button"
              className={classes.cancel}
              onClick={onDone}
            >
              {typedSomething ? 'Keep draft' : 'Cancel'}
              <Key>Esc</Key>
            </button>
            {save}
          </div>
        </form>
        {accountForm}
      </>
    );
  }

  return (
    <div
      className={classes.phone}
      onKeyDown={onKeyDown}
    >
      <form
        aria-label="Add a transaction"
        className={classes.phoneForm}
        onSubmit={submit}
        // Under a list's sheet, it's out of reach until the sheet closes
        ref={phoneForm}
        aria-hidden={picking != null || undefined}
        noValidate
      >
        <div className={classes.top}>
          <CloseButton
            onClose={onDone}
            keeps={typedSomething}
          />
          {way}
          <span className={classes.headerSpace} />
        </div>
        {draftLine}
        {status}
        {lines}
        <div className={classes.fields}>
          {rows}
          {note}
        </div>
        {chips}
        {options}
        <div className={classes.bottom}>
          <KeypadKeys onPress={(key) => setKeypad((state) => press(state, key, typedLimit))} />
          {save}
        </div>
      </form>
      {pickerShown != null && (
        <>
          <div
            className={classes.scrim}
            aria-hidden
            onClick={() => setPicking(null)}
          />
          {pickerShown}
        </>
      )}
      {accountForm}
    </div>
  );
}

/** The figure's currency, with an arrow: a tap (or Alt+Down) opens every currency to pick from */
function CurrencyPill({
  label,
  onOpen,
  listOpen,
}: {
  label: string;
  onOpen: () => void;
  /** Every currency is open, from this pill or elsewhere */
  listOpen: boolean;
}) {
  return (
    <button
      type="button"
      className={classes.pill}
      // Named by what it shows first, so a voice saying it finds it
      aria-label={`${label}, currency`}
      aria-haspopup="listbox"
      aria-expanded={listOpen}
      aria-keyshortcuts="Alt+ArrowDown"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.altKey && e.key === 'ArrowDown') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      {label}
      <DownIcon
        size={14}
        aria-hidden
        className={classes.pillArrow}
      />
    </button>
  );
}

/** One of From, For, Into or To: what it is now, tapped to change it */
function Row({
  k,
  value,
  hint = '',
  dot,
  onClick,
}: {
  k: string;
  value: string;
  hint?: string;
  dot?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={classes.row}
      aria-label={`${k} ${value}${hint === '' ? '' : ` ${hint}`}`}
      onClick={onClick}
    >
      <span className={classes.k}>{k}</span>
      <span className={classes.v}>
        {dot != null && (
          <span
            className={classes.dot}
            style={{ background: dot }}
          />
        )}
        <span className={classes.vText}>{value}</span>
      </span>
      {hint !== '' && <span className={classes.h}>{hint}</span>}
      <ForwardIcon
        size={16}
        aria-hidden
        className={classes.caret}
      />
    </button>
  );
}

/** A list to pick from: a sheet over the entry on phones, open under its row on computers */
function Picker({
  page,
  title,
  onBack,
  children,
}: {
  page: boolean;
  title: string;
  onBack: () => void;
  children: ReactNode;
}) {
  const heading = useId();
  if (!page) return <div className={classes.pickInline}>{children}</div>;
  return (
    <div
      className={classes.pickSheet}
      role="dialog"
      aria-labelledby={heading}
    >
      <div className={classes.pickHeader}>
        <BackButton onClick={onBack}>Entry</BackButton>
        <h2 id={heading}>{title}</h2>
        <span className={classes.headerSpace} />
      </div>
      {children}
    </div>
  );
}

/** The keypad: 1-2-3 on top as drawn (D9); Delete held clears */
function KeypadKeys({ onPress }: { onPress: (key: KeypadKey) => void }) {
  const holding = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const stop = () => {
    if (holding.current != null) clearTimeout(holding.current);
    holding.current = null;
  };
  useEffect(() => stop, []);
  return (
    <div
      role="group"
      aria-label="Keypad"
      className={classes.keypad}
    >
      {KEYS.map((k) => (
        <button
          key={k.key}
          type="button"
          aria-label={k.name}
          className={k.look == null ? classes.key : `${classes.key} ${classes[k.look]}`}
          onPointerDown={
            k.key === 'delete'
              ? () => {
                  held.current = false;
                  stop();
                  holding.current = setTimeout(() => {
                    held.current = true;
                    onPress('clear');
                  }, HOLD_MS);
                }
              : undefined
          }
          onPointerUp={k.key === 'delete' ? stop : undefined}
          onPointerLeave={k.key === 'delete' ? stop : undefined}
          onClick={() => {
            if (k.key === 'delete' && held.current) {
              held.current = false;
              return;
            }
            onPress(k.key);
          }}
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The payees used before, to suggest as the payee is typed (Suggest as you type): read for
 * the account Add is on, whose own come first; null while suggestions are off. Offline or
 * failing, there are none.
 */
function useSuggestions(accountId: string | null): string[] | null {
  const [payees, setPayees] = useState<string[]>([]);
  useEffect(() => {
    if (accountId == null) return;
    let current = true;
    api
      .getPayeeCategories(accountId)
      .then((answer) => current && setPayees(suggestedPayees(answer.payees)))
      .catch(() => current && setPayees([]));
    return () => {
      current = false;
    };
  }, [accountId]);
  return accountId == null ? null : payees;
}
