# The four uninstalled dependency overrides stay as install-time guards

Date: 2026-11-05
Status: accepted

## Context

`package.json` carries 49 `pnpm.overrides` entries against 30 distinct packages.
Most of them override a package that is installed today. Fallow reports the rest
as `unused_dependency_overrides`, because its check asks whether any workspace
dependency or lockfile package currently matches the override target. Four
targets match nothing:

| Override key                       | Range                 | Installed instances |
| ---------------------------------- | --------------------- | ------------------- |
| `@hono/node-server@<1.19.13`        | `>=1.19.13`           | 0                   |
| `@protobufjs/utf8@<=1.1.0`          | `>=1.1.1`             | 0                   |
| `hono@<4.12.25`                     | `>=4.12.25`           | 0                   |
| `qs@>=6.11.1 <=6.15.1`              | `>=6.15.2`            | 0                   |

Verified on 2026-11-05 against `pnpm-lock.yaml`: the only lines naming those four
packages are the override keys themselves, and `package.json` is the only
manifest that names them at all.

An override with no current instance is not dead weight. These four target
versions that a transitive dependency could resolve to later, after an unrelated
lockfile change, and they exist because a vulnerable version was reachable
through a chain this repository does not pin directly.

## Decision

Keep all four. `engineering/fallow.md` already records the rule: an override
reported as unused is not, by itself, evidence that a security override is safe
to remove, and the guards for `@hono/node-server`, `@protobufjs/utf8`, `qs` and
`hono` also prevent future vulnerable transitive resolutions. An isolated pnpm
10.34.5 fixture requesting the affected versions confirmed that each resolves
outside its vulnerable range with the overrides in place.

Rejected: deleting the four to clear the `unused_dependency_overrides` finding.
That would make the audit quieter by removing protection rather than by proving
the protection is redundant, and the next install of a package that pulls `qs`
or `hono` in would resolve whatever the registry serves.

Also rejected: adding artificial dependencies so the targets have an installed
instance and the finding disappears. That adds supply-chain surface to satisfy a
reporting artifact.

## Consequences

The Fallow audit keeps reporting `unused_dependency_overrides`. It is a known,
explained advisory and not a gate failure: the changed-code gate fails on
introduced error-severity findings, and this one is inherited.

Remove an override only when an equivalent install-time protection exists and
has been verified — for example, a direct dependency pin that closes the same
range, or an upstream package that no longer depends on the vulnerable version.
Record that verification here when it happens.
