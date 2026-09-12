import { apiGet, AutomationApiError } from "./client.js";
import {
  type AutomationConnection,
  connectionFilePath,
  resolveConnection,
} from "./connection.js";

type GlobalOptions = {
  port?: number;
  token?: string;
  configFile?: string;
};

const usage = (): string =>
  [
    "mausvoice-api [--port N] [--token T] [--config-file PATH] <command>",
    "",
    "Commands:",
    "  status                  API status and uptime",
    "  meetings [--limit N]    List recent meetings",
    "  search <query> [--limit N]  Search meetings by title/transcript",
    "  connection              Show the resolved connection file path",
    "  mcp                   Start the read-only MCP server on stdio",
    "",
    "Auth: --token, MAUSVOICE_AUTOMATION_TOKEN, or the connection file",
    "written by the running desktop app.",
  ].join("\n");

const parseArgs = (
  argv: string[],
): { globals: GlobalOptions; command: string[] } => {
  const globals: GlobalOptions = {};
  const command: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" || arg === "--token" || arg === "--config-file") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new AutomationApiError(`Missing value for ${arg}`);
      }
      i++;
      if (arg === "--port") {
        const port = Number(value);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
          throw new AutomationApiError(`Invalid port: ${value}`);
        }
        globals.port = port;
      } else if (arg === "--token") {
        globals.token = value;
      } else {
        globals.configFile = value;
      }
    } else {
      command.push(arg);
    }
  }
  return { globals, command };
};

const parseLimit = (args: string[]): number => {
  const at = args.indexOf("--limit");
  if (at === -1) {
    return 20;
  }
  const value = Number(args[at + 1]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new AutomationApiError(`Invalid --limit: ${args[at + 1]}`);
  }
  return Math.min(value, 100);
};

const print = (value: unknown): void => {
  console.log(JSON.stringify(value, null, 2));
};

export const run = async (argv: string[]): Promise<number> => {
  let parsed: { globals: GlobalOptions; command: string[] };
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    return 1;
  }
  const [name, ...rest] = parsed.command;
  if (name === undefined || name === "--help" || name === "-h") {
    console.log(usage());
    return 0;
  }

  if (name === "connection") {
    console.log(connectionFilePath());
    return 0;
  }

  let connection: AutomationConnection;
  try {
    connection = resolveConnection(parsed.globals);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  if (name === "mcp") {
    const { serveMcp } = await import("./mcp.js");
    await serveMcp({ callApi: (path) => apiGet(connection, path) });
    return 0;
  }

  try {
    if (name === "status") {
      print(await apiGet(connection, "/api/v1/status"));
    } else if (name === "meetings") {
      print(
        await apiGet(connection, `/api/v1/meetings?limit=${parseLimit(rest)}`),
      );
    } else if (name === "search") {
      const query = rest[0];
      if (!query) {
        console.error("Usage: mausvoice-api search <query> [--limit N]");
        return 1;
      }
      print(
        await apiGet(
          connection,
          `/api/v1/meetings/search?q=${encodeURIComponent(query)}&limit=${parseLimit(rest)}`,
        ),
      );
    } else {
      console.error(`Unknown command: ${name}\n${usage()}`);
      return 1;
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return error instanceof AutomationApiError && error.status === 401 ? 2 : 1;
  }
};
