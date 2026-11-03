import { Plus } from '@phosphor-icons/react';
import classes from './Fab.module.css';

// The phone's main action, floating at the bottom right
const Fab = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <button
    type="button"
    className={classes.fab}
    onClick={onClick}
  >
    <Plus size={20} />
    {label}
  </button>
);

export default Fab;
