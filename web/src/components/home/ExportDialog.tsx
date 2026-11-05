import { Button } from '@mantine/core';
import { useNetwork } from '@mantine/hooks';
import { DownloadSimple } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { ExportSummary } from '@shared/api';
import { exportFileName } from '@shared/export';
import { api } from '../../api';
import { useIsDesktop } from '../../hooks/useBreakpoints';
import { useUnsaved } from '../../ledger/useLedger';
import { isOfflineFailure } from '../../offline/network';
import { dayText, toDateInput } from '../../utils/date-input';
import { deliverFile } from '../../utils/deliver-file';
import ResponsiveDialog from '../ui/ResponsiveDialog';
import Skeleton, { Loading } from '../ui/Skeleton';

/** "1 thing", "3 things", with thousands marked */
const count = (n: number, one: string, many: string) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** "1,284 transactions from 3 Jan 2026 to 5 Nov 2026, 6 accounts, 23 categories" */
function summaryText(s: ExportSummary) {
  const accounts = `${count(s.accounts, 'account', 'accounts')}, ${count(s.categories, 'category', 'categories')}`;
  if (s.transactions === 0 || s.firstDate == null || s.lastDate == null) {
    return `No transactions yet, ${accounts}`;
  }
  const days =
    s.firstDate === s.lastDate
      ? `on ${dayText(s.firstDate)}`
      : `from ${dayText(s.firstDate)} to ${dayText(s.lastDate)}`;
  return `${count(s.transactions, 'transaction', 'transactions')} ${days}, ${accounts}`;
}

// Taking everything out: says what the file holds (counted by the server, so it's the
// whole history, not what this device has seen), then downloads every transaction as a
// CSV file. The file comes from the server, so it needs a connection, and changes still
// waiting on this device aren't in it yet.
const ExportDialog = ({ opened, onClose }: { opened: boolean; onClose: () => void }) => {
  const { online } = useNetwork();
  const { waiting } = useUnsaved();
  const isDesktop = useIsDesktop();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Counted afresh each time it opens, and again as waiting changes are saved
  const { data, isError } = useQuery({
    queryKey: ['export-summary', waiting],
    queryFn: api.getExportSummary,
    enabled: opened,
    staleTime: 0,
    gcTime: 0,
  });

  const close = () => {
    setError(null);
    onClose();
  };

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const file = await api.getExport();
      const delivery = await deliverFile(file, exportFileName(toDateInput(new Date())), {
        title: 'Mahnee export',
        share: !isDesktop,
      });
      if (delivery !== 'cancelled') close();
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

  let held = null;
  if (data != null) held = <p className="m-0 text-sm font-medium">{summaryText(data)}</p>;
  else if (isError) {
    held = <p className="sf-muted m-0 text-sm">Couldn't count what's in it.</p>;
  } else if (online) {
    held = (
      <Loading label="Counting what's in it">
        <Skeleton
          width="85%"
          height={14}
        />
      </Loading>
    );
  }

  return (
    <ResponsiveDialog
      opened={opened}
      onClose={close}
      title="Export"
      width={420}
    >
      <div className="flex flex-col gap-4">
        <p className="sf-muted m-0 text-sm">
          Every transaction you've logged, on every account, as a CSV file for Excel, Numbers or
          Google Sheets.
        </p>
        {held}
        {waiting > 0 && (
          <p
            className="m-0 text-sm"
            role="status"
          >
            {count(waiting, 'change', 'changes')} still being saved won't be in the file yet.
          </p>
        )}
        <Button
          leftSection={<DownloadSimple size={18} />}
          disabled={!online}
          loading={busy}
          onClick={() => void download()}
        >
          {online ? 'Download' : 'Connect to download'}
        </Button>
        {error && (
          <p
            className="sf-negative m-0 text-sm"
            role="alert"
          >
            {error}
          </p>
        )}
      </div>
    </ResponsiveDialog>
  );
};

export default ExportDialog;
