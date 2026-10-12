// Guards against a real, repeated incident: `.opencode/decisions.md`
// (2026-09-19, reinforced 2026-09-20 and confessed twice more since) records
// that this sandbox's own egress to the live deployment is blocked by org
// policy, and that recreating `.github/workflows/_tmp-smoke-test.yml` to
// dispatch a GitHub Actions job as a stand-in for the blocked curl is a
// policy circumvention ("do not retry or route around it -- report the
// blocked host", per /root/.ccr/README.md), not a sanctioned workaround. The
// file's only legitimate lifetime is within a single run -- created,
// dispatched, deleted, never committed to a state any other run or human
// reads back. Four separate runs have nonetheless landed a commit
// containing it before catching the standing decision. This test is the
// forcing hook the 2026-09-21 decisions.md entry asked a future run to add:
// if that file is ever present at `npm test` time, fail loudly before it
// can reach a push.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BANNED_WORKFLOW = join(ROOT, '.github', 'workflows', '_tmp-smoke-test.yml');

test('the banned live-probe-borrow workflow is never committed to the repo', () => {
  assert.equal(
    existsSync(BANNED_WORKFLOW),
    false,
    '.github/workflows/_tmp-smoke-test.yml must not be committed -- see .opencode/decisions.md (2026-09-20) ' +
      'for why the Actions-workflow live-probe-borrow is out of scope on policy grounds. Delete it before committing.'
  );
});

// opencode.yml runs on issue_comment/pull_request_review_comment, which fire
// for a comment from ANY GitHub account on this public repo -- GitHub's
// fork-PR approval gate does not cover comment-triggered workflows in the
// base repo. Without an author_association check, the `/oc` string match
// alone would let any stranger spend the owner's ANTHROPIC_API_KEY on demand
// and hand attacker-supplied comment text to a write-capable agent. See
// .opencode/decisions.md (2026-10-07) for the full incident.
test('opencode.yml only runs for the owner and people with write access', () => {
  const src = readFileSync(join(ROOT, '.github', 'workflows', 'opencode.yml'), 'utf8');
  assert.match(
    src,
    /author_association/,
    'opencode.yml\'s `if:` must gate on github.event.comment.author_association -- ' +
      'a bare `/oc` string match lets any commenter on this public repo trigger the agent.'
  );
  assert.doesNotMatch(
    src,
    /anomalyco\/opencode\/github@latest/,
    'opencode.yml must pin anomalyco/opencode/github to a specific release, not @latest -- ' +
      'a mutable tag can change behavior with ANTHROPIC_API_KEY in scope and no PR review.'
  );
});

// morning-automation.yml's `brief` job validates RESEARCH_REFRESH_URL/
// RESEARCH_CRON_SECRET are set before curling, printing a clear
// "::error::Missing repository secret(s)" message -- but the sibling
// `content` job was split out without that same guard (commit d2dcbda,
// 2026-09-12) and two later commits fixed other error-swallowing bugs in
// this exact file without ever adding it there too. With either secret
// unset, "${RESEARCH_REFRESH_URL%/}/api/content-sync" becomes the bare
// path "/api/content-sync"; curl exits 3 ("URL rejected: No host part in
// the URL") under `set -euo pipefail` before the diagnostic node block
// ever runs, so the owner sees only that opaque curl error in the Actions
// log instead of being told which secret to fix.
test('morning-automation.yml validates its secrets in both jobs, not just brief', () => {
  const src = readFileSync(join(ROOT, '.github', 'workflows', 'morning-automation.yml'), 'utf8');
  const contentJob = src.slice(src.indexOf('\n  content:'));
  assert.ok(contentJob.length > 0 && contentJob.startsWith('\n  content:'), 'content job not found');
  assert.match(
    contentJob,
    /Validate configuration/,
    'the `content` job must validate RESEARCH_REFRESH_URL/RESEARCH_CRON_SECRET before curling, ' +
      'the same guard the `brief` job already has -- otherwise an unset secret dies as an opaque ' +
      '`curl: (3) URL rejected` instead of a clear "Missing repository secret(s)" error.'
  );
});
