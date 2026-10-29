---
id: PAT-005
title: Short contextual edit in a drawer or focused dialog
decisions: [edit-surface, modal-behavior]
rules: [RULE-008, RULE-009, RULE-029]
components: [Drawer, DrawerBody, DrawerHeader, DrawerHeaderTitle, DrawerFooter, Dialog, DialogTrigger, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, Button, Field, Input]
derived: [application-owned edit-surface selector, application-owned dirty-state guard]
---

# Short contextual edit in a drawer or focused dialog

## User task

Change a small amount of information without leaving the page they are working on.

## When to use / when not

Use a dialog for a short, bounded decision or a two-field edit that benefits from full attention.
Use a drawer for a slightly larger contextual edit that should keep the underlying list or record
visible. Do not use either for a long multi-section form; that belongs on the form page.

## Region order

1. Surface title naming the object being edited.
2. Editable fields.
3. Primary save action and a secondary cancel action.
4. Confirmation when the surface closes with unsaved changes.

## Component mapping

Drawer and its parts, Dialog and its parts, Button, Field, and Input are verified exports. The rule
that selects between drawer and dialog, the dirty-state guard, and the save call are application-
owned. Fetching the edited record and persisting the change are application responsibilities.

## Interaction flow

A trigger control opens the surface with the current values. The user edits fields; the primary
action saves and closes on success. Attempting to dismiss with unsaved changes opens a confirmation
with Keep editing and Discard. On close, focus returns to the control that opened the surface.

## State ownership

The application owns open state, the draft value, dirty state, and the pending save. The surface
owns only local presentation such as open animation.

## Responsive behavior

At the project's narrow breakpoint a drawer may occupy the full width and a dialog fits the viewport
with scrolling content. Neither may push its action buttons out of reach.

## Accessibility

Each surface has a title, traps focus while open, and returns focus to its trigger on close. The
confirmation is itself a dialog with a title. Escape closes the surface only when the dismissal will
not silently lose work.

## Edge cases

A save failure keeps the surface open, preserves the draft, and shows the error inside the surface.
A record deleted in another session is reported on save rather than overwriting. A very small
viewport keeps the primary action reachable and the content scrollable.

## Rules applied

RULE-008, RULE-009, RULE-029

## Derived decisions

The drawer-versus-dialog choice and the dirty-state guard are application decisions. Persistence and
fetching are application responsibilities. Server-side validation is mandatory; client-side
validation is advisory only.

## Tests

Fixture drawer open/close test, return-focus test, dirty-guard test, and a save-failure test.
