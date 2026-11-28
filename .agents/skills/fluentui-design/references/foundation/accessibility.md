# Accessibility

Accessibility is a property of the composition, not a checklist applied at the
end. This reference explains the reasoning every pattern shares. For exact ARIA
attributes and component props, use the sibling `fluentui` skill:
[Dialog](fluentui:references/components/dialog.md).

## Keyboard first

Every action must be reachable and operable from the keyboard, in an order that
follows the visual order. Test the path before shipping: open a surface, move
through its actions, and close it without reaching for a pointer. A component
that only works under a mouse is not finished.

## Focus

Keep focus visible and never obscure the focused control (RULE-020). Focus is
the user's position in the page, so moving it without cause loses their place.
The rules that matter most:

- Opening an overlay moves focus into it; closing it returns focus to the
  trigger.
- Removing an item moves focus to a sensible neighbour, not to the top of the
  page.
- A route change moves focus to the new page heading.

Follow the composite-widget keyboard model for grids, menus, and tabs
(RULE-021): one tab stop enters the widget and arrow keys move within it.

## Names, roles, and instructions

Provide names, roles, and instructions for non-text content (RULE-022). An icon
button needs an accessible name. A form field needs a programmatic label, not
only a nearby visual one (RULE-005). An unfamiliar control needs an instruction
that a screen reader can reach.

## Announce asynchronous results

A change that is drawn but not announced is invisible to a screen reader. When a
save completes, a filter reduces the result count, or a submission fails, expose
the result through a live region or a status message (RULE-016). The feedback
channel is a design decision; the announcement is the accessibility obligation.

## Overlays

An overlay traps focus while it is open, is dismissible by Escape, and returns
focus on close. Dialog suits a short, focused decision (RULE-008); a drawer
suits a longer contextual edit (RULE-009). Both must behave the same way for the
keyboard user.

## Contrast, motion, zoom, and reflow

- Check text and non-text contrast in light, dark, and high-contrast themes.
- Respect reduced motion (RULE-019).
- Ensure the layout survives zoom and a narrow viewport by reflowing rather than
  clipping (RULE-023).
- Give truncated content an accessible full value (RULE-025).

## Review

Use [checklists/accessibility-review.md](../checklists/accessibility-review.md)
for the focused pass. It lists the states to exercise, including the ones that
are easy to forget: empty, loading, error, and permission-denied.

## Related references

- [Responsive and localization](responsive-and-localization.md) for reflow and
  direction.
- [Composition and state](composition-and-state.md) for focus ownership across
  regions.
