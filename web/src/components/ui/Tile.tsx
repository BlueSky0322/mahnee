import type { CSSProperties, ReactNode } from 'react';
import classes from './Tile.module.css';

interface TileProps {
  /** A category's name: the tile shows its first letter, in capitals */
  name?: string;
  /** The category's colour (utils/category-colour.ts), for the letter and its tint */
  colour?: string;
  /** Without a name: an icon, such as a transfer's arrows or an account's kind */
  children?: ReactNode;
}

/** A category's first letter, whole even outside the basic plane, in capitals */
const firstLetter = (name: string) => ([...name.trim()][0] ?? '').toLocaleUpperCase();

/**
 * The square at the start of a row: a category's letter in its colour on a tint of it,
 * or an icon on the sunk colour. Hidden from screen readers; the row's words name it.
 */
const Tile = ({ name, colour, children }: TileProps) => (
  <span
    aria-hidden
    className={classes.tile}
    data-tone={name != null ? 'category' : 'plain'}
    style={colour != null ? ({ '--tile': colour } as CSSProperties) : undefined}
  >
    {name != null ? firstLetter(name) : children}
  </span>
);

export default Tile;
