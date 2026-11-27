export const READ_SCOPE = 'ledger:read';
export const WRITE_SCOPE = 'ledger:write';
export const SCOPES = [READ_SCOPE, WRITE_SCOPE];

export const toolScopes = new Map<string, string>([
  ['list_accounts', READ_SCOPE],
  ['list_categories', READ_SCOPE],
  ['search_transactions', READ_SCOPE],
  ['get_month_summary', READ_SCOPE],
  ['record_expense', WRITE_SCOPE],
]);
