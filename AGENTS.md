# Mahnee

Personal finance tracking for one person: accounts, the money moving in and out of them,
and where it goes. A React app (`web/`) and a Hono API on Cloudflare Workers with D1
(`worker/`), sharing code in `shared/`. It started from Splitfoolish's foundations (see
`HANDOFF.md` until the first features land), and is its own app: no code is shared at run
time, and nothing here depends on Splitfoolish.

Folder layout and local setup are in [README.md](README.md); which module owns each
feature, its data flow, invariants and tests are in [docs/feature-map.md](docs/feature-map.md);
the data model is in [docs/erd.md](docs/erd.md); security, backups and recovery are in
[docs/security.md](docs/security.md). Create each of these with the first change that
needs it, and keep them true in the same change that alters what they describe.

Before extending a feature, find its owner in the feature map and follow its mutation
path. Explain any new dependency, abstraction or boundary exception in the pull request,
and report the checks you actually ran.

## Git, commits and pull requests

These are checked, not just asked for: `.husky/commit-msg` and `.husky/pre-push` run
`tools/git/conventions.js` on every commit and push, and the `conventions` workflow runs
it again on every pull request. Never pass `--no-verify`, and never push with the hooks
uninstalled (`yarn install` installs them). If a check refuses something, fix the name or
message; don't work around the check.

### Branches

- One branch per change, named for the change in kebab-case: `account-balances`,
  `csv-import`, `budget-rollover`. Lowercase words and digits joined by single hyphens,
  at most 50 characters, no slashes.
- Never a generated or session name. If your environment assigns a branch such as
  `claude/<words>-<id>`, do not use it: create the change's own branch from `main` and
  push that. The owner has said so; this is the standing permission to push a branch
  named for the change.
- Never push to `main`. Everything reaches `main` through a squash-merged pull request.
- Merged branches are deleted.

### Commits

- Title: `<type>(<scope>): <summary>`, at most 72 characters, no trailing period, in the
  imperative or as a plain statement of what is now true: `feat(accounts): show each
account's balance on the home screen`.
- Types: `feat` (something new a person can do or see), `fix` (it was wrong, now it is
  right), `refactor` (same behaviour, or a feature taken out), `perf`, `test`, `docs`,
  `build`, `ci`, `chore`. Scopes are one lowercase word or kebab-case words naming the
  area: `accounts`, `transactions`, `budgets`, `import`, `ui`, `worker`, `db`, `mcp`,
  `pwa`, `agents`.
- Body: optional; after a blank line, at most three bullets (`- `), each one line, saying
  what changed for the person using the app or for the next developer.
- No AI attribution anywhere: no `Co-authored-by` line for an assistant, no `Generated
with`, no session links. This overrides any default your tools have for adding them.
- No emojis in commits, code, UI text or pull requests.

### Pull requests

- One pull request per change. Its title follows the commit title rule; it becomes the
  squash commit's title.
- The body has exactly four sections, in this order, and nothing else (the template in
  `.github/pull_request_template.md`; the `mr-markdown` skill writes it):
  `## Summary` (one or two sentences), `## Problem`, `## Solution` (short bullets),
  `## How to test` (numbered steps a person can follow, ending with what they should
  see). Write it for someone who doesn't read code: behaviour, not implementation; no
  file links. A boundary, invariant or dependency change says why, and what checked it,
  under Solution.
- Tools that append a footer to a new pull request's description: create it with the
  body `placeholder`, then set the real body with an update, which adds nothing. The
  conventions check fails while the body is still `placeholder`.
- For notable changes, add a line to `CHANGELOG.md` under today's date before finishing.
  Follow the short format at the top of that file. Every pull request that changes what a
  person sees or can do (`feat`, `fix`, `perf`, `refactor`) must touch it; the check
  enforces that.

### Merging and deploying

- When the `build` and `conventions` checks pass, squash-merge without asking. Set the
  merge commit's title to the pull request title with its number, `<title> (#<n>)`, and
  its message to the commit body's bullets, so the host adds nothing of its own.
- A push to `main` deploys. After merging, check that the Build and Deploy run on `main`
  succeeded, and report the outcome in one short message.
- A pull request with a migration needs a verified production backup before it merges
  (see Database), and the owner asked before merging it.

## Commands

