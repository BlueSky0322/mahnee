// Finding a field or button by its name (getByRole, getByLabelText) asks each element on
// the page for its labels. jsdom answers that by walking the whole page for every element,
// and for each label with a `for` it walks the page again to find what it names, so a
// screen with a few hundred rows took seconds per query (Activity's register, a month of
// history offline). Here the page's labels are worked out once, in one pass, and kept until
// the page changes: the same answer jsdom gives, in tree order, for a page of any size.

const LABELABLE = [
  HTMLButtonElement,
  HTMLInputElement,
  HTMLMeterElement,
  HTMLOutputElement,
  HTMLProgressElement,
  HTMLSelectElement,
  HTMLTextAreaElement,
];

/** What a label can name, as jsdom's isLabelable reads it (every input but a hidden one) */
const LABELABLE_SELECTOR =
  'button, input:not([type="hidden" i]), meter, output, progress, select, textarea';

const isLabelable = (element: Element) =>
  LABELABLE.some((kind) => element instanceof kind) &&
  !(element instanceof HTMLInputElement && element.type === 'hidden');

/** The element a label names, as HTMLLabelElement.control finds it on the page */
function controlOf(label: HTMLLabelElement): Element | null {
  const target = label.getAttribute('for');
  if (target == null) return label.querySelector(LABELABLE_SELECTOR);
  if (target === '') return null;
  const named = document.getElementById(target);
  return named != null && isLabelable(named) ? named : null;
}

let byControl: Map<Element, HTMLLabelElement[]> | null = null;

// Any element added, removed or moved, or a `for`, `id` or `type` changed, means working
// the labels out again. takeRecords() reads that at once, before each answer, so a change
// made just before a query is never missed.
const changes = new MutationObserver(() => {
  byControl = null;
});
changes.observe(document, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ['for', 'id', 'type'],
});

function labelsOnPage() {
  if (changes.takeRecords().length > 0) byControl = null;
  if (byControl == null) {
    byControl = new Map();
    for (const label of document.getElementsByTagName('label')) {
      const control = controlOf(label);
      if (control == null) continue;
      const list = byControl.get(control);
      if (list == null) byControl.set(control, [label]);
      else list.push(label);
    }
  }
  return byControl;
}

for (const kind of LABELABLE) {
  const jsdoms = Object.getOwnPropertyDescriptor(kind.prototype, 'labels');
  if (jsdoms?.get == null) continue;
  Object.defineProperty(kind.prototype, 'labels', {
    ...jsdoms,
    get(this: Element) {
      if (!isLabelable(this)) return null;
      // Not on the page (a fragment, a node not yet added): asked of jsdom, as before
      if (this.getRootNode() !== document) return jsdoms.get?.call(this) as unknown;
      return labelsOnPage().get(this) ?? [];
    },
  });
}
