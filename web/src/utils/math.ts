// Amounts can be typed as sums, like "30*3" or "(12.5 + 8) / 2": numbers, + - * /
// (or × ÷) and brackets. Anything else isn't an amount.

/** The value of a sum as typed, or null when it isn't one (or doesn't come to a number) */
export function evaluateSum(text: string): number | null {
  const tokens = text
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .match(/\d*\.?\d+|[-+*/()]|\S/g);
  if (tokens == null) return null;
  let at = 0;
  const peek = () => tokens[at];

  // sum := product (('+' | '-') product)*
  const sum = (): number => {
    let value = product();
    while (peek() === '+' || peek() === '-') {
      value = tokens[at++] === '+' ? value + product() : value - product();
    }
    return value;
  };
  // product := factor (('*' | '/') factor)*
  const product = (): number => {
    let value = factor();
    while (peek() === '*' || peek() === '/') {
      value = tokens[at++] === '*' ? value * factor() : value / factor();
    }
    return value;
  };
  // factor := ('+' | '-') factor | '(' sum ')' | number
  const factor = (): number => {
    const token = tokens[at++];
    if (token === '-') return -factor();
    if (token === '+') return factor();
    if (token === '(') {
      const value = sum();
      if (tokens[at++] !== ')') throw new SyntaxError('Unclosed bracket');
      return value;
    }
    const value = Number(token);
    if (token === undefined || !/^\d*\.?\d+$/.test(token)) throw new SyntaxError(token);
    return value;
  };

  try {
    const value = sum();
    return at === tokens.length && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}