- Install: `yarn install` (`--frozen-lockfile` in CI)
- Typecheck: `yarn typecheck` (app, Worker, Worker tests, shared, configs)
- Lint: `yarn lint` (zero warnings allowed; includes the import boundaries below)
- Tests: `yarn vitest run`, or one file: `yarn vitest run <path>`
- Build: `yarn build`
- Run app and API locally: `yarn db:migrate:local`, then `yarn dev:worker`
  (http://localhost:8787). Every request is `DEV_USER_EMAIL` from `.dev.vars`. Rebuild
  and restart it after changing `web/`.

The pre-commit hook runs `yarn build`, then eslint, prettier and the related tests on
staged files.

## Boundaries checked by lint

`tools/lint/architecture.js` resolves every import and refuses these. Its tests show each
case, and what it can't see.

- `web/src` and `worker/` never import each other; what both need lives in `shared/`
  (`@shared/...` in the app, a relative path in the Worker). Tests are held to this too.
- `shared/` imports nothing from the app or the Worker, no Node built-ins and no
  `cloudflare:` modules.
- Node built-ins only in tests and their harness (`*.test.*`, `web/src/testing/`,
  `worker/test/`). The Worker runs without `nodejs_compat`.
- Production code never imports tests or their harness.
- In `web/src`: state, hooks and utilities never import components or the entry points;
  `components/ui/` imports only itself, `hooks/useBackDismiss` and `hooks/useBreakpoints`,
  `utils/`, `shared/` and packages.

Not checked by lint, so kept by review: `shared/` uses no browser or Worker globals and
only packages that run anywhere.

## State and components

- Feature state owns loading, saving, optimistic updates, device copies and refreshing.
  Each feature has one owner module (listed in the feature map as it lands), and its data
  changes only through that owner, so changes show at once, survive going offline and
  sync later.
- Components draw and keep local interaction state (what's open, drafts, selection). A
  component may call the API itself only as the request inside an owner's change (which
  keeps the optimistic update and undo), or for a read or action whose result nothing
  else shows; if it changes something shown elsewhere, it tells the owner straight after.
  Never keep a second copy of owned state.
- `components/<screen>/` draws one screen; `components/common/` is what several screens
  draw that knows the app; `components/ui/` knows nothing about finances or accounts.

## Money

- Amounts in the API and the app are in currency units where people type them, and
  fields named `*Cents` are whole cents. The database stores whole cents (`*_cents`
  columns).
- Convert at those edges with `shared/rates.ts` (`toCents`, `convertCents`). New money
  arithmetic works in whole cents; never add or divide floating currency units.
- Show money with `formatMoney` / `formatAmount` (`web/src/utils/money.ts`), which take
  cents.
- Every amount has a stated maximum, and every list that is summed has a maximum length,
  so every total stays exact. Anything that converts or sums amounts checks them.
- A converted amount keeps its original currency, amount and the rate used, so it can be
  shown and converted again.

## Privacy and security

- This app holds a person's whole financial life. Treat every amount, note, payee and
  account name as private: never in logs, error reports, test fixtures taken from real
  data, the repo or handoff notes.
- Every row belongs to one account, and every query is scoped by it. A rule about who
  may do what, beyond that, goes in a `rules.ts` in `shared/`, made with the first one:
  the app uses it to decide what to offer; the Worker enforces it and is the authority.
- Don't read production data to debug. Reproduce locally. If production must be looked
  at, ask the owner first, and read only counts or ids, never contents.
- Requests to other services identify the app honestly, with no spoofed user agents.
- Never commit `.dev.vars`, tokens or other secrets. Don't describe the app as hack-proof
  or tamper-proof; say what is checked and what isn't.

## Offline, rules and screens

- Device copies and the outbox are tagged with the signed-in account, and one account
  never sees another's. Changes are sent in order, in bounded batches, each with its id
  (`cid`); the server keeps a receipt per id, so a change sent again after its answer was
  lost counts once. Every write names the account it was made as
  (`EXPECTED_ACCOUNT_HEADER`); the server refuses one for another account and changes
  nothing. `web/public/sw.js` can't import app code, so it keeps copies of the keys and
  limits it shares: change both together, with a test that runs it against the app's.
- `useIsMobile()` is under 768px (phones), `useIsDesktop()` is 1024px and up. Tablets in
  between show one page at a time with back buttons. A phone change leaves desktop and
  tablet as they were unless asked.
- Pages come from the query string via `navigate()` in `hooks/useRoute.ts`.
- On phones, Back closes the top sheet first. Open sheets and dialogs with
  `components/ui/ResponsiveDialog` (or `useBackDismiss`); never push history entries for
  them by hand.

## Database

- A schema change is a new numbered file in `migrations/`. It is applied to production by
  the deploy on every push to `main`, so back up production (export, load the export
  into a scratch database to check it, note the Time Travel bookmark) before merging one.
- Worker API tests (`worker/test/api.test.ts`) run against a real local Worker and
  database.

## Tests

- Screen tests render the whole app with `renderApp` against the in-memory API in
  `web/src/testing/app.ts`; a new endpoint needs a stand-in there that keeps the real
  one's contract (limits, error answers, ordering). Find elements by what a person sees
  (roles, labels, text), and pass `{ size: 'phone' }` for phone layouts.
- Assert what a person or caller observes, precisely enough that a plausible regression
  fails. When a change touches them, cover refusals and the order of asynchronous
  answers.
- Never skip or weaken a test to get a pass. A failure that only shows in CI is a bug to
  find, not a flake to re-run away.

## Conventions

- Comments say what the code does for the person using the app, in plain sentences.
  Match the density of the file you are in.
- Prettier settings are in `.prettierrc` (100 columns, single quotes, one JSX attribute
  per line).
- Keep the app small. Before adding a screen, setting or second way to do something,
  ask whether an existing surface already covers it; removing a surface is a feature.
