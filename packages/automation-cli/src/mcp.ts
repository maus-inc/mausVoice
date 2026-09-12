import { createInterface } from "node:readline";

export const listTools = (): McpToolDefinition[] => definitions;

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_SERVER_NAME = "mausvoice-automation";
export const MCP_SERVER_VERSION = "0.1.0";

export type McpContent = {
  type: "text";
  text: string;
};

export type McpToolResult = {
  content: McpContent[];
  isError?: boolean;
};

export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpDeps = {
  callApi: (path: string) => Promise<unknown>;
};

const asText = (value: unknown): McpToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

const errText = (message: string): McpToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

const definitions: McpToolDefinition[] = [
  {
    name: "get_status",
    description: "Automation API status and uptime.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_meetings",
    description: "List recent meetings (id, title, status, timestamps).",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", minimum: 1, maximum: 100 } },
    },
  },
  {
    name: "search_meetings",
    description: "Search meetings by title and transcript text.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        limit: { type: "number", minimum: 1, maximum: 100 },
      },
      required: ["query"],
    },
  },
];

const readLimit = (args: Record<string, unknown>): number => {
  const limit = args["limit"];
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
    return 20;
  }
  return Math.min(limit, 100);
};

export const serveMcp = async (deps: McpDeps): Promise<void> => {
  const write = (line: string): void => {
    process.stdout.write(line);
  };
  await new Promise<void>((resolve) => {
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line: string) => {
      if (!line.trim()) {
        return;
      }
      handleMessage(deps, line, write).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
      });
    });
    rl.on("close", () => {
      resolve();
    });
  });
};

export const callTool = async (
  deps: McpDeps,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> => {
  try {
    if (name === "get_status") {
      return asText(await deps.callApi("/api/v1/status"));
    }
    if (name === "list_meetings") {
      return asText(
        await deps.callApi(`/api/v1/meetings?limit=${readLimit(args)}`),
      );
    }
    if (name === "search_meetings") {
      const query = args["query"];
      if (typeof query !== "string" || !query) {
        return errText("Missing required argument: query");
      }
      return asText(
        await deps.callApi(
          `/api/v1/meetings/search?q=${encodeURIComponent(query)}&limit=${readLimit(args)}`,
        ),
      );
    }
    return errText(`Unknown tool: ${name}`);
  } catch (error) {
    return errText(error instanceof Error ? error.message : String(error));
  }
};

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
  };
};

const respond = (
  write: (line: string) => void,
  id: string | number | null | undefined,
  result: unknown,
): void => {
  if (id === undefined || id === null) {
    return;
  }
  write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
};

export const handleMessage = async (
  deps: McpDeps,
  raw: string,
  write: (line: string) => void,
): Promise<void> => {
  let message: JsonRpcRequest;
  try {
    message = JSON.parse(raw) as JsonRpcRequest;
  } catch {
    return;
  }
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return;
  }
  if (message.method === "initialize") {
    respond(write, message.id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    });
    return;
  }
  if (message.method === "ping") {
    respond(write, message.id, {});
    return;
  }
  if (message.method === "tools/list") {
    respond(write, message.id, { tools: listTools() });
    return;
  }
  if (message.method === "tools/call") {
    const result = await callTool(
      deps,
      message.params?.name ?? "",
      message.params?.arguments ?? {},
    );
    respond(write, message.id, result);
    return;
  }
  if (message.id !== undefined && message.id !== null) {
    respond(write, message.id, {
      content: [{ type: "text", text: `Unknown method: ${message.method}` }],
      isError: true,
    });
  }
};
