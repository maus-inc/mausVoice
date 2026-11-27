# Settings heading alignment research

## Question

Should a settings group heading align with the card edge or with the row label column inside the card?

## Findings

- [Material 3 structure](https://m3.material.io/foundations/designing/structure) treats headings and landmarks as content hierarchy. Screen-reader order follows document structure, while visual cues should make that hierarchy clear. A group heading names the group, not the label column of its first row.
- [Material 3 card guidance](https://m3.material.io/components/cards/guidelines) says cards group one topic, and their content should establish a clear hierarchy. It also cautions against forcing content into cards when spacing, headlines, or dividers make the hierarchy simpler. Where a card is used, the heading belongs to the group it names.
- [Apple's tables guidance](https://developer.apple.com/design/human-interface-guidelines/ios/views/tables/) describes grouped tables as related sections with headers. Inset-grouped UIKit examples can align a header with cell text when cells have no leading icon. That is not this row anatomy: settings rows reserve a leading slot, so copying the text-column alignment would make the group title look like a row label.
- [Carbon tile guidance](https://v10.carbondesignsystem.com/components/tile/usage/) recommends left alignment for tile content. [Carbon content-switcher guidance](https://www.carbondesignsystem.com/building-blocks/core/components/content-switcher/guidelines) says to use the content grid or gutter, and not to flush a control to a container edge. Those rules concern tile content and switchers, not section headings, so they support a consistent container grid but do not prescribe heading alignment here.
- [Scottish Enterprise's heading guidance](https://scotent-live-designsystem-website.azurewebsites.net/system-guidelines/text-styles-and-formatting/headings) says headings inside a component follow that component's alignment. This is corroborating guidance, not a platform standard.
- The real-world examples reviewed include [GitHub maxxer PR 7](https://github.com/ethanyxchen/github-maxxer/pull/7), [IncarnaMind issue 2732](https://github.com/IncarnaMind/IncarnaMind/issues/2732), and [brightboi issue 87](https://github.com/joaodavidsilva/brightboi/issues/87). Their settings headings sit above the rounded group at its outer edge. [Teamrun PR 643](https://github.com/noldova-com/teamrun/pull/643) moves group titles to the row-label column and is the counterexample the user rejected.

## Decision

**Design Read:** Settings for desktop MausVoice operators, in the established restrained Operate style. ENERGY 1 / RHYTHM 1 / MOTION 1. This change preserves the existing calm hierarchy and card rhythm.

Keep each group heading and its description above the card at the card's left edge. Keep row labels in their existing leading-slot grid. The heading's semantic job is to name the whole group; aligning it to one row's label column makes it read as paragraph text and weakens that hierarchy. Keep the existing vertical placement above the card. Do not change the row's leading slot or the card's internal padding.

## Applied change

Removed the `leadsWith` heading-offset API and the shared heading-inset helpers. The heading row and description now use their natural outer alignment. Updated tests to protect the card-edge alignment and removed the stale search-results test that encoded the old label-column inset.
