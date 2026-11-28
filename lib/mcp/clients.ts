// Konto → Koppla till din AI: the AI tools the page shows, and how to add Simon Says to each.
// Only tools whose documented OAuth redirect URIs are on our allow-list (lib/mcp/oauth.ts
// HOSTED_CALLBACKS and loopback; docs/mcp.md "Redirect URIs") are listed. Claude and Claude Code
// are used in production; the others are allow-listed from their docs, not yet tried live. Pure: the links and
// commands are unit-tested (clients.test.ts).

export const SERVER_NAME = "simon-says";

export type ToolId = "claude" | "chatgpt" | "cursor" | "vscode" | "claude-code" | "gemini" | "other";

/** In the order of the tiles: the chat apps first, then the developer tools, then "Annat verktyg". */
export const TOOLS: readonly ToolId[] = ["claude", "chatgpt", "cursor", "vscode", "claude-code", "gemini", "other"];

/** Display names (brand names, the same in every language; "other" is translated). */
export const TOOL_NAMES: Record<Exclude<ToolId, "other">, string> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
  cursor: "Cursor",
  vscode: "VS Code",
  "claude-code": "Claude Code",
  gemini: "Gemini CLI",
};

/** Where Claude's connectors are (support.claude.com/en/articles/11175166: Customize → Connectors). */
export const CLAUDE_CONNECTORS_URL = "https://claude.ai/customize/connectors";
export const CHATGPT_URL = "https://chatgpt.com";

/** Each tool's own guide to adding a remote MCP server (checked 2026-11-28), linked under its steps. */
export const OFFICIAL_GUIDES: Partial<Record<ToolId, string>> = {
  claude: "https://support.claude.com/en/articles/11175166",
  chatgpt: "https://help.openai.com/en/articles/12584461",
  cursor: "https://cursor.com/docs/context/mcp",
  vscode: "https://code.visualstudio.com/docs/copilot/customization/mcp-servers",
  "claude-code": "https://code.claude.com/docs/en/mcp",
  gemini: "https://geminicli.com/docs/tools/mcp-server/",
  other: "https://modelcontextprotocol.io/docs/learn/client-concepts",
};

/** UTF-8 safe base64 (btoa only takes Latin-1). */
function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Cursor's one-click install (cursor.com/docs/context/mcp/install-links): the server's mcp.json entry, base64. */
export function cursorInstallLink(mcpUrl: string): string {
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(SERVER_NAME)}&config=${encodeURIComponent(base64(JSON.stringify({ url: mcpUrl })))}`;
}

/** VS Code's one-click install (code.visualstudio.com/api/extension-guides/ai/mcp): the server as URL-encoded JSON. */
export function vscodeInstallLink(mcpUrl: string, insiders = false): string {
  const config = { name: SERVER_NAME, type: "http", url: mcpUrl };
  return `${insiders ? "vscode-insiders" : "vscode"}:mcp/install?${encodeURIComponent(JSON.stringify(config))}`;
}

export const claudeCodeCommand = (mcpUrl: string) => `claude mcp add --transport http ${SERVER_NAME} ${mcpUrl}`;
export const geminiCommand = (mcpUrl: string) => `gemini mcp add --transport http ${SERVER_NAME} ${mcpUrl}`;

/** The common `mcpServers` shape most MCP clients read. */
export const genericConfig = (mcpUrl: string) => JSON.stringify({ mcpServers: { [SERVER_NAME]: { url: mcpUrl } } }, null, 2);
