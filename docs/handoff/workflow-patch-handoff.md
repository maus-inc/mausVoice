# Handoff — Apply the CI workflow patch (requires `workflows` permission)

> **STATUS (updated): DONE.** This change was applied and pushed in commit
> `bc43b5a` ("ci: raise Ubuntu Rust-transcription timeout 20 -> 45 min") on
> `arena/01a01be4-mausvoice`. The instructions below are retained for
> reference/rollback only — **do not re-apply the patch** on a branch that
> already contains `bc43b5a`, or `git apply` will fail with "patch does not
> apply" (the hunk is already present).

## Context

The stacked branch `arena/01a01be4-mausvoice` (fixes for PR #105) could not be
pushed from this session because the GitHub App token lacks `workflows: write`.
Because the branch is stacked on `arena/01a01a61-mausvoice` (PR #105), its
history contains commits that edit `.github/workflows/**`, so GitHub rejects the
whole push with:

```
refusing to allow a GitHub App to create or update workflow
`.github/workflows/build-desktop.yml` without `workflows` permission
```

One additional workflow change was also blocked by the same restriction. It is
captured as a git patch in **`docs/handoff/workflow-timeout.patch`**.

## What to do (deterministic)

Run these exact commands from the repository root on a machine whose git
credentials have `workflows` scope (a normal personal access token with
`repo` + `workflow` scopes, or the `workflow` write permission on a fine-grained
token):

```bash
cd /home/user/mausVoice          # or wherever the clone lives
git checkout arena/01a01be4-mausvoice
git fetch origin

# 1. Apply the patch (it touches only one file, one hunk)
git apply docs/handoff/workflow-timeout.patch

# 2. Confirm exactly one file changed, one logical edit
git diff --stat                # expect: .github/workflows/test-package-rust-transcription.yml | 7 +-
git diff -- .github/workflows/test-package-rust-transcription.yml

# 3. Verify YAML is still valid and the value is 45
grep -n "timeout-minutes" .github/workflows/test-package-rust-transcription.yml
#    expect line ~20: "timeout-minutes: 45"

# 4. Commit
git add .github/workflows/test-package-rust-transcription.yml
git commit -m "ci: raise Ubuntu Rust-transcription timeout 20 -> 45 min"

# 5. Push
git push origin arena/01a01be4-mausvoice
```

## Verification of intent (do not deviate)

- **Only** `timeout-minutes` changes from `20` to `45` on the `test:` job.
- Do **not** touch the other jobs, the `matrix`, `permissions`, or `on:`.
- Do **not** add `pull_request:` triggers or alter concurrency — that is out of
  scope and belongs to a different change.
- The explanatory comment must be included verbatim (it documents *why*, which
  reviewers require).

## If the push still fails

If it rejects with the same "workflows" message, the account pushing does not
have the scope. Use `gh auth status` / `git config` to confirm the token, then
retry. Nothing about the patch itself is wrong.
