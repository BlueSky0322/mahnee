import type { ReactNode } from 'react';
import classes from './ListRow.module.css';

interface ListRowProps {
  /** What sits at the start, usually a Tile */
  tile?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** At the end, in even-width figures */
  amount?: ReactNode;
  /** Opens something: the row is then a button */
  onClick?: () => void;
}

/**
 * A row in a list: a tile, a title and a grey subtitle (each cut short with an ellipsis),
 * and an amount at the end. Rows that follow one another are ruled apart.
 */
const ListRow = ({ tile, title, subtitle, amount, onClick }: ListRowProps) => {
  const content = (
    <>
      {tile}
      <span className={classes.main}>
        <span className={classes.title}>{title}</span>
        {subtitle != null && <span className={classes.subtitle}>{subtitle}</span>}
      </span>
      {amount != null && <span className={`${classes.amount} sf-tabular`}>{amount}</span>}
    </>
  );
  return onClick != null ? (
    <button
      type="button"
      className={classes.row}
      onClick={onClick}
    >
      {content}
    </button>
  ) : (
    <div className={classes.row}>{content}</div>
  );
};

export default ListRow;
