import { createAnthropicGenerateTests } from "../src/test-helpers/shared-anthropic-generate.helper";

createAnthropicGenerateTests({
  describeName: "claudeGenerateTextResponse",
  loadModule: async () => {
    const mod = await import("../src/claude.utils");
    return mod;
  },
  functionName: "claudeGenerateTextResponse",
  defaultMaxTokens: 1024,
  forwardedMaxTokens: 600,
});
