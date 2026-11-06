import { describe, expect, it } from "vitest";
import SpecReporter from "@wdio/spec-reporter";
import LocalRunner from "@wdio/local-runner";
import { config } from "../webdriver/wdio.conf.js";

describe("WebdriverIO plugins", () => {
  it("loads the installed spec reporter in the worker config", () => {
    expect(config.reporters).toEqual([SpecReporter]);
    expect(typeof config.reporters[0]).toBe("function");
  });
  it("declares the local runner and can load its installed plugin", () => {
    expect(config.runner).toBe("local");
    expect(typeof LocalRunner).toBe("function");
    expect(typeof LocalRunner.prototype.run).toBe("function");
  });
});
