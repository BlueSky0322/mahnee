# Mahnee

Personal finance tracking for one person: accounts, the money moving in and out of them,
and where it goes. So far it signs you in, lists your accounts (cash, bank, cards
and e-wallets) with their balances, keeps your spending and income categories, and
logs what you spend and receive from a quick entry sheet, with each month's spending,
income and what's left at the top of Home. It installs as an app on
phones and computers, opens offline, and keeps changes made offline on the device until
they're saved.

## Layout

| Folder        | What it is                                                                   |
| ------------- | ---------------------------------------------------------------------------- |
| `web/`        | The browser app: React, Mantine and Tailwind, built with Vite into `dist/`   |
| `worker/`     | The API: a Hono app on Cloudflare Workers that also serves `dist/`           |
| `shared/`     | Code both use: money and exchange-rate arithmetic, and the API's data shapes |
| `migrations/` | D1 (SQLite) schema changes, applied in order on deploy                       |
| `docs/`       | Where each feature lives, the data model, and security and recovery          |
| `tools/`      | Repository checks: the import boundaries, document links and git conventions |

`web/` and `worker/` never import each other; anything both need lives in `shared/`,
which the app imports as `@shared/...`. `yarn lint` checks this
(`tools/lint/architecture.js`). Each has its own `tsconfig.json`, so the app gets
browser types, the Worker gets Worker types and `shared/` gets neither.

Inside `web/src`, what the app knows is kept apart from how it looks:

| Folder                 | What it holds                                                                 |
| ---------------------- | ----------------------------------------------------------------------------- |
| `profile/`, `offline/` | Shared state: the signed-in profile, and what's kept on the device            |
| `ledger/`              | Shared state: accounts, categories and transactions, and saving them in order |
| `components/<screen>/` | What a screen draws, reading from the folders above                           |
| `components/common/`   | What more than one screen draws that knows the app (theme switch, Undo)       |
| `components/shell/`    | What sits around every page: the offline and new-version notices              |
| `components/ui/`       | Plain building blocks that know nothing of finances or accounts (dialogs)     |
| `hooks/`, `utils/`     | What every feature leans on: screen sizes, the page address, money, dates     |
| `pwa/`                 | Installing the app, its launch screen, and the on-screen keyboard             |
| `testing/`             | Rendering the whole app in tests, against an in-memory stand-in for the API   |

The Worker is laid out by feature:

| Folder                                     | What it holds                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| `index.ts`, `app.ts`, `http.ts`, `routes/` | The entry point, what every route shares, reading requests, and the routes |
| `accounts/`                                | Signing in, the profile and settings                                       |
| `currency/`                                | Exchange rates                                                             |
| `ledger/`                                  | Accounts, balances and categories, and saving changes all or nothing       |
| `test/`                                    | The API tests, run against a real local Worker and database                |

## Running it

Needs Node 22.12 or later (Vite 8 and Vitest 5); CI uses Node 22.

```sh
yarn install
cp .dev.vars.example .dev.vars
yarn db:migrate:local
yarn dev:worker      # builds the app, then serves app and API on http://localhost:8787
```

There is no Cloudflare Access locally, so every request is the `DEV_USER_EMAIL` in
`.dev.vars` (or whoever the `X-Dev-User` header names). Rebuild and restart after
changing `web/`.

`yarn dev` runs the app alone with hot reload, without the API.

## Checks

```sh
yarn typecheck   # app, Worker, Worker tests, shared code and configs
yarn lint        # includes the import boundaries between app, Worker and shared code
yarn vitest run  # unit and screen tests, plus API tests against a local Worker
```

`yarn install` also installs the git hooks, which check branch names and commit messages
and build the app before each commit (see `AGENTS.md`).

## Deploying

Every push to `main` builds, checks and tests, notes the database's restore point,
applies new migrations to the production database, then deploys the Worker
(`.github/workflows/deploy.yml`). Back up before merging a migration, and restore, as in
[docs/security.md](docs/security.md).

Before the first deploy, Cloudflare needs setting up once, outside this repo:

1. A D1 database named `mahnee-db`, whose id goes in `database_id` in `wrangler.jsonc`.
2. A Cloudflare Access application in front of the Worker; its team domain and audience
   tag go in `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `wrangler.jsonc`.
3. The `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets on the GitHub repo.

Until both Access values are set, the API refuses every request.

Optionally, a `WISE_TOKEN` Worker secret gets live rates from Wise; without it, rates
come from the European Central Bank (through Frankfurter).
