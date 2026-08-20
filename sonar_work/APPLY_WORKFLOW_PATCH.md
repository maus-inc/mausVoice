# AGENT TASK: apply the SonarCloud workflow patch

You are a follow-up agent with GitHub `workflows` permission. Execute this task exactly. Do not improvise. Do not merge. Do not edit files outside the allowed list.

## Goal

SonarCloud quality gate on `main` fails Security Rating because these four files omit `--ignore-scripts` on `pnpm install`:

- `.github/workflows/build-desktop.yml`
- `.github/workflows/lint-desktop.yml`
- `.github/workflows/test-desktop-integration.yml`
- `.github/workflows/test-desktop-unit.yml`

`release.yml` currently uses `# NOSONAR`. That suppression is not the fix. The patch also replaces those two `release.yml` installs.

## Hard stop

If `git push` of `.github/workflows/*` is rejected for missing `workflows` permission, STOP. Tell the human to reconnect GitHub with the `workflows` permission. Do not copy workflow YAML into `personal-fork-ci` as a substitute. Do not add `# NOSONAR`. Do not rewrite the patch. Do not replace the helper with a bare `pnpm rebuild`.

## Allowed files

You may change only:

1. `.github/workflows/build-desktop.yml`
2. `.github/workflows/lint-desktop.yml`
3. `.github/workflows/release.yml`
4. `.github/workflows/test-desktop-integration.yml`
5. `.github/workflows/test-desktop-unit.yml`

You may also delete `sonar_work/workflow-ignore-scripts.patch` and `sonar_work/APPLY_WORKFLOW_PATCH.md` in the same commit after a successful apply, or leave them. Do not change any other path.

## Commands, in this order

Working directory: repository root. Branch: the open PR branch that already contains this file (`arena/01a01cd9-mausvoice` or its successor). Working tree must be clean.

```bash
git apply --check sonar_work/workflow-ignore-scripts.patch
git apply sonar_work/workflow-ignore-scripts.patch
node --test scripts/ci/pr28-contracts.test.mjs
```

If `git apply --check` fails, STOP. Do not hand-merge. Do not recreate the change from memory unless every remaining `pnpm install` line in the five files already contains both `--frozen-lockfile` and `--ignore-scripts` and each of those install steps already runs `node scripts/ci/rebuild-allowlisted.mjs` on the next line. In that case the patch is already applied: do not force it.

If the contract tests fail, STOP and revert the apply with:

```bash
git apply -R sonar_work/workflow-ignore-scripts.patch
```

## Required end state (assert after apply)

For each of the five files:

- Every `pnpm install` line contains `--frozen-lockfile` and `--ignore-scripts`.
- The install step `run:` block is exactly:

```yaml
        run: |
          pnpm install --frozen-lockfile --ignore-scripts
          node scripts/ci/rebuild-allowlisted.mjs
```

- No `# NOSONAR` remains on those install lines.
- No bare `pnpm rebuild` (rebuild with zero package arguments).
- No other steps, permissions, triggers, or comments are edited.

`--ignore-scripts` skips all lifecycle scripts. `scripts/ci/rebuild-allowlisted.mjs` then runs `pnpm rebuild` with the explicit package names from `onlyBuiltDependencies` in `pnpm-workspace.yaml` (esbuild, sharp, bcrypt, protobufjs, chromedriver, `@firebase/util`, re2). A bare `pnpm rebuild` is forbidden: it selects every lockfile package and also runs workspace project lifecycle hooks. Skipping the helper leaves Vite/esbuild without native binaries.

## Commit and push

```bash
git add .github/workflows/build-desktop.yml \
        .github/workflows/lint-desktop.yml \
        .github/workflows/release.yml \
        .github/workflows/test-desktop-integration.yml \
        .github/workflows/test-desktop-unit.yml
git commit -m "$(cat <<'EOF'
fix: apply ignore-scripts patch to desktop CI workflows

Install with --ignore-scripts, then rebuild only the
onlyBuiltDependencies allowlist via scripts/ci/rebuild-allowlisted.mjs.
EOF
)"
git push
```

Do not merge the PR. Do not retarget the branch. Do not amend unrelated commits.
