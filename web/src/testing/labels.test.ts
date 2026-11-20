// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import './labels';

// The quicker labels give what jsdom's own label.control says, for every kind of label,
// and follow the page as it changes, even straight after a change.

afterEach(() => {
  document.body.innerHTML = '';
});

const field = (id: string) => document.getElementById(id) as HTMLInputElement;

/** Each field's labels as the page defines them: every label whose control it is */
const expected = (element: Element) =>
  [...document.querySelectorAll('label')].filter((label) => label.control === element);

const fields = () => [
  ...document.querySelectorAll('button, input, meter, output, progress, select, textarea'),
];

function expectSameAsJsdom() {
  for (const field of fields()) {
    const labels = (field as HTMLInputElement).labels;
    if (field instanceof HTMLInputElement && field.type === 'hidden') {
      expect(labels).toBeNull();
    } else {
      expect([...(labels ?? [])]).toEqual(expected(field));
    }
  }
}

test('labels by for, by wrapping, several, none, and ones naming what they cannot', () => {
  document.body.innerHTML = `
    <label for="a">A</label><input id="a">
    <label>B <input id="b"></label>
    <label for="c">C1</label><label for="c">C2</label><select id="c"></select>
    <label><span>D</span><button id="d"></button><input id="d2"></label>
    <label for="">Empty</label><textarea id="e"></textarea>
    <label for="f">Not labelable</label><div id="f"></div>
    <label for="g">Hidden</label><input id="g" type="hidden">
    <label><input type="HIDDEN"><meter id="h"></meter></label>
    <label for="i">For wins</label><label for="i"><input id="j"></label><progress id="i"></progress>
    <output id="k"></output>
  `;
  expectSameAsJsdom();
  expect([...field('c').labels!].map((l) => l.textContent)).toEqual(['C1', 'C2']);
  expect(field('j').labels).toHaveLength(0);
});

test('follows the page as it changes, straight after each change', () => {
  document.body.innerHTML = `<label id="l" for="x">X</label><input id="x"><input id="y">`;
  const [x, y] = ['x', 'y'].map((id) => document.getElementById(id) as HTMLInputElement);
  expect(x.labels).toHaveLength(1);

  document.getElementById('l')!.setAttribute('for', 'y');
  expect(x.labels).toHaveLength(0);
  expect(y.labels).toHaveLength(1);

  y.id = 'z';
  expect(y.labels).toHaveLength(0);

  const wrapping = document.createElement('label');
  document.body.append(wrapping);
  wrapping.append(x);
  expect([...x.labels!]).toEqual([wrapping]);

  x.type = 'hidden';
  expect(x.labels).toBeNull();
  wrapping.remove();
  expectSameAsJsdom();
});

test('a field not on the page is answered as jsdom answers it', () => {
  const label = document.createElement('label');
  const input = document.createElement('input');
  label.append(input);
  expect([...input.labels!]).toEqual([label]);
});
