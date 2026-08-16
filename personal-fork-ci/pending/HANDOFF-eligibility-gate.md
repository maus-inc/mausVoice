# Handoff — manifest eligibility gate fix

One small `.github/workflows/release.yml` change could not be pushed: the pushing token lacks the GitHub `workflows` permission, so the remote rejects any commit touching workflow files. Everything else from the Kilo Code review (the translations) is already pushed.

Apply this on a device whose token has `workflows` scope. Stay on `arena/01a00791-mausvoice` — do not create or switch branches.

## What it fixes

The build job enables signing only when **both** `UPDATER_PRIVATE_KEY` and `UPDATER_PUBLIC_KEY` are set, but the publish job's eligibility check tested only the **public** key. If only the public key were configured, signing would be skipped — so no `.sig` files exist — yet `eligible` would still be `true`, and the manifest step would **hard-fail the release** instead of cleanly skipping.

That defeats the fail-safe degradation the pipeline depends on. The gate now requires both keys, mirroring the build job.

This is latent today: all three secrets are set, so both gates already agree. It matters if a key is ever rotated, revoked, or partially configured.

## Steps

```bash
git fetch origin
git checkout arena/01a00791-mausvoice
git pull --ff-only origin arena/01a00791-mausvoice

git apply --index personal-fork-ci/pending/manifest-eligibility-gate.patch
```

If the patch does not apply, make the edit by hand in the `Resolve updater manifest eligibility` step of `.github/workflows/release.yml`:

- add `UPDATER_PRIVATE_KEY: ${{ secrets.UPDATER_PRIVATE_KEY }}` to that step's `env:`
- change the first condition from `if [ -z "$UPDATER_PUBLIC_KEY" ]; then` to `if [ -z "$UPDATER_PRIVATE_KEY" ] || [ -z "$UPDATER_PUBLIC_KEY" ]; then`
- update the warning text to `Updater signing keys are not fully configured - skipping latest.json.`

## Verify

```bash
# Both gates must require the same two secrets.
grep -A 12 "Resolve updater signing mode"        .github/workflows/release.yml | grep UPDATER_
grep -A 12 "Resolve updater manifest eligibility" .github/workflows/release.yml | grep UPDATER_
```

Both must list `UPDATER_PRIVATE_KEY` and `UPDATER_PUBLIC_KEY`.

## Commit

```bash
git commit -m "ci(release): require both signing keys for manifest eligibility

The build job gates signing on both UPDATER_PRIVATE_KEY and
UPDATER_PUBLIC_KEY, but the publish job checked only the public key. With
only the public key set, signing is skipped and no .sig files exist, yet
eligibility resolved true and the manifest step hard-failed the release
instead of cleanly skipping. Raised by Kilo Code review on PR #59."

git push origin arena/01a00791-mausvoice
```

Then delete `personal-fork-ci/pending/` and push that removal — it exists only to carry this handoff.
