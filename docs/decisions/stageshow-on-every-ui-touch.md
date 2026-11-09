# Stageshow is vendored and binding for every change that touches UI in any file

Date: 2026-11-09
Status: accepted

## Context

The human asked for the Stageshow skill to be installed from GitHub, read in full,
vendored into `.agents/skills/`, and made binding in the design document and
`AGENTS.md` for any change touching any form of UI in any sort of file.

Stageshow is `benjitaylor/skills`, folder `stageshow/`, MIT, released 2026-10-31.
Vendored at commit `299140fafd08df55a9c234e610c3f64af3f45531` (Stageshow 1.1.1,
2026-11-04) with the project's install command, `npx skills add benjitaylor/skills -s
stageshow -a universal --copy -y`. `diff -rq` against a fresh clone of upstream at
that commit reports no difference across its 372 files, and `node
scripts/ci/verify-skills.mjs` reports 54 of 54 locked skills verified.

Upstream wrote it for faux product UI on a marketing page: a `SKILL.md` with one idea,
five failure modes and a seven-step workflow; 15 references (`craft.md`, `framing.md`,
`motion.md`, `bento.md`, `verify.md`, `rehearse.md`, `review.md`, `teaching.md`,
`kit.md`, `looks.md`, `annotations.md`, `backgrounds.md`, `brands.md`,
`choreography.md`, `products.md`); a React kit of 42 components with their CSS; 69
example folders; nine bad-and-good teaching pairs; and 12 Node scripts that film a
running scene and print named faults. Read before this decision: `SKILL.md`,
`README.md`, `NOTICE.md`, `LICENSE`, all 15 references end to end, the header of every
script, and `browser.mjs`, `dev.mjs` and `film.mjs` in full. No script imports
`node:http`, `node:https`, `node:net` or `node:dns`; the only process the scripts
start is a local Vite or a local Chrome.

Three things forced choices rather than a plain install.

1. The repository's design docs already govern product UI, and `DESIGN.md` outranks
   every vendored skill. Stageshow's kit, tokens, default look and storytelling
   easings would be a second design system if applied literally to `apps/desktop`.
2. The root `.gitignore` ignores every `package-lock.json`, and Stageshow ships one.
   `skills-lock.json` hashes the whole folder. Measured: `git add -n` staged 371 of 372
   files, so the first fresh checkout would have failed `skills:verify`.
3. `AGENTS.md` forbids running a skill's scripts and installing packages to satisfy a
   skill. Stageshow's value for an illustration is its `film.mjs --gate`, which needs
   `npm install` (playwright-core, Vite) and a Chrome. Measured: a `node_modules`
   inside `.agents/skills/stageshow` makes `skills:verify` report DRIFT, because the
   hash walks every file; from a copy in `/tmp`, `npm install` adds 76 packages in 3 s
   from `registry.npmjs.org`, `npm run typecheck` and `npm run check:css` pass, and
   `film.mjs` exits with "Couldn't start Chrome" because the sandbox has none (gap G9
   in `engineering/sandbox-coverage-gaps.md`).

## Decision

Stageshow is binding for every change that touches any form of UI in any file, in two
modes, recorded in `engineering/design-skills.md` under `Stageshow on every UI touch`,
named in `apps/desktop/DESIGN.md` step 2 of the mandatory process, in `AGENTS.md`
(rules, Design work, Skills, UI design recon, the compressed index), in the baseline
checklist and in `.agents/PREFLIGHT.md`.

- Product mode, for the app, the preview, the native pills and the installer, takes the
  judgment and never the kit: `craft.md` in full, the `motion.md` sections on changing
  text and on things that appear and leave, the `verify.md` You see / You do table as
  the review checklist, `teaching.md` for diagnosis, and the film line names as rule
  ids even when judged by eye. Durations, curves, tokens, icons and headings stay as
  `DESIGN.md`, `styles/motion.ts` and `styles/` record them.
- Illustrated mode, for docs, marketing, README, prototypes and pull-request captures,
  takes the whole skill as written, with the kit copied into the host that renders
  the figure, tokens mapped from `apps/desktop/src/styles/`, both themes filmed, and
  `REHEARSAL.md` beside the figure.
- The trigger is the effect of the change, not its file type. `.tsx`, `.css`, `.rs`,
  `.html`, `.astro`, `.mdx`, `.svg`, `.md` with a screenshot, `.json` locale strings, a
  GIF on a PR: all in. A change that cannot be placed in the trigger table is in until
  the author says why it touches nothing a person sees.

Rejected: applying the kit inside `apps/desktop` (a second token system, and the kit
pins `lucide-react 0.468.0` against the app's `^0.544.0`); treating Stageshow as a
marketing-only skill (its `craft.md` and `verify.md` are generic interface judgment and
the human asked for every UI touch); hand-editing `verify-skills.mjs` to skip
`node_modules` (the hash would stop matching the shape `npx skills` writes).

Resolved conflicts, `DESIGN.md` winning each: the light default look, the two
storytelling curves, the `--ss-*` tokens, Lucide as the kit's icon source, the
"no real headings" rule for faux apps, and the kit's phone frames. The table is in
`engineering/design-skills.md`.

Execution limits: Stageshow's scripts are the second documented exception to the
no-scripts rule, beside `ui-capture`, and only from a `/tmp` copy with a local Chrome
via `CHROME_PATH`, against a local server. Never `npm install` inside the vendored
folder.

`.gitignore` gains `!.agents/skills/*/package-lock.json`, scoped to vendored skills so
the pnpm-only rule still holds everywhere else. The refresh procedure now ends with
`git status --short --ignored .agents/skills/<name>` expecting no `!!` line, which is
the check that would have caught this class for any future skill and any other root
ignore rule.

The `skills` CLI release that performed this install writes an `installMode: "copy"`
field into the lock entry. `verify-skills.mjs` ignores it. It stays as written.

## Consequences

Every UI diff now carries a Stageshow line in its report: mode, rule ids, frames or
states. A pull request that names Stageshow without those is incomplete under the
Delivery Gate item 10.

Illustrated work in the sandbox cannot end `rehearsal passed` until a Chromium
arrives (gap G9). Until then the gate is a stated hypothesis with the by-eye review in
its place, never a claimed pass.

The vendored folder is 3.2 MB and 372 files, the largest skill in the set. It is
content, not code the app runs; nothing imports it and no workspace glob includes it.
Anyone who runs `npm install` inside it will see `skills:verify` fail and the reason is
written in three places.

Open follow-up, not done here because it widens scope: `scripts/ci/verify-skills.mjs`
could run `git check-ignore` over each locked tree and fail on a swallowed file, which
would turn the refresh-procedure check into a gate. Proposed to the human in the
session that made this decision.
