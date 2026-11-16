import { DownloadSimple, UploadSimple } from '@phosphor-icons/react';
import { useState } from 'react';
import { goUp } from '../../hooks/useRoute';
import { useShortcuts } from '../../hooks/useShortcuts';
import ExportDialog from '../home/ExportDialog';
import classes from './Settings.module.css';
import { BackButton, SectionLink } from './SettingsPage';

/** Back, or Esc, goes up to Settings */
const toSettings = () => goUp('?settings');

// Import and export (?settings=data), for now the two ways Home had: Export, which
// downloads everything as a CSV file, and Import, which opens the import page.
export default function DataPage() {
  const [exporting, setExporting] = useState(false);
  useShortcuts({ Escape: toSettings });

  return (
    <div className={classes.page}>
      <header className={classes.header}>
        <BackButton onClick={toSettings}>Settings</BackButton>
      </header>
      <h1 className={classes.title}>Import and export</h1>
      <section
        className={classes.card}
        aria-label="Import and export"
      >
        <button
          type="button"
          className={classes.row}
          onClick={() => setExporting(true)}
        >
          <span
            className={classes.icon}
            aria-hidden
          >
            <DownloadSimple size={18} />
          </span>
          <span className={classes.label}>Export</span>
        </button>
        <SectionLink
          address="?import"
          icon={<UploadSimple size={18} />}
        >
          Import
        </SectionLink>
      </section>
      <ExportDialog
        opened={exporting}
        onClose={() => setExporting(false)}
      />
    </div>
  );
}
