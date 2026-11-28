# Styling and Tokens

Fluent UI React v9 draws its visual consistency from a two-layer token model.
Styling that respects that model adapts to theme, contrast, and brand without
per-component overrides. This reference supports
[PAT-006 settings page](../patterns/PAT-006-settings-page.md) and any pattern
that renders chrome.

For the exact token names and the `makeStyles` signature, use the sibling
`fluentui` skill: [tokens](fluentui:references/tokens.md).

## The two-layer token model

There are two layers, and using the right one is the whole discipline
(RULE-017):

1. **Global tokens** hold raw values: a specific gray, a specific radius. They
   are the palette.
2. **Alias tokens** map a role to a palette value: a neutral background, a
   brand stroke, a subtle shadow. Components use these.

Style against alias tokens. A hard-coded color, spacing, or shadow bypasses the
theme, so it survives a theme switch as a visible bug. When no alias fits, the
answer is usually a design conversation, not a literal value.

## Type

Use the type ramp instead of ad-hoc font sizes (RULE-018). The ramp keeps
heading, body, and caption sizes consistent across pages, and it already
accounts for line height. A page that sets its own sizes drifts from every other
page the moment the theme changes.

## Motion

Respect reduced motion (RULE-019). When a user asks for less motion, replace an
animated transition with an instant change rather than a shorter animation.
Motion should explain a change — an overlay appearing, a row leaving — never
decorate it.

## Dark and high-contrast themes

Because alias tokens are resolved per theme, a design built from them works in
light, dark, and high-contrast themes without changes. Check the three states
that commonly break:

- A hard-coded white surface disappears in a light theme.
- A low-contrast border disappears against a dark surface.
- A custom shadow reads as a smudge in high contrast.

If a component genuinely needs a new role, add an alias in the theme rather than
a literal in the component.

## Layout spacing

Prefer the layout components and tokenized gaps over hand-set margins. A
consistent spacing scale is what makes two independently built pages look like
one application. When you must choose a value, choose the token closest to the
intent, and let the theme own it.

## Boundaries with the API skill

This reference explains which layer to use and why. It does not list token
names, the `makeStyles` options, or the theme shape — those are API facts and
belong to the sibling `fluentui` skill. Link them rather than copying them.

## Related references

- [Composition and state](composition-and-state.md) for where styling decisions
  live.
- [Responsive and localization](responsive-and-localization.md) for logical
  properties and reflow.
