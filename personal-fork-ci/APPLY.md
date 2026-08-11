# Personal fork CI templates

This directory holds the personal-fork GitHub Actions workflow copies that
survive independently of `.github/workflows/`. Their purpose is to keep a
known-good branch of the CI definitions so they can be re-applied if the live
workflows drift or a push token cannot update workflow files.

- `build-desktop.yml` — desktop build gate (CI), Linux included
- `lint-desktop.yml` — desktop lint gate (CI), all three pill crates

The mausVoice release pipeline is **`.github/workflows/release.yml`** (single,
workflow_dispatch-based). The old upstream multi-channel release stack
(`_release-desktop-impl.yml`, `release-unsigned.yml`, release-enterprise-*,
release-docs, retry-release, publish-packages) was deleted — do not reintroduce
it. Releases are unsigned and authored by the maintainer's PAT (`RELEASE_TOKEN`
secret) when present.

To re-apply CI templates:

```bash
cp personal-fork-ci/workflows/build-desktop.yml .github/workflows/
cp personal-fork-ci/workflows/lint-desktop.yml .github/workflows/
git add .github/workflows
git commit -m "ci: re-apply personal-fork CI templates"
```

Do **not** remove `.github/scripts/install-desktop-linux-deps.sh` — release and
build workflows reference it for the Linux matrix.