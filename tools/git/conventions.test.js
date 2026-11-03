import { describe, expect, it } from 'vitest';
import { checkBranch, checkCommitMessage, checkPullRequest, checkTitle } from './conventions.js';

// The conventions the git hooks and the pull request check hold to (AGENTS.md)

const BODY = `## Summary

Each account's balance shows on the home screen.

## Problem

You had to open an account to see what was in it.

## Solution

- The home screen lists every account with its balance.

## How to test

1. Open the app. Each account shows its balance.`;

describe('titles', () => {
  it('takes a type, an optional kebab-case scope and a summary', () => {
    expect(checkTitle('feat(accounts): show each balance on the home screen')).toEqual([]);
    expect(checkTitle('fix(csv-import): read dates written day first')).toEqual([]);
    expect(checkTitle('test: cover a refused transfer')).toEqual([]);
  });

  it('refuses anything else, too long, or ending in a period', () => {
    expect(checkTitle('Add balances')).toHaveLength(1);
    expect(checkTitle('feature(accounts): add balances')).toHaveLength(1);
    expect(checkTitle('feat(Accounts): add balances')).toHaveLength(1);
    expect(checkTitle('feat(accounts):add balances')).toHaveLength(1);
    expect(checkTitle('feat(accounts): add balances.')).toHaveLength(1);
    expect(checkTitle(`feat(accounts): ${'a'.repeat(60)}`)).toHaveLength(1);
  });
});

describe('commit messages', () => {
  it('takes a title alone, or with up to three bullets after a blank line', () => {
    expect(checkCommitMessage('feat(accounts): show balances\n')).toEqual([]);
    expect(checkCommitMessage('feat(accounts): show balances\n\n- One\n- Two\n- Three\n')).toEqual(
      [],
    );
  });

  it("ignores git's comments and what follows its scissors line", () => {
    const raw =
      'fix(ui): keep the total in view\n\n- It no longer scrolls away\n# Please enter the commit message\n' +
      '# ------------------------ >8 ------------------------\ndiff --git a/x b/x\n';
    expect(checkCommitMessage(raw)).toEqual([]);
  });

  it('refuses a fourth bullet, prose in the body, or no blank line', () => {
    expect(checkCommitMessage('feat(a): b\n\n- 1\n- 2\n- 3\n- 4')).toEqual([
      'The body has 4 bullets; at most 3.',
    ]);
    expect(checkCommitMessage('feat(a): b\n\nSome prose.')).toEqual([
      'The body is bullets only: each line starts with "- ".',
    ]);
    expect(checkCommitMessage('feat(a): b\n- 1')).toContain(
      'Leave a blank line between the title and the body.',
    );
  });

  it("refuses an assistant's attribution and emojis, but not a person as co-author", () => {
    const signed = (line) => checkCommitMessage(`feat(a): b\n\n- c\n\n${line}`);
    expect(signed('Co-Authored-By: Claude <noreply@anthropic.com>')).toHaveLength(2);
    expect(signed('Claude-Session: https://claude.ai/code/session_1')).toHaveLength(2);
    expect(checkCommitMessage('feat(a): add balances \u{1F680}')).toHaveLength(1);
    expect(signed('Co-authored-by: Ann Lee <ann@example.com>')).toHaveLength(1);
    expect(checkCommitMessage('feat(import): read files generated with Excel')).toEqual([]);
  });

  it("lets git's own merge and revert titles through", () => {
    expect(checkCommitMessage("Merge branch 'main' into csv-import")).toEqual([]);
    expect(checkCommitMessage('Revert "feat(a): b"\n\nThis reverts commit abc.')).toEqual([]);
  });
});

describe('branches', () => {
  it('takes kebab-case names for the change', () => {
    expect(checkBranch('account-balances')).toEqual([]);
    expect(checkBranch('csv-import-2')).toEqual([]);
  });

  it('refuses session names, slashes, capitals, underscores, main and long names', () => {
    expect(checkBranch('claude/sharp-feynman-wv3xgj')[0]).toMatch(/generated or session name/);
    expect(checkBranch('feature/balances')).toHaveLength(1);
    expect(checkBranch('Account_Balances')).toHaveLength(1);
    expect(checkBranch('balances--')).toHaveLength(1);
    expect(checkBranch('main')[0]).toMatch(/Never push to main/);
    expect(checkBranch('a'.repeat(51))).toHaveLength(1);
  });
});

describe('pull requests', () => {
  const pr = (over = {}) => ({
    title: 'feat(accounts): show each balance on the home screen',
    body: BODY,
    branch: 'account-balances',
    files: ['CHANGELOG.md', 'web/src/App.tsx'],
    commits: [
      'feat(accounts): show each balance on the home screen\n\n- The home screen lists them',
    ],
    ...over,
  });

  it('passes one that follows every rule', () => {
    expect(checkPullRequest(pr())).toEqual([]);
  });

  it('fails while the description is still the placeholder', () => {
    expect(checkPullRequest(pr({ body: 'placeholder' }))[0]).toMatch(/placeholder/);
  });

  it('wants exactly the four sections, in order, with numbered steps', () => {
    const extra = `${BODY}\n\n## Checks run\n\n- yarn test`;
    expect(checkPullRequest(pr({ body: extra }))[0]).toMatch(/exactly these sections/);
    const swapped = BODY.replace('## Problem', '## Why').replace('## Summary', '## Problem');
    expect(checkPullRequest(pr({ body: swapped }))[0]).toMatch(/exactly these sections/);
    const unnumbered = BODY.replace('1. Open', '- Open');
    expect(checkPullRequest(pr({ body: unnumbered }))).toEqual([
      'How to test is numbered steps: "1. ...".',
    ]);
  });

  it("refuses a tool's footer, file links, a session branch and an unconventional commit", () => {
    const footer = `${BODY}\n\n\u{1F916} Generated with [Claude Code](https://claude.com/claude-code)`;
    expect(checkPullRequest(pr({ body: footer }))).toHaveLength(2);
    const linked = BODY.replace('home screen.', 'home screen ([App](web/src/App.tsx)).');
    expect(checkPullRequest(pr({ body: linked }))).toEqual([
      'The description links to files; name them in `code` instead.',
    ]);
    expect(checkPullRequest(pr({ branch: 'claude/sharp-feynman-wv3xgj' }))).toHaveLength(1);
    expect(checkPullRequest(pr({ commits: ['wip'] }))[0]).toMatch(/^Commit "wip": /);
  });

  it('wants a changelog line for a change a person can see, and not for tests', () => {
    expect(checkPullRequest(pr({ files: ['web/src/App.tsx'] }))).toEqual([
      'A feat pull request adds a line to CHANGELOG.md.',
    ]);
    const tests = { title: 'test(accounts): cover a refused transfer', files: ['x.test.ts'] };
    expect(checkPullRequest(pr({ ...tests, commits: [tests.title] }))).toEqual([]);
  });
});
