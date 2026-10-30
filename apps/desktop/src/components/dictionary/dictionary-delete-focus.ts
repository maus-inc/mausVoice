/** Return keyboard focus to an adjacent removable term, or Add for an empty list. */
export const focusAfterDictionaryDelete = (id: string) => {
  const main = document.querySelector<HTMLElement>("main");
  const rows = [
    ...(main?.querySelectorAll<HTMLElement>("[data-dictionary-row]") ?? []),
  ];
  const index = rows.findIndex((row) => row.dataset.dictionaryRow === id);
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !active.matches(":focus-visible"))
    return;
  const candidates = [
    ...rows.slice(index + 1),
    ...rows.slice(0, index).reverse(),
  ];
  requestAnimationFrame(() => {
    if (
      !main?.isConnected ||
      (document.activeElement !== active &&
        document.activeElement !== document.body)
    )
      return;
    const target =
      candidates.flatMap((row) =>
        row.isConnected
          ? [
              ...row.querySelectorAll<HTMLButtonElement>(
                "[data-dictionary-delete]:not(:disabled)",
              ),
            ]
          : [],
      )[0] ??
      main.querySelector<HTMLButtonElement>(
        "[data-dictionary-add]:not(:disabled)",
      );
    target?.focus();
  });
};
