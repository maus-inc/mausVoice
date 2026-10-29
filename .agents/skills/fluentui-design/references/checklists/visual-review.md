# Visual Review

Run this pass at two widths, in light and dark, before calling a page done.
Visual coherence is what makes independently built pages look like one product.

## Layout

- Regions appear in the order the design lists them.
- Spacing uses the token scale, not hand-set values.
- Alignment is consistent between the header, the content, and the actions.
- The page does not scroll horizontally at the narrow width.

## Typography

- Headings use the type ramp (RULE-018), with one heading per page that names
  its task (RULE-003).
- Body text and captions are legible in both themes.

## Color and theme

- Surfaces and text come from alias tokens, not hard-coded values (RULE-017).
- The page is correct in light, dark, and high-contrast themes.
- Emphasis uses one accent consistently, not several competing colors.

## Commands and states

- One primary action is visually dominant; the rest sit in a toolbar (RULE-004).
- Disabled, loading, empty, search-empty, and error states all look intentional.
- A pending action shows progress and prevents a second submission (RULE-030).

## Motion

- Transitions explain a change and are subtle.
- Reduced motion removes animation rather than shortening it (RULE-019).

## Direction and content

- The layout mirrors correctly under right-to-left direction (RULE-024).
- Long values wrap or truncate deliberately, and truncated values stay
  reachable (RULE-025).
- Translated text has room to grow.

See [styling and tokens](../foundation/styling-and-tokens.md) and
[responsive and localization](../foundation/responsive-and-localization.md) for
the reasoning behind each check.
