// Wording that depends on a number, and web addresses as people read them

/** "1 account", "3 accounts"; `many` for words that don't just take an s ("people") */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Longer addresses are cut, so a link reads as where it goes rather than all of it */
const SHORT_LINK_LENGTH = 32;

/** A web address as a person reads it: "example.com/menu", without https:// or www. */
export function shortLink(href: string) {
  const bare = href
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/$/, '');
  return bare.length <= SHORT_LINK_LENGTH ? bare : `${bare.slice(0, SHORT_LINK_LENGTH - 1)}…`;
}
