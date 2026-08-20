# Releases

> **Maintained runbook:** [Release process](https://maus-inc.github.io/mausVoice/docs/development/releases/) and `docs/RELEASE.md`.

This tree does **not** ship enterprise admin/gateway apps. `enterprise/` is gone. Flavor names `enterprise` / `enterprise-dev` may still appear in types; they are not release channels.

Releases are a **manual** `.github/workflows/release.yml` dispatch (version, prerelease, notes, optional tag `mausVoice-v{version}`).

| What ships    | Notes                                                |
| ------------- | ---------------------------------------------------- |
| Desktop       | macOS universal, Windows, Linux `.deb` + AppImage    |
| Docs / Pages  | Separate docs workflow; not an enterprise channel    |
| Homebrew cask | Stable releases only → `maus-inc/homebrew-mausvoice` |

The release workflow is `workflow_dispatch` only (no path filters). It builds `apps/desktop/` and its `packages/` dependencies. The docs site builds in a separate Pages workflow. `apps/windows-installer/` is not part of the release pipeline.

## Notes files

- `prod.txt`: optional manual notes. The workflow does not read this file into the GitHub Release body; paste or attach notes when dispatching.

There is no live `enterprise.txt` channel.

## Signing

OS binaries are unsigned. The **updater** uses minisign secrets (`UPDATER_*`). Stable releases without those secrets fail closed (no unsigned `latest.json`). Prereleases skip the manifest.

Do not force-push production tags casually. Rollback is a new release or a documented tag move. See `docs/RELEASE.md`.
