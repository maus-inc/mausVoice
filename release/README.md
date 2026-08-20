# Releases

| Branch       | Channel      | Eligible components                                                     |
| ------------ | ------------ | ----------------------------------------------------------------------- |
| `main`       | `dev`        | desktop, desktop `enterprise-dev`, enterprise admin, enterprise gateway |
| `prod`       | `prod`       | desktop, docs                                                           |
| `enterprise` | `enterprise` | Desktop, enterprise admin, enterprise gateway                           |

Pushing to any of these branches runs
[`release.yml`](../.github/workflows/release.yml). Its path filters detect
changes to `apps/desktop/`, `apps/windows-installer/`, `apps/docs/`,
`enterprise/admin/`, `enterprise/gateway/`, and `packages/`, then invoke the
eligible component workflows.

## Release notes

- `prod.txt` — desktop release notes shipped to the `dev` and `prod` channels.
- `enterprise.txt` — desktop release notes shipped to the `enterprise` and
  `enterprise-dev` channels.

## Promote dev → prod

[![Promote to prod](../docs/assets/badges/promo-prod.svg)](https://github.com/maus-inc/mausVoice/compare/prod...main?expand=1)

## Promote dev → enterprise

[![Promote to enterprise](../docs/assets/badges/promo-enterprise.svg)](https://github.com/maus-inc/mausVoice/compare/enterprise...main?expand=1)

Clicking opens a pre-filled PR comparing `main` against the target branch
(that's what's about to ship). Review the diff, title it (e.g.
`Release 2026-04-19`), and merge. Merging auto-releases the changed
components on that channel.

## Rollback

```bash
git push --force-with-lease origin <old-sha>:prod        # or :enterprise
```

Re-releases whatever components differ between the bad and good SHAs.
