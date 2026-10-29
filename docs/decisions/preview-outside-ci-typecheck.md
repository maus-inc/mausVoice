# apps/preview is gated by CI so its typecheck cannot drift again

Date: 2026-10-29
Status: accepted and implemented

## Context

`pnpm-workspace.yaml` includes `apps/*`, so `@maus-inc/preview` is a workspace
package. It declares `check-types` and `test` scripts, and turbo runs them.

Nothing in CI ran its typecheck. `.github/workflows/release.yml` ran
`pnpm --filter desktop run check-types`, and `.github/workflows/test-docs.yml` ran
`pnpm --filter docs run check-types`. The root aggregate `pnpm run check-types` was
never run in CI either.

The result was a real regression that every gate missed. Verified on 2026-10-29
with the pinned toolchain, `pnpm@10.34.5` and the lockfile's `typescript`, after
building the workspace packages so `TS2307` module errors were ruled out as
build-order artifacts:

- `apps/preview` reported exactly 2 errors, both `TS2769` in
  `apps/preview/src/demos/buttons.tsx` at lines 25 and 48, where the demo used
  `<Button variant="blue">`.
- `ButtonPropsVariantOverrides` in `apps/desktop/src/mui.d.ts:43` declares only
  `flat` and `chrome`, so `"blue"` was not assignable.
- The root `pnpm run check-types` failed on `@maus-inc/preview#check-types`.
- The app still worked at runtime and its 22 tests passed, which is why manual
  checking never caught it.

The root cause was a design change that was never carried through the demo layer.
`apps/desktop/src/styles/palette.ts:99` records the accent as silver and ink, "never
hue-blue", and no `blue` token exists anywhere in `apps/desktop/src`.

## Decision

Repair the class rather than the instance:

- `apps/preview/src/demos/buttons.tsx` now uses `variant="chrome"`, which is a real
  declared variant and is styled at `apps/desktop/src/theme.ts:546` from
  `palette.chrome`, `onChrome` and `accentSurface`. This is also the truthful name:
  `apps/desktop/DESIGN.md` calls the accent the "silver/ink chrome accent", so the
  variant that was labelled `blue` is `chrome`.
- `apps/preview/src/lib/registry.ts` names the same matrix, so the label follows.
- `apps/preview` gained a `lint` script, `prettier --check src && oxlint src`, and
  `oxlint ^1.78.0` as a devDependency, the same version already in the tree for
  `apps/desktop`. The lockfile change adds one importer entry and nothing else.
- `.github/workflows/test-desktop-unit.yml` now runs preview `check-types` and `lint`
  in the job that already installs dependencies, builds them and runs the preview
  tests. That workflow already listed `apps/preview/**` in its trigger paths, so the
  guard runs on exactly the changes that can break it.

Verified after the change: preview `check-types` exits 0, preview `lint` reports 0
warnings and 0 errors over 31 files, the root `pnpm run check-types` reports 9 of 9
tasks successful, and the preview tests still pass 22 of 22.

Rejected: widening `ButtonPropsVariantOverrides` to accept `blue`. That would
legalise a token the design system deliberately removed and re-open the drift in the
real app. Also rejected: deleting the fourth demo button outright, which would have
left the theme's only `chrome` variant with no visible surface anywhere.

## Consequences

This makes the root typecheck trustworthy again, and it gives the `chrome` variant its
first visible surface, in a demo that previously showed a variant that no longer
existed. It makes it hard to land a preview change that does not typecheck or lint,
because the workflow triggers on `apps/preview/**`.

Two smaller gaps remain, both documented rather than fixed:

1. `apps/preview/scripts/write-specs.mjs` generates the 39 files in
   `apps/preview/specs/`, and nothing in CI runs `gen:specs`, so the generated prose
   can still drift from the code. `specs/color.md` currently describes a blue accent
   that `apps/desktop/DESIGN.md` removed. See `engineering/design-skills.md`.
2. The blue swatches in `apps/preview/src/lib/registry.ts` are deliberate, documented
   at line 291, and are left alone because the token page needs something to render.
