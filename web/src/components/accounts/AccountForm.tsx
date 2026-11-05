import { Button, Input, SegmentedControl, TextInput } from '@mantine/core';
import { Archive, ArrowCounterClockwise } from '@phosphor-icons/react';
import type { FormEvent } from 'react';
import { useState } from 'react';
import type { Account, LedgerChange } from '@shared/api';
import type { AccountKind } from '@shared/ledger';
import {
  ACCOUNT_KINDS,
  DEFAULT_CURRENCY,
  MAX_ACCOUNTS,
  MAX_ACCOUNT_NAME,
  readAccountName,
} from '@shared/ledger';
import { change } from '../../ledger/ledger';
import { newId } from '../../utils/id';
import { currencySymbol } from '../../utils/money';
import { showRefusal } from '../../utils/notify';
import { showUndo } from '../common/undo-toast';
import ResponsiveDialog from '../ui/ResponsiveDialog';
import KindIcon from './KindIcon';
import { KIND_LABELS, openingText, readOpening } from './account-text';
import classes from './Accounts.module.css';

interface AccountFormProps {
  /** What's open: a new account, or one to change */
  open: { account: Account | null } | null;
  /** How many accounts there are, archived ones included */
  count: number;
  onClose: () => void;
}

/** Adding an account, or renaming one, changing its opening balance and archiving it */
export default function AccountForm({ open, count, onClose }: AccountFormProps) {
  return (
    <ResponsiveDialog
      opened={open != null}
      onClose={onClose}
      title={open?.account == null ? 'Add account' : 'Edit account'}
      width={420}
    >
      {open != null && (
        <Fields
          // A fresh form for each account opened
          key={open.account?.id ?? 'new'}
          account={open.account}
          count={count}
          onDone={onClose}
        />
      )}
    </ResponsiveDialog>
  );
}

function Fields({
  account,
  count,
  onDone,
}: {
  account: Account | null;
  count: number;
  onDone: () => void;
}) {
  const [name, setName] = useState(account?.name ?? '');
  const [kind, setKind] = useState<AccountKind>(account?.kind ?? 'cash');
  const [amount, setAmount] = useState(account ? openingText(account.openingCents, kind) : '');
  const [nameError, setNameError] = useState<string | null>(null);
  const [amountError, setAmountError] = useState<string | null>(null);
  const symbol = currencySymbol(account?.currency ?? DEFAULT_CURRENCY);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const checkedName = readAccountName(name);
    const opening = readOpening(amount, kind);
    setNameError(checkedName == null ? 'Give it a name' : null);
    setAmountError('error' in opening ? opening.error : null);
    if (checkedName == null || 'error' in opening) return;

    if (account == null) {
      if (count >= MAX_ACCOUNTS) {
        showRefusal(`You can have up to ${MAX_ACCOUNTS} accounts, archived ones included`);
        return;
      }
      change({
        op: 'addAccount',
        account: { id: newId(), name: checkedName, kind, openingCents: opening.cents },
      });
    } else {
      // Only what changed is sent
      const update: Extract<LedgerChange, { op: 'updateAccount' }> = {
        op: 'updateAccount',
        id: account.id,
      };
      if (checkedName !== account.name) update.name = checkedName;
      if (opening.cents !== account.openingCents) update.openingCents = opening.cents;
      if (update.name != null || update.openingCents != null) change(update);
    }
    onDone();
  };

  const archive = (archived: boolean) => {
    if (account == null) return;
    change({ op: 'archiveAccount', id: account.id, archived });
    onDone();
    if (archived) {
      showUndo(`Archived ${account.name}`, () =>
        change({ op: 'archiveAccount', id: account.id, archived: false }),
      );
    }
  };

  return (
    <form
      className={classes.form}
      onSubmit={submit}
      noValidate
    >
      <TextInput
        label="Name"
        placeholder={kind === 'card' ? 'Visa' : kind === 'bank' ? 'Savings' : 'Wallet'}
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
        error={nameError}
        maxLength={MAX_ACCOUNT_NAME}
        data-autofocus={account == null || undefined}
        autoComplete="off"
      />
      {account == null && (
        <Input.Wrapper
          label="Kind"
          labelElement="div"
          id="account-kind"
        >
          <SegmentedControl
            aria-labelledby="account-kind-label"
            fullWidth
            value={kind}
            onChange={(value) => setKind(value as AccountKind)}
            data={ACCOUNT_KINDS.map((k) => ({
              value: k,
              label: (
                <span className={classes.kindOption}>
                  <KindIcon
                    kind={k}
                    size={16}
                  />
                  {KIND_LABELS[k]}
                </span>
              ),
            }))}
          />
        </Input.Wrapper>
      )}
      <TextInput
        label={kind === 'card' ? 'Amount owed' : 'Opening balance'}
        description={
          kind === 'card'
            ? "What's owed on the card now"
            : 'What it holds now; below zero if overdrawn'
        }
        placeholder="0.00"
        inputMode="decimal"
        leftSection={<span className={classes.symbol}>{symbol}</span>}
        value={amount}
        onChange={(e) => setAmount(e.currentTarget.value)}
        error={amountError}
        autoComplete="off"
      />
      <div className={classes.actions}>
        {account != null &&
          (account.archived ? (
            <Button
              variant="subtle"
              color="gray"
              leftSection={<ArrowCounterClockwise size={16} />}
              onClick={() => archive(false)}
            >
              Bring back
            </Button>
          ) : (
            <Button
              variant="subtle"
              color="gray"
              leftSection={<Archive size={16} />}
              onClick={() => archive(true)}
            >
              Archive
            </Button>
          ))}
        <Button
          type="submit"
          className={classes.save}
        >
          {account == null ? 'Add account' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
