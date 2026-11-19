/**
 * MCP stdio server. stdout belongs to the protocol: nothing else may print to
 * it. Diagnostics go to stderr only.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MCP_TOOLS } from './tools.js';

export const SERVER_NAME = 'iot-rea';
export const SERVER_VERSION = '0.15.0';

export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  for (const tool of MCP_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.readOnly, openWorldHint: false },
      },
      async (args) => tool.run(args),
    );
  }

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[iot-rea] MCP server ready on stdio (${MCP_TOOLS.length} tools)\n`);
}
