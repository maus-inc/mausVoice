export {
  type AutomationConnection,
  type ConnectionOptions,
  connectionFilePath,
  resolveConnection,
} from "./connection.js";
export { AutomationApiError, apiGet } from "./client.js";
export {
  type McpDeps,
  type McpToolDefinition,
  type McpToolResult,
  callTool,
  handleMessage,
  listTools,
  serveMcp,
} from "./mcp.js";
export { run } from "./cli.js";
