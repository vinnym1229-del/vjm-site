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
import { existsSync } from 'node:fs';
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
