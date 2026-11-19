<!-- GENERATED FILE — DO NOT EDIT; source: rules/rules.json -->

# Rule Index

Rules grouped by decision area. Each rule is operational: it states what to do,
when it applies, and where its evidence comes from. Full provenance lives in
`rules/rules.json`.

## app-shell

| Rule | Strength | Instruction |
| --- | --- | --- |
| RULE-001 | should | Compose the whole application inside a FluentProvider and build the shell navigation yourself from Nav, Toolbar, and layout primitives, because v9 exports no shell component. |
| RULE-002 | should | Render the primary destinations with Nav and its item parts, and render the current position with Breadcrumb, because routing itself stays application-owned. |

## page-chrome

| Rule | Strength | Instruction |
| --- | --- | --- |
| RULE-003 | must | Place a single top-level heading that names the screen's task at the start of the content region, and use lower heading levels only for structure beneath it. |
| RULE-004 | should | Reserve one visually primary action for the screen and place additional page commands in a Toolbar, moving overflow actions into a menu. |

## composition

| Rule | Strength | Instruction |
| --- | --- | --- |
| RULE-026 | must | Wrap the application in a single FluentProvider that sets the theme and text direction, and let nested providers be exceptions rather than the rule. |
| RULE-027 | must | Own routing, data fetching, authorization, and persistence in application code, and use Fluent components only for presentation and local interaction state. |
| RULE-028 | should | Style Fluent components with makeStyles and compose their public slots, rather than depending on internal class names or undocumented DOM structure. |

## task-flows

| Rule | Strength | Instruction |
| --- | --- | --- |
| RULE-029 | must | Track dirty state and confirm before discarding unsaved changes when the user closes, navigates away from, or switches context in the editor. |
| RULE-030 | must | Disable the submit action while a request is pending, show progress in place, and re-enable the action when the request settles. |

## forms

| Rule | Strength | Instruction |
| --- | --- | --- |
| RULE-005 | must | Wrap each control in a Field that provides a visible label, and place help or error text through the Field's message slot rather than beside it. |
| RULE-006 | should | Show a field error after the user leaves the field or submits the form, and never before the user has entered a value, so the form does not scold an untouched field. |
| RULE-007 | should | Lay fields out in one column by default and group related fields under a shared heading, because a single reading path is easier to follow and to complete. |
| RULE-037 | should | Choose Input or Textarea for free-form text, RadioGroup for a small exclusive set, Select for a short fixed list, Combobox or Dropdown for a long or searchable list, Checkbox for a submitted boolean, Switch for an immediate on/off, and SpinButton for a bounded numeric quantity. |
| RULE-038 | must | Use a Switch only when the change takes effect immediately, and use a Checkbox for a value submitted with the form; give a parent Checkbox an indeterminate state when it controls a partially selected group. |
| RULE-039 | should | Prefer a native Select for a short, fixed list of options, and choose Combobox or Dropdown when the list is long, must be searched or typed into, or needs custom option content. |
| RULE-040 | must | Provide a plain-text value for every Dropdown or Combobox option whose visible content is complex or composed, so the closed field and type-ahead matching use the text. |
| RULE-041 | should | Prefer an inline option popup that follows the trigger in the DOM so assistive navigation reaches the list where aria-owns is unsupported. |
| RULE-042 | should | Set the minimum and maximum on a bounded numeric input, choose a step that divides the range, set the larger page step as a multiple, and parse a formatted display value back to a number. |

## data-grid

| Rule | Strength | Instruction |
| --- | --- | --- |
| RULE-010 | should | Use DataGrid when the layout must be controlled by column definitions and keyboard grid behavior is required, and use Table when a native table structure is the goal. |
| RULE-011 | should | Decide explicitly whether each collection operation runs on loaded rows or on the server, and pass the resulting state into the grid so the component does not imply a data source it does not have. |
| RULE-012 | must | Make the selection scope explicit to the user, and when a bulk action can apply to all matching results rather than only the loaded page, offer that choice deliberately. |
| RULE-031 | must | Provide a compare function in every column definition whose header is meant to sort; a column without compare stays unsortable even when the grid enables sorting. |
| RULE-032 | must | Set focusMode group on a cell with several focusable elements so Enter enters the cell and Escape returns to it, and set focusMode none on a cell with exactly one focusable element so that control receives focus directly. |
| RULE-033 | must | Keep a sortable header cell free of nested focusable controls; move header actions into a context menu or into the body cells instead. |
| RULE-034 | should | Use resizableColumns only inside a container that allows horizontal overflow, provide the column sizing options, and keep keyboard resizing available; do not let resizing push the page into two-dimensional scrolling. |
| RULE-035 | must | Keep the row render function stable with useCallback and a stable row key before enabling virtualization. |
| RULE-036 | must | Provide an aria-label through the selection cell for both the header select-all control and each row control, naming the action and, for the header, the selection scope. |

## overlays

| Rule | Strength | Instruction |
| --- | --- | --- |
| RULE-008 | should | Place a short, self-contained decision in a Dialog with a title and explicit action buttons, so the interaction stays bounded and easy to dismiss. |
| RULE-009 | should | Use a Drawer for a contextual edit that keeps the underlying context visible, and confirm before discarding unsaved changes when the drawer closes. |

## disclosure

| Rule | Strength | Instruction |
| --- | --- | --- |
| RULE-013 | must | Keep fields that the task requires visible or clearly summarized, and reserve collapsed sections for genuinely optional or advanced content. |
| RULE-014 | should | Use TabList to switch between peer views of the same record, and keep sequential task steps out of tabs so users are not misled about order. |

## feedback

| Rule | Strength | Instruction |
| --- | --- | --- |
| RULE-015 | should | Place conditions the user must be able to read later in a MessageBar, and place short-lived confirmations in a Toast, because the two differ in persistence and urgency. |
| RULE-016 | must | Provide a distinct state for loading, for genuinely empty data, for an empty search result, and for a failed load, so the user can tell the difference and knows what to do next. |

## responsive

| Rule | Strength | Instruction |
| --- | --- | --- |
| RULE-023 | must | Let content reflow into a single column and scroll vertically so nothing is lost, rather than clipping or forcing two-dimensional scrolling. |
| RULE-024 | should | Express margins, padding, and alignment with logical properties and set the provider direction, so the layout mirrors without a separate stylesheet. |
| RULE-025 | should | Let long values wrap where space allows and truncate with an accessible full value where it does not, so hidden text stays available. |

## accessibility

| Rule | Strength | Instruction |
| --- | --- | --- |
| RULE-020 | must | Preserve a visible focus indicator on every interactive element and ensure sticky or overlaying regions never cover the focused control. |
| RULE-021 | must | Give composite widgets a single tab stop and arrow-key movement within it, and ensure nested action controls are reachable without conflicting with row activation. |
| RULE-022 | must | Give every meaningful icon or color-coded control a programmatic name and an instruction where needed, and hide purely decorative icons from assistive technology. |

## theming

| Rule | Strength | Instruction |
| --- | --- | --- |
| RULE-017 | must | Reference Fluent tokens through makeStyles instead of hard-coding colors, spacing, or font values, so a theme change flows through the whole app. |
| RULE-018 | should | Assign text a role from the Fluent type ramp and let the role determine size, weight, and line height, rather than setting font sizes per screen. |
| RULE-019 | must | Honor the user's reduced-motion preference and keep transitions short and purposeful, because motion that cannot be suppressed can cause discomfort. |
