/** Capture nearby controls before the row is removed; resolve the restored row
 * only after React has committed an Undo. Never move focus if the user has
 * already moved it elsewhere in the meantime. */
export const captureHistoryDeleteFocus = (id: string) => {
  const main = document.querySelector<HTMLElement>("main");
  const rows = [
    ...(main?.querySelectorAll<HTMLElement>("[data-transcription-row]") ?? []),
  ];
  const index = rows.findIndex((row) => row.dataset.transcriptionRow === id);
  const neighbours = [rows[index + 1], rows[index - 1]].filter(Boolean);
  const focusOnShow =
    document.activeElement instanceof HTMLElement &&
    document.activeElement.matches(":focus-visible");
  const returnFocus = (undone: boolean) => {
    const previousFocus = document.activeElement;
    requestAnimationFrame(() => {
      if (
        document.activeElement !== previousFocus &&
        document.activeElement !== document.body
      )
        return;
      if (!main?.isConnected) return;
      const restored = undone
        ? [
            ...main.querySelectorAll<HTMLElement>("[data-transcription-row]"),
          ].find((row) => row.dataset.transcriptionRow === id)
        : undefined;
      const candidates = [restored, ...neighbours];
      const button = candidates.flatMap((row) =>
        row?.isConnected
          ? [
              ...row.querySelectorAll<HTMLButtonElement>(
                "button:not(:disabled)",
              ),
            ]
          : [],
      )[0];
      const target = button ?? main.querySelector<HTMLElement>("h1") ?? main;
      if (!button) target.tabIndex = -1;
      target.focus();
    });
  };
  return { focusOnShow, returnFocus };
};
