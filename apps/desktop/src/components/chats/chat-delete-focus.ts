/** Capture the visible neighbours before an asynchronous keyboard deletion. */
export const prepareChatDeleteFocus = (
  list: HTMLElement | null,
  id: string,
) => {
  const active = document.activeElement;
  const rows = [
    ...(list?.querySelectorAll<HTMLElement>("[data-conversation-row]") ?? []),
  ];
  const index = rows.findIndex((row) => row.dataset.conversationRow === id);
  if (
    !(active instanceof HTMLElement) ||
    !active.matches(":focus-visible") ||
    index < 0
  )
    return () => {};
  const removed = rows[index];
  const candidates = [
    ...rows.slice(index + 1),
    ...rows.slice(0, index).reverse(),
  ];
  return () =>
    requestAnimationFrame(() => {
      if (
        !list?.isConnected ||
        (document.activeElement !== document.body &&
          document.activeElement !== active &&
          !removed.contains(document.activeElement))
      )
        return;
      const target =
        candidates
          .filter((row) => row.isConnected)
          .map((row) =>
            row.querySelector<HTMLElement>("[data-conversation-select]"),
          )
          .find(Boolean) ??
        list.querySelector<HTMLElement>("[data-conversation-new]");
      target?.focus();
    });
};
