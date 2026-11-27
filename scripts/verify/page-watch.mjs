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
 *   const { consoleErrors, failedRequests, unexpectedFailedRequests } =
 *     watchPage(page);
 *   await page.send("Network.enable");
 *
 * `Network.enable` stays with the caller, because a probe that enables it has
 * to do so before the navigation it wants to watch.
 */
const isSupersededNavigationCancel = (params, request, currentLoaderId) =>
  Boolean(
    params.canceled &&
    request?.loaderId &&
    currentLoaderId &&
    request.loaderId !== currentLoaderId,
  );

const toRequestRecord = (params) => ({
  loaderId: params.loaderId ?? null,
  url: params.request?.url ?? null,
  type: params.type ?? null,
});

const toFailureRecord = (params, request) => ({
  url: request?.url ?? null,
  type: params.type ?? request?.type ?? null,
  errorText: params.errorText,
  canceled: Boolean(params.canceled),
});

const isMainDocument = (params, mainFrameId) =>
  params.type === "Document" &&
  (!mainFrameId || params.frameId === mainFrameId);

export const watchPage = (page) => {
  const consoleErrors = [];
  page.on("Runtime.consoleAPICalled", (params) => {
    if (params.type !== "error") return;
    consoleErrors.push(
      params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "),
    );
  });

  const failedRequests = [];
  const unexpectedFailedRequests = [];
  const requests = new Map();
  let mainFrameId = null;
  let currentLoaderId = null;

  page.on("Page.frameNavigated", (params) => {
    if (params.frame?.parentId) return;
    mainFrameId = params.frame?.id ?? mainFrameId;
    currentLoaderId = params.frame?.loaderId ?? currentLoaderId;
  });

  page.on("Network.requestWillBeSent", (params) => {
    if (isMainDocument(params, mainFrameId) && params.loaderId) {
      mainFrameId = mainFrameId ?? params.frameId ?? null;
      currentLoaderId = params.loaderId;
    }
    requests.set(params.requestId, toRequestRecord(params));
  });

  page.on("Network.loadingFinished", (params) => {
    requests.delete(params.requestId);
  });

  page.on("Network.loadingFailed", (params) => {
    const request = requests.get(params.requestId);
    requests.delete(params.requestId);
    failedRequests.push(params.errorText);
    if (isSupersededNavigationCancel(params, request, currentLoaderId)) return;
    unexpectedFailedRequests.push(toFailureRecord(params, request));
  });

  return { consoleErrors, failedRequests, unexpectedFailedRequests };
};
