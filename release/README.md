# Releases

> **Maintained runbook:** [Release process](https://maus-inc.github.io/mausVoice/docs/development/releases/) and `docs/RELEASE.md`.

This tree does **not** ship enterprise admin/gateway apps. `enterprise/` is gone. Flavor names `enterprise` / `enterprise-dev` may still appear in types; they are not release channels.

Releases are a **manual** `.github/workflows/release.yml` dispatch (version, prerelease, notes, optional tag `mausVoice-v{version}`).

| What ships | Notes |
| --- | --- |
| Desktop | macOS universal, Windows, Linux `.deb` + AppImage |
| Docs / Pages | Separate docs workflow; not an enterprise channel |
| Homebrew cask | Stable releases only → `maus-inc/homebrew-mausvoice` |

Path filters watch `apps/desktop/`, `apps/windows-installer/`, `apps/docs/`, and `packages/`.

## Notes files

- `prod.txt` — desktop release notes for the public GitHub Release body when used.

There is no live `enterprise.txt` channel.

## Signing

OS binaries are unsigned. The **updater** uses minisign secrets (`UPDATER_*`). Stable releases without those secrets fail closed (no unsigned `latest.json`). Prereleases skip the manifest.

Do not force-push production tags casually. Rollback is a new release or a documented tag move — see `docs/RELEASE.md`.
