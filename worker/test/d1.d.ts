// What of Cloudflare D1's types the Worker code these tests run in Node uses
// (convert.test.ts runs currency/convert.ts against SQLite). The Worker itself compiles
// against @cloudflare/workers-types, which can't sit beside Node's.

interface D1Meta {
  changes: number;
}

interface D1Result<T = unknown> {
  results: T[];
  meta: D1Meta;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(column?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}
