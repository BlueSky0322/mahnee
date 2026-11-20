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

## 2026-11-20

- Fixed: each tab opens at the top and comes back where you left it; Activity on a smaller laptop edits in a dialog with Save in view; New entry fits short phones, with a Payee field and a Note [#?]
- Added: each account's history downloads to the device in the background, so Activity, its filters and an account's entries work offline, saying which days it holds while a download isn't finished [#63]
- Changed: every list you pick from is the app's own, a list under the field on a computer and a sheet on a phone, and Repeats picks a day from a calendar or a weekday [#62]
- Fixed: a change is kept on the device the moment it's made, even while another is saving; one the server refuses waits for you to try again or discard it, and the rest still save [#60]
- Fixed: a change of home currency that pauses now and then but keeps going is no longer given back, rates are fetched fewer times, and rate days show the right day east of UTC+12 [#61]
- Fixed: importing older bank rows no longer counts them twice: the preview shows the balance before and after, and asks whether rows from before you started tracking are already in the opening balance [#59]
- Changed: New entry says when it keeps a draft ("Keep draft"), and Discard draft throws it away, with Undo [#58]
- Fixed: Search everything on Home looks through every month, and Activity's dates still narrow it [#58]
- Changed: Set a budget asks you to choose an expense category, and opens its monthly budget ready to type [#58]
- Added: a bank file's Date, Description and Amount (or Debit and Credit) columns are picked for you when their names are clear [#58]
- Changed: one tap on Add's currency opens the list of currencies, yours and today's first [#58]
- Added: Install the app on the Settings page, where the browser can install it [#58]
- Fixed: Activity asks to Save, Discard or Keep editing before changes not saved would be lost: another row, a search, leaving, or closing the sheet [#58]
- Added: a transfer with nowhere to go offers Add account, and goes on to the new account as typed [#58]
- Changed: the new logo, a hand holding a coin, in the app, the browser tab and the installed app; in the app its tile takes your accent and theme [#57]

## 2026-11-19

- Changed: the reminder settings say plainly what they do: "Heads-up before scheduled entries", and when reminders come [#56]
- Added: reminders on your phone: a daily one when nothing was added, and one the day before a scheduled entry, naming it and its amount [#55]
- Added: log an entry in another currency: pick your other currencies in Settings › Money, switch with the pill on Add, and each entry keeps what you typed and its rate [#54]
- Changed: An account's kind can be changed in Edit, a card to a bank account and back, with its balance shown as it will read [#53]

## 2026-11-18

- Added: pick your home currency in Settings › Money; every amount converts at its own day's rate, and changing back restores them exactly [#52]
- Added: Your picture in place of the initial: your Google picture once set up, or a photo chosen in My account [#51]
- Changed: Fields, small buttons, lists and dialogs match the design's lines, sizes and spacing everywhere [#50]
- Added: Scheduled shows the next 30 days: what comes in and goes out, and each account's lowest point [#49]
- Changed: Plan, each category's page and Scheduled match the design [#48]
- Changed: Activity and Add match the design; Activity leaves out transfers until you ask for them [#47]
- Changed: Accounts and each account's page match the design [#46]
- Changed: Settings matches the design, including its sidebar, search and sections [#45]
- Changed: Home matches the design; phones no longer show Coming up [#44]
- Changed: the app's spacing, icons, category colours and controls now match the design [#43]

## 2026-11-17

- Added: scheduled bills and pay are added on their day, from Scheduled, with amounts that change marked to check; Plan › Scheduled lists them by month [#42]
- Fixed: an opening balance typed as a sum is worked out exactly, as in Add [#40]
- Added: choose the day your month starts, or payday, in Settings › Money; every monthly figure and budget follows it [#39]
- Added: settings for how Add starts, the account it uses, suggestions, a time on entries, accent colours, a shorter Home and the opening page; new budgets carry over by default [#38]
- Changed: Plan shows budgets against the month, where the money went and income by category, each over 12 months, with budgets set in place on a computer; Home's Expenses so far and Income open all of either over 12 months [#37]
- Removed: Left this month and Over this month; Home's month end takes their place [#37]
- Added: Settings with search, My account, a new Categories page, and Import and export with export ranges and Undo for recent imports [#36]

## 2026-11-16

- Changed: Home is at a glance: the month end with its sum, spent and received, Tidy up, Coming up, a day-by-day calendar, budgets against the month, and a first run [#35]
- Added: Accounts shows all together, what's owed and each archived account's day, with a register and Add here on each account [#34]
- Changed: Add is a keypad that works sums out, with recent categories, a payee field, Today, Repeat and drafts [#30]
- Fixed: Mahnee no longer stops answering after one sign-in check is cut off mid-way [#31]
- Added: Activity lists every entry by day or in a register, with filters, totals and changing many at once [#28]
- Fixed: Undo reached from the keyboard right after a dialog closes now undoes, instead of opening the dialog again [#29]
- Fixed: after the accounts fail to load, opening a page no longer hides the tab bar or sidebar [#27]
- Changed: the figures always say how fresh they are, and the offline and Undo messages have the new look [#26]
- Added: Home, Activity, Plan and Accounts a tap away in a tab bar or sidebar, with Settings [#24]

## 2026-11-15

- Changed: a new look, on a paper ground in Geist with filled cobalt buttons [#22]

## 2026-11-09

- Added: repeating bills are in the export and come back on import [#21]
- Changed: a repeat set up from an old transaction starts from its next date [#21]
- Fixed: account names and Add account wrap at large text instead of being cut off [#21]
- Added: tap a category, Spent or Received on Home to see its last 12 months [#20]

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
[#20]: https://github.com/BlueSky0322/mahnee/pull/20
[#21]: https://github.com/BlueSky0322/mahnee/pull/21
[#22]: https://github.com/BlueSky0322/mahnee/pull/22
[#24]: https://github.com/BlueSky0322/mahnee/pull/24
[#26]: https://github.com/BlueSky0322/mahnee/pull/26
[#27]: https://github.com/BlueSky0322/mahnee/pull/27
[#28]: https://github.com/BlueSky0322/mahnee/pull/28
[#29]: https://github.com/BlueSky0322/mahnee/pull/29
[#30]: https://github.com/BlueSky0322/mahnee/pull/30
[#31]: https://github.com/BlueSky0322/mahnee/pull/31
[#34]: https://github.com/BlueSky0322/mahnee/pull/34
[#35]: https://github.com/BlueSky0322/mahnee/pull/35
[#36]: https://github.com/BlueSky0322/mahnee/pull/36
[#37]: https://github.com/BlueSky0322/mahnee/pull/37
[#38]: https://github.com/BlueSky0322/mahnee/pull/38
[#39]: https://github.com/BlueSky0322/mahnee/pull/39
[#40]: https://github.com/BlueSky0322/mahnee/pull/40
[#42]: https://github.com/BlueSky0322/mahnee/pull/42
[#43]: https://github.com/BlueSky0322/mahnee/pull/43
[#44]: https://github.com/BlueSky0322/mahnee/pull/44
[#45]: https://github.com/BlueSky0322/mahnee/pull/45
[#46]: https://github.com/BlueSky0322/mahnee/pull/46
[#47]: https://github.com/BlueSky0322/mahnee/pull/47
[#48]: https://github.com/BlueSky0322/mahnee/pull/48
[#49]: https://github.com/BlueSky0322/mahnee/pull/49
[#50]: https://github.com/BlueSky0322/mahnee/pull/50
[#51]: https://github.com/BlueSky0322/mahnee/pull/51
[#52]: https://github.com/BlueSky0322/mahnee/pull/52
[#53]: https://github.com/BlueSky0322/mahnee/pull/53
[#54]: https://github.com/BlueSky0322/mahnee/pull/54
[#55]: https://github.com/BlueSky0322/mahnee/pull/55
[#56]: https://github.com/BlueSky0322/mahnee/pull/56
[#57]: https://github.com/BlueSky0322/mahnee/pull/57
[#58]: https://github.com/BlueSky0322/mahnee/pull/58
[#59]: https://github.com/BlueSky0322/mahnee/pull/59
[#60]: https://github.com/BlueSky0322/mahnee/pull/60
[#61]: https://github.com/BlueSky0322/mahnee/pull/61
[#62]: https://github.com/BlueSky0322/mahnee/pull/62
[#63]: https://github.com/BlueSky0322/mahnee/pull/63
