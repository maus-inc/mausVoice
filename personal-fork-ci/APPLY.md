# Apply personal-fork CI workflows

This directory holds the personal-fork GitHub Actions workflow files that
strip Linux from desktop CI/release and add unsigned desktop releases.

They live here (instead of only under `.github/workflows/`) because some
push tokens cannot update workflow files. To install them:

```bash
cp personal-fork-ci/workflows/* .github/workflows/
# remove Linux deps helper if present (no longer referenced)
rm -f .github/scripts/install-desktop-linux-deps.sh
git add .github/workflows .github/scripts
git commit -m "ci: apply personal-fork workflows (no Linux, unsigned release)"
```

Do **not** remove these free-form release helpers (they post-date the fork base):
- `.github/workflows/release.yml` (workflow_dispatch recovery)
- `.github/workflows/retry-release.yml`
