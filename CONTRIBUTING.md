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
lefthook install
```

Pull requests fill `.github/pull_request_template.md`. Every section is used, including the
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
