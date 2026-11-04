// Checks branch names, commit messages and pull requests against the rules in AGENTS.md
// ("Git, commits and pull requests"). The git hooks and the conventions workflow run it:
//
//   node tools/git/conventions.js commit-msg <file>   (.husky/commit-msg)
//   node tools/git/conventions.js pre-push            (.husky/pre-push, refs on stdin)
//   node tools/git/conventions.js pr                  (.github/workflows/conventions.yml,
//                                                      with the pull request in the env)
//
// Each check returns the problems it found, as sentences; none means it passes.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const TYPES = ['feat', 'fix', 'refactor', 'perf', 'test', 'docs', 'build', 'ci', 'chore'];
/** Changes a person can see, which add a line to CHANGELOG.md */
export const VISIBLE_TYPES = ['feat', 'fix', 'refactor', 'perf'];
export const MAX_TITLE = 72;
export const MAX_BULLETS = 3;
export const MAX_BRANCH = 50;
export const PR_SECTIONS = ['## Summary', '## Problem', '## Solution', '## How to test'];

const TITLE = new RegExp(`^(${TYPES.join('|')})(\\([a-z0-9]+(?:-[a-z0-9]+)*\\))?!?: \\S`);
const BRANCH = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// What an assistant's tools add to say who wrote something; a person as co-author is fine
const ASSISTANT = String.raw`(claude|anthropic|copilot|chatgpt|openai|codex|gemini|cursor|assistant)`;
const ATTRIBUTION = [
  new RegExp(String.raw`^co-authored-by:.*${ASSISTANT}`, 'im'),
  new RegExp(String.raw`generated (with|by) \[?${ASSISTANT}`, 'i'),
  /^claude-session:/im,
  /claude\.ai\/code/i,
  /claude\.com\/claude-code/i,
];
const EMOJI = /\p{Extended_Pictographic}/u;
// What git writes itself, which carries none of these rules
const GIT_MADE =
  /^(Merge (branch|remote-tracking branch|pull request) |Revert "|fixup! |squash! |amend! )/;

/** What's wrong with a commit or pull request title */
export function checkTitle(title) {
  const problems = [];
  if (!TITLE.test(title)) {
    problems.push(
      `The title "${title}" must read "<type>(<scope>): <summary>", with a type of ` +
        `${TYPES.join(', ')} and a lowercase kebab-case scope.`,
    );
  }
  if (title.length > MAX_TITLE) {
    problems.push(`The title is ${title.length} characters; at most ${MAX_TITLE}.`);
  }
  if (/[.\s]$/.test(title)) problems.push('The title must not end with a period or a space.');
  return problems;
}

/** Problems shared by commit messages and pull request bodies */
function checkText(text, what) {
  const problems = [];
  if (ATTRIBUTION.some((line) => line.test(text))) {
    problems.push(
      `The ${what} carries AI attribution (Co-authored-by, Generated with, a session link); take it out.`,
    );
  }
  if (EMOJI.test(text)) problems.push(`The ${what} has an emoji; take it out.`);
  return problems;
}

/** A commit message as git hands it to the commit-msg hook: comments and scissors go */
export function cleanMessage(raw) {
  const cut = raw.split(/^# -+ >8 -+$/m)[0];
  return cut
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n')
    .trim();
}

/** What's wrong with a commit message */
export function checkCommitMessage(raw) {
  const message = cleanMessage(raw);
  const [title = '', ...rest] = message.split('\n');
  if (GIT_MADE.test(title)) return checkText(message, 'commit message');
  const problems = [...checkTitle(title), ...checkText(message, 'commit message')];
  if (rest.length > 0 && rest[0].trim() !== '') {
    problems.push('Leave a blank line between the title and the body.');
  }
  const body = rest.map((line) => line.trimEnd()).filter((line) => line !== '');
  const bullets = body.filter((line) => line.startsWith('- '));
  if (bullets.length !== body.length) {
    problems.push('The body is bullets only: each line starts with "- ".');
  }
  if (bullets.length > MAX_BULLETS) {
    problems.push(`The body has ${bullets.length} bullets; at most ${MAX_BULLETS}.`);
  }
  return problems;
}

/** What's wrong with a branch's name */
export function checkBranch(name) {
  if (name === 'main') return ['Never push to main; open a pull request from its own branch.'];
  const problems = [];
  if (name.includes('/')) {
    problems.push(
      `The branch "${name}" has a slash. Name it for the change, in kebab-case ` +
        '(account-balances), never a generated or session name such as claude/<words>-<id>.',
    );
  } else if (!BRANCH.test(name)) {
    problems.push(
      `The branch "${name}" must be lowercase words and digits joined by single hyphens ` +
        '(csv-import).',
    );
  }
  if (name.length > MAX_BRANCH) {
    problems.push(`The branch name is ${name.length} characters; at most ${MAX_BRANCH}.`);
  }
  return problems;
}

/** What's wrong with a pull request: its title, body, branch, commits and changelog */
export function checkPullRequest({ title, body, branch, files = [], commits = [] }) {
  const problems = [...checkTitle(title), ...checkBranch(branch)];
  const text = (body ?? '').trim();
  if (text === '' || text === 'placeholder') {
    problems.push('The description is still empty or "placeholder"; set it to the four sections.');
  } else {
    problems.push(...checkText(text, 'description'));
    const headings = text.split('\n').filter((line) => /^#{1,6} /.test(line));
    if (headings.join('\n') !== PR_SECTIONS.join('\n')) {
      problems.push(
        `The description has exactly these sections, in order: ${PR_SECTIONS.join(', ')}. ` +
          `It has: ${headings.join(', ') || 'none'}.`,
      );
    }
    const steps = text.split('## How to test')[1] ?? '';
    if (!/^1\. /m.test(steps)) problems.push('How to test is numbered steps: "1. ...".');
    if (/\]\((?!https?:\/\/)/.test(text)) {
      problems.push('The description links to files; name them in `code` instead.');
    }
  }
  const type = TITLE.exec(title)?.[1];
  if (VISIBLE_TYPES.includes(type) && !files.includes('CHANGELOG.md')) {
    problems.push(`A ${type} pull request adds a line to CHANGELOG.md.`);
  }
  for (const message of commits) {
    for (const problem of checkCommitMessage(message)) {
      problems.push(`Commit "${message.split('\n')[0]}": ${problem}`);
    }
  }
  return problems;
}

/** Prints the problems and says whether all was well */
function report(problems, what) {
  if (problems.length === 0) return true;
  console.error(`\n${what} doesn't follow the conventions in AGENTS.md:\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('');
  return false;
}

function main([command, arg]) {
  if (command === 'commit-msg') {
    return report(checkCommitMessage(readFileSync(arg, 'utf8')), 'This commit message');
  }
  if (command === 'pre-push') {
    // Each line: <local ref> <local sha> <remote ref> <remote sha>; a deletion pushes no sha
    const refs = readFileSync(0, 'utf8')
      .split('\n')
      .map((line) => line.split(' '))
      .filter(([, sha, remote]) => remote?.startsWith('refs/heads/') && !/^0+$/.test(sha));
    const problems = refs.flatMap(([, , remote]) =>
      checkBranch(remote.slice('refs/heads/'.length)),
    );
    return report(problems, 'This push');
  }
  if (command === 'pr') {
    const env = process.env;
    const split = (value, by) => (value ?? '').split(by).filter((s) => s.trim() !== '');
    return report(
      checkPullRequest({
        title: env.PR_TITLE ?? '',
        body: env.PR_BODY ?? '',
        branch: env.PR_BRANCH ?? '',
        files: split(env.PR_FILES, '\n'),
        // Commit messages, each ended by a record separator (git log --format=%B%x1e)
        commits: split(env.PR_COMMITS, '\x1e').map((m) => m.trim()),
      }),
      'This pull request',
    );
  }
  console.error('Usage: conventions.js commit-msg <file> | pre-push | pr');
  return false;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2)) ? 0 : 1;
}
