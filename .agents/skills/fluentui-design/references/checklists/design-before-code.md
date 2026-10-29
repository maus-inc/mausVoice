# Design Before Code

Answer these questions before writing components. Each one has a home in a
pattern or foundation reference; unresolved questions become rework.

## 1. Name the task

Write the user task in one sentence, in the user's words. If the sentence needs
"and", the task is probably two tasks and should split.

## 2. Choose the surface

Pick a page, a drawer, a dialog, or an inline edit, and say why the others are
worse. A page owns a URL and survives a refresh. A drawer keeps list context. A
dialog interrupts for one small decision. See
[PAT-004 form page](../patterns/PAT-004-form-page.md) and
[PAT-005 contextual edit](../patterns/PAT-005-contextual-edit.md).

## 3. List the regions

List the page regions in reading order: header, command bar, filters, content,
details. Each pattern names its regions and their order.

## 4. Decide state ownership

Decide who owns the draft, the selection, and the open overlay, using
[composition-and-state](../foundation/composition-and-state.md). Lift state only
to the lowest common owner.

## 5. Decide the save model

Choose explicit save, immediate apply, or a hybrid, and state the feedback for
each outcome. Guard unsaved changes before they can be lost (RULE-029) and
prevent duplicate submission (RULE-030).

## 6. Decide the four states

Design loading, empty, search-empty, and error explicitly (RULE-016). Decide
where each appears inside the regions you listed.

## 7. Decide the collapse and the permission state

Decide how the layout reflows at a narrow width (RULE-023) and what a user
without permission sees. A hidden action and a disabled action are different
designs; choose deliberately.

## 8. Confirm the accessibility path

For every action, confirm the keyboard path, the accessible name, and the
announcement of its result. Run
[accessibility-review](accessibility-review.md) as the design exit check.

When all eight are answered, the design is ready to implement.
