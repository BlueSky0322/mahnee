// Plan's addresses: Budgets at ?plan (an earlier month ?plan&month=2026-10), a category
// over 12 months at ?plan&category=<id> (after the month when there is one; `expenses` or
// `income` for all of them), and Scheduled at ?plan=scheduled.

export function planAddress({
  month = null,
  category = null,
  scheduled = false,
}: {
  month?: string | null;
  category?: string | null;
  scheduled?: boolean;
}) {
  if (scheduled) return '?plan=scheduled';
  let address = '?plan';
  if (month != null) address += `&month=${month}`;
  if (category != null) address += `&category=${encodeURIComponent(category)}`;
  return address;
}

/** Activity's address for a category's entries in a month: this month needs no days */
export function activityAddress(
  categoryId: string,
  firstDay: string,
  lastDay: string,
  isCurrent: boolean,
) {
  const base = `?activity&category=${encodeURIComponent(categoryId)}`;
  return isCurrent ? base : `${base}&from=${firstDay}&to=${lastDay}`;
}
