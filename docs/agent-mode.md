# Agent mode

> Maintained page: [Assistant mode](https://maus-inc.github.io/mausVoice/docs/using-mausvoice/assistant-mode/). The loop lives in **`@repo/agent`**.

Agent tools are registered in one declarative registry. The Assistant Mode settings panel can enable or disable each registered tool and set a maximum iteration count. Permission prompts expire after the configured timeout, and long conversations keep the initial request plus the newest exchanges to avoid exhausting the model context window.
