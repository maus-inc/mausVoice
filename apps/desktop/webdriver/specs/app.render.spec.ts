import { browser, expect } from "@wdio/globals";

describe("mausVoice desktop bootstrap", () => {
  it("renders the application shell", async () => {
    const root = await browser.$("#root");
    await root.waitForExist({ timeout: 15000 });

    // The real app paints its first content after the local data bootstrap;
    // wait for the shell instead of sampling one frame.
    await browser.waitUntil(
      async () => {
        const children = await root.$$(":scope > *");
        return (await children.length) > 0;
      },
      { timeout: 15000 },
    );

    const progressIndicator = await browser.$('[role="progressbar"]');
    if (await progressIndicator.isExisting()) {
      expect(await progressIndicator.isDisplayed()).toBe(true);
    }
  });
});
