# Changelog

Notable changes to this project's behavior, interfaces, data, configuration,
and developer workflows are recorded here.

Based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/).
Release versions follow the repository's existing versioning policy.

<!--
Instructions for agents:
- Read Unreleased before editing. Add each change to the matching category;
  consolidate related entries instead of duplicating them.
- Record implemented changes only. Do not list plans, TODOs, or unverified claims.
- Write one concise bullet per notable outcome: affected area, what changed,
  and the impact. For fixes, describe the incorrect behavior that was corrected.
- Include meaningful API, schema, configuration, dependency, build, and tooling
  changes when they affect consumers, maintainers, or future agent work.
- Skip routine formatting, renames, and test-only edits unless they change a
  documented contract or development workflow.
- Prefix incompatible changes with **Breaking:** and explain the required
  migration, or link to an existing migration guide.
- Add issue/PR links or repository-relative file links when useful and known.
  Never invent references, versions, dates, or release history.
- Update Unreleased during normal work. Create a release section only when
  explicitly asked to prepare a release; use the agreed version and release
  date, move the applicable entries, and keep Unreleased at the top.
- List releases newest first. Preserve released entries except to correct
  factual errors.
- Keep the six category names below. Remove empty categories from releases;
  empty categories under Unreleased may remain as a scaffold.

Entry format:
- <Area>: <concrete change and its impact>. <Optional reference or migration.>

Release heading format:
## <version> - <YYYY-MM-DD>
-->

## Unreleased

### Added

<!-- New features or capabilities. -->

- App: sign in through Cloudflare Access, see who is signed in, switch between light and
  dark, and install the app on a phone or computer; it opens offline from what the device
  last loaded. ([#2](https://github.com/BlueSky0322/mahnee/pull/2))
- Sign-in: the deployed app uses its own Access application with Splitfoolish's "Anyone
  with an email" policy, so one email is one person in both apps; each account sees only
  its own data. ([#3](https://github.com/BlueSky0322/mahnee/pull/3))
- Repository: working rules for branches, commits, pull requests and this changelog,
  checked by git hooks and the conventions workflow on every pull request.
  ([#1](https://github.com/BlueSky0322/mahnee/pull/1))

### Changed

<!-- Changes to existing behavior or workflows. -->

### Deprecated

<!-- Features still available but planned for removal; include the replacement. -->

### Removed

<!-- Removed features or support; include the replacement when applicable. -->

### Fixed

<!-- Corrections to incorrect behavior. -->

### Security

<!-- Security fixes; include a public advisory/CVE link when available. -->

- Worker: per-version preview addresses are turned off, since Access covers only the
  `workers.dev` address. ([#3](https://github.com/BlueSky0322/mahnee/pull/3))
