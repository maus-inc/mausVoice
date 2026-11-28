import { browser } from "@wdio/globals";

describe("mausVoice desktop bootstrap", () => {
  it("renders a routed page, not just the bootstrap loader", async () => {
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const path = location.pathname;
          let selector: string;
          if (path === "/dashboard") {
            selector = '#root nav [aria-current="page"]';
          } else if (path === "/welcome" || path === "/onboarding") {
            // On a fresh profile Continue is disabled until a name is entered.
            // Neither the title bar nor the crash fallback is the routed main.
            selector =
              '#root main :is(button, input[autocomplete="given-name"]):enabled';
          } else return false;
          return [...document.querySelectorAll(selector)].some(
            (control) =>
              control.getClientRects().length > 0 &&
              getComputedStyle(control).visibility === "visible",
          );
        }),
      {
        timeout: 15_000,
        timeoutMsg: "No dashboard navigation or entry-page control appeared",
      },
    );
  });
});
