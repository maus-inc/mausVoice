import { describe, expect, it } from "vitest";
import {
  callTool,
  handleMessage,
  listTools,
  MCP_PROTOCOL_VERSION,
} from "./mcp";

const deps = {
  callApi: async (path: string) => ({ path }),
};

describe("listTools", () => {
  it("exposes only read-only meeting tools", () => {
    expect(
      listTools()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["get_status", "list_meetings", "search_meetings"]);
  });
});

describe("callTool", () => {
  it("routes get_status to the status endpoint", async () => {
    const result = await callTool(deps, "get_status", {});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("/api/v1/status");
  });

  it("clamps the list limit", async () => {
    const result = await callTool(deps, "list_meetings", { limit: 9999 });
    expect(result.content[0].text).toContain("limit=100");
  });

  it("requires a query for search", async () => {
    const result = await callTool(deps, "search_meetings", {});
    expect(result.isError).toBe(true);
  });

  it("rejects unknown tools", async () => {
    const result = await callTool(deps, "drop_tables", {});
    expect(result.isError).toBe(true);
  });

  it("surfaces API failures as tool errors", async () => {
    const result = await callTool(
      {
        callApi: async () => {
          throw new Error("refused");
        },
      },
      "get_status",
      {},
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("refused");
  });
});

describe("handleMessage", () => {
  type RpcReply = {
    id?: string | number | null;
    result?: {
      protocolVersion?: string;
      tools?: Array<{ name: string }>;
      isError?: boolean;
    };
  };
  const collect = async (lines: string[]): Promise<RpcReply[]> => {
    const out: string[] = [];
    for (const line of lines) {
      await handleMessage(deps, line, (l) => out.push(l));
    }
    return out.map((l) => JSON.parse(l) as RpcReply);
  };

  it("answers initialize with the protocol version", async () => {
    const [reply] = await collect([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    ]);
    expect(reply.id).toBe(1);
    expect(reply.result?.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });

  it("lists tools and calls one", async () => {
    const [listed, called] = await collect([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_status", arguments: {} },
      }),
    ]);
    expect(listed.result?.tools).toHaveLength(3);
    expect(called.result?.isError).toBeUndefined();
  });

  it("stays silent on notifications and garbage", async () => {
    const out: string[] = [];
    await handleMessage(
      deps,
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      (l) => out.push(l),
    );
    await handleMessage(deps, "not json", (l) => out.push(l));
    expect(out).toEqual([]);
  });
});
