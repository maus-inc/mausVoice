/**
 * Collects what a driven page reported while it was being measured.
 *
 * A probe that navigates a page has to say whether the page was quiet: a
 * console error or a failed request is the difference between a layout that
 * renders and one that renders half of itself. The collection is the same in
 * every probe, so it lives here rather than being copied into each one.
 *
 * Usage:
 *
 *   const { consoleErrors, failedRequests } = watchPage(page);
 *   await page.send("Network.enable");
 *
 * `Network.enable` stays with the caller, because a probe that enables it has
 * to do so before the navigation it wants to watch.
 */
export const watchPage = (page) => {
  const consoleErrors = [];
  page.on("Runtime.consoleAPICalled", (params) => {
    if (params.type !== "error") return;
    consoleErrors.push(
      params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "),
    );
  });

  const failedRequests = [];
  page.on("Network.loadingFailed", (params) =>
    failedRequests.push(params.errorText),
  );

  return { consoleErrors, failedRequests };
};
