/** Capture the list neighbours before a keyboard-confirmed deletion removes its row. */
export const prepareStyleDeleteFocus = (id: string) => {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !active.matches(":focus-visible"))
    return () => {};
  const row = [
    ...document.querySelectorAll<HTMLElement>("[data-manual-style-row]"),
  ].find((element) => element.dataset.manualStyleRow === id);
  const page = row?.closest<HTMLElement>("[data-scroll-list-page]");
  if (!row || !page) return () => {};
  const rows = [
    ...page.querySelectorAll<HTMLElement>("[data-manual-style-row]"),
  ];
  const index = rows.indexOf(row);
  const candidates = [
    ...rows.slice(index + 1),
    ...rows.slice(0, index).reverse(),
  ];
  return () =>
    requestAnimationFrame(() => {
      if (
        !page.isConnected ||
        row.isConnected ||
        (document.activeElement !== document.body &&
          document.activeElement !== active)
      )
        return;
      const target =
        candidates
          .filter((candidate) => candidate.isConnected)
          .map((candidate) =>
            candidate.querySelector<HTMLButtonElement>(
              "[data-manual-style-more]:not(:disabled)",
            ),
          )
          .find(Boolean) ??
        [
          ...page.querySelectorAll<HTMLButtonElement>(
            "[data-manual-style-add]:not(:disabled)",
          ),
        ].find((button) => !button.closest('[aria-hidden="true"]'));
      target?.focus();
    });
};
