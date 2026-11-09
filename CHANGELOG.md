# Changelog

Notable changes to Mahnee, newest first, by the day they reached `main` (UTC).

<!--
For agents:
- Add one line under today's date, starting a `## YYYY-MM-DD` heading at the top if needed.
- Format: `- <Kind>: <what changed, in plain words> [#<PR>]`, with the link defined at the end.
- Kinds: Added, Changed, Fixed, Removed, Security. Start an incompatible change with
  **Breaking:** and say how to migrate.
- Keep it to one short line. Skip tests, formatting and internal refactors.
- Never invent references, versions or dates.
-->

## 2026-11-09

- Added: repeating bills in the export and import, a repeat starts from the next one, and account names wrap at large text [#?]

## 2026-11-06

- Added: repeating bills and income, logged from Home, and what to expect at month end [#17]
- Added: a monthly budget per spending category, with what's left on Home and carry-over [#16]
- Fixed: a Mahnee export picked before the accounts loaded is now previewed [#18]
- Changed: the changelog lists changes by date, one line each [#15]
- Added: import a bank's CSV file or a Mahnee export, with duplicates left unticked [#14]
- Added: a Search page across every account, with bulk move and delete of up to 500 [#13]
- Added: Home says how old its numbers are, and a change is never counted twice [#12]

## 2026-11-05

- Added: export every account and transaction as a CSV file [#11]
- Added: a month card on Home with what's left, spent, received and spending by category [#10]
- Added: transfers between your own accounts, never counted as spending [#9]
- Added: log spending and income from a quick entry sheet, and each account's page [#8]
- Added: spending and income categories with subcategories [#7]
- Added: changes made offline are kept on the device and saved once back online [#6]
- Added: cash, bank, card and e-wallet accounts with their balances on Home [#5]
- Added: a changelog of notable changes [#4]

## 2026-11-04

- Added: sign in, a home page, light and dark, and installing the app [#2]
- Added: Access sign-in shared with Splitfoolish, one email one person [#3]
- Security: per-version preview addresses are off, since Access doesn't cover them [#3]

## 2026-11-03

- Added: working rules for branches, commits and pull requests, checked by hooks and CI [#1]

[#1]: https://github.com/BlueSky0322/mahnee/pull/1
[#2]: https://github.com/BlueSky0322/mahnee/pull/2
[#3]: https://github.com/BlueSky0322/mahnee/pull/3
[#4]: https://github.com/BlueSky0322/mahnee/pull/4
[#5]: https://github.com/BlueSky0322/mahnee/pull/5
[#6]: https://github.com/BlueSky0322/mahnee/pull/6
[#7]: https://github.com/BlueSky0322/mahnee/pull/7
[#8]: https://github.com/BlueSky0322/mahnee/pull/8
[#9]: https://github.com/BlueSky0322/mahnee/pull/9
[#10]: https://github.com/BlueSky0322/mahnee/pull/10
[#11]: https://github.com/BlueSky0322/mahnee/pull/11
[#12]: https://github.com/BlueSky0322/mahnee/pull/12
[#13]: https://github.com/BlueSky0322/mahnee/pull/13
[#14]: https://github.com/BlueSky0322/mahnee/pull/14
[#15]: https://github.com/BlueSky0322/mahnee/pull/15
[#16]: https://github.com/BlueSky0322/mahnee/pull/16
[#17]: https://github.com/BlueSky0322/mahnee/pull/17
[#18]: https://github.com/BlueSky0322/mahnee/pull/18
