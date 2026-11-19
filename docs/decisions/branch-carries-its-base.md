# A working branch carries the current tip of its base, by merge, the whole time it is open

Date: 2026-11-09
Status: accepted

## Context

The human asked for rules in `AGENTS.md` that make an agent keep its branch current with
the base branch as it works, carry that state into the pull request, read what each merge
brings in, and delete the head branch once the human has confirmed the merge.

Nothing in `AGENTS.md` said when or how to bring the base in. The filing steps confirmed
the base once, at the end, and the babysit loop watched the head but not the base. A
branch that stays on the base it was cut from passes its own gates and then conflicts, or
merges and breaks the base, because no gate ran on the tree that ships.

## Decision

`AGENTS.md` gains `## Keep the branch current with its base` in the always-loaded core,
with seven numbered rules. Name the base before the first edit. Bring it in by merge and
never by rebase or force-push, because the pushed branch, the pull request, the review
threads and the session tracker all point at the existing commits. Merge before the first
edit, before every push, before opening the pull request and on any babysit poll that
shows `BEHIND`, `DIRTY` or `behind_by` above zero. Read what the merge brought in and
decide nothing, reuse, restructure or work around for each incoming change that meets the
work, as a row in the round log. Resolve conflicts on real content, with the generated
file, lockfile and vendored skill cases named. Run the gates on the merged tree and prove
the head contains the base tip. Never push to or merge into the base. The filing steps end
with deleting the head branch after a confirmed merge, checked with the branches API.

`.github/pull_request_template.md` names the base tip under the head SHA and asks for the
merge in the checklist. `.agents/PREFLIGHT.md`, `CONTRIBUTING.md` and `FULL-REVIEW.md`
phase 0 carry the matching lines. `docs/INTEGRATION-0.1.6.md` is marked historical,
because its rebase step predates this rule and its branch no longer exists.

## Evidence

- `FETCH_HEAD`, not `origin/<base>`. The first draft used `origin/<base>` and failed in
  the sandbox that wrote it. Its clone's fetch refspec covers `main` and the session
  branch only, so `git fetch origin <base>` never creates `origin/<base>`. `FETCH_HEAD`
  works in every clone shape.
- `gh api repos/<owner>/<repo>/compare/<base>...<head> --jq .behind_by` returns the
  count for two live branches and 404 once the head branch is deleted, which is the
  shape the babysit poll needs.
- The repository sets `delete_branch_on_merge`, so the branch of PR #326 was gone before
  anyone ran a delete. The rule checks for 404 first and deletes only when the branch is
  still there, so it holds on a repository without that setting.
- The commit hook accepts any subject starting with `Merge `, so the merge commit needs
  no special message shape.

## What was replaced in `AGENTS.md`

The file was at 801 lines against its own 800 cap, so three duplicates went. The three
bullets opening `## Filing A Pull Request` restated `## How to structure a Pull Request
description` and `**Writing style REPO-WIDE**`. The eleven bullets under `## PR
description required sections` mirrored the template item for item and could drift from
it; the template plus `pnpm run check:pr-body` is the binding copy, and the section now
says so in one paragraph. A doubled blank line went. The file is at 798 lines.

## What future work should reuse

A rule that names a git ref must be run in an agent clone before it is written down,
because the clone shape differs from a developer's. A new section in the core costs lines
that an existing duplicate must pay for, and the commit names what was removed.
