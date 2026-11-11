# Contributing

## Read This First

We are not actively accepting contributions right now.

You can still open an issue or PR, but please do so knowing there is a high chance we close it, defer it forever, or never look at it.

If that sounds annoying, that is because it is. This project is still early and we are trying to keep scope, quality, and direction under control.

## What We Are Most Likely To Accept

Small, focused bug fixes.

Small reliability fixes.

Small performance improvements.

Tightly scoped maintenance work that clearly improves the project without changing its direction.

## What We Are Least Likely To Accept

Large PRs.

Drive-by feature work.

Opinionated rewrites.

Anything that expands product scope without us asking for it first.

If you open a 1,000+ line PR full of new features, we will probably close it quickly and remember that you ignored the clearly written instructions.

## If You Still Want To Open A PR

Keep it small.

Explain exactly what changed.

Explain exactly why the change should exist.

Do not mix unrelated fixes together.

If the PR makes anything resembling a UI change, include clear before/after images.

If the change depends on motion, timing, transitions, or interaction details, include a short video.

If we have to guess what changed, we are much less likely to review it.

## Commit and Pull Request Conventions

Commit subjects use `area: what changed`, with the areas and examples in `COMMIT.md`. The
`commit-msg` job in `lefthook.yml` enforces the shape, and `.gitmessage` is the template git
shows you. Turn it on with:

```bash
git config commit.template .gitmessage
npx lefthook@2.2.2 install   # pinned; lefthook stays out of the manifest so installs stay light
```

The hooks are a convenience, not a gate. `lefthook` is deliberately not a repository
dependency, so every `pnpm install` in CI stays small. Pin the version when you run it, as
above, so onboarding never executes an unreviewed future release.

A branch carries the current tip of its base the whole time it is open. Bring the base in by
merge, `git fetch origin <base>` and then `git merge FETCH_HEAD`, before the first edit, before
every push and before opening the pull request, never by rebase or force-push once the branch is
pushed. Read what each merge brought in, and run the gates on the merged tree. The pull request
names the base tip the head contains. After a merge the maintainer confirmed, the head branch is
deleted. `AGENTS.md` holds the full rule under "Keep the branch current with its base".

Pull requests fill `.github/pull_request_template.md`, and `pnpm run check:pr-body -- <file>` checks the
shape of the body. Every record of a review round, a babysit poll or a CI log goes inside a
collapsible block, so a long-running PR stays one screen of summary. The `PR Body Fold Check`
workflow runs that command on every pull request open, edit, reopen and push. The check judges the
authored body and stops at the footer line; review bots append their summaries below the footer,
and that text is exempt from every rule except the duplicate-footer count. Every section is used, including the
verification gate with the head SHA, and a section is never deleted to avoid answering it. A UI
change either carries a recording of the change or says which surface was inspected in
`apps/preview` and what that inspection showed.

Bugs and feature requests use the issue forms in `.github/ISSUE_TEMPLATE/`. The bug form asks
for the model, the platform and the log, because a dictation bug without those three cannot be
reproduced.

## Issues First

If you are thinking about a non-trivial change, open an issue first.

That still does not mean we will want the PR, but it gives you a chance to avoid wasting your time.

## Be Realistic

Opening a PR does not create an obligation on our side.

We may close it. We may ignore it. We may ask you to shrink it. We may reimplement the idea ourselves later.

If you are fine with that, proceed.
