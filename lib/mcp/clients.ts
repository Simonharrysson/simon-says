// Konto → Koppla till din AI: the AI tools the page shows, and how to add Simon Says to each.
// Only tools whose OAuth flow works against our redirect allow-list (lib/mcp/oauth.ts
// HOSTED_CALLBACKS and loopback; docs/mcp.md "Redirect URIs") are listed. Pure: the links and
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
/** OpenAI's own steps ("Connecting custom MCP servers in ChatGPT"). */
export const CHATGPT_HELP_URL = "https://help.openai.com/en/articles/12584461";

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

/**
 * The tool a connection most likely is, from the name the client registered with. Only for the
 * logo and name in the list: that name is chosen by the client, so it never decides anything
 * (the consent page names the app from the redirect URI).
 */
export function toolForClientName(name: string): Exclude<ToolId, "other"> | null {
  const n = name.toLowerCase();
  if (/\bclaude[\s-]code\b/.test(n)) return "claude-code";
  if (/\bclaude\b/.test(n)) return "claude";
  if (/\b(chatgpt|openai)\b/.test(n)) return "chatgpt";
  if (/\bcursor\b/.test(n)) return "cursor";
  if (/\b(visual studio code|vs ?code)\b/.test(n)) return "vscode";
  if (/\bgemini\b/.test(n)) return "gemini";
  return null;
}
