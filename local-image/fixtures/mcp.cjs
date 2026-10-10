const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const server = new McpServer({ name: 'fixture', version: '1.0.0' });
server.tool(
  'lookup_weather',
  'Look up fixture weather',
  { city: z.string() },
  async ({ city }) => ({
    content: [{ type: 'text', text: `Weather in ${city}: "sunny" — fixture only.` }],
  }),
);
server.connect(new StdioServerTransport());
