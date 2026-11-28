import { describe, expect, it } from "vitest";
import { claudeCodeCommand, cursorInstallLink, genericConfig, geminiCommand, toolForClientName, vscodeInstallLink } from "./clients";

const URL_ = "https://simonsays.harrysson.co/api/mcp";

describe("install links and commands", () => {
  it("Cursor: name and the base64 mcp.json entry", () => {
    const link = new URL(cursorInstallLink(URL_));
    expect(link.protocol).toBe("cursor:");
    expect(link.searchParams.get("name")).toBe("simon-says");
    expect(JSON.parse(atob(link.searchParams.get("config")!))).toEqual({ url: URL_ });
  });
  it("VS Code and Insiders: URL-encoded JSON with type http", () => {
    for (const [insiders, scheme] of [
      [false, "vscode:mcp/install?"],
      [true, "vscode-insiders:mcp/install?"],
    ] as const) {
      const link = vscodeInstallLink(URL_, insiders);
      expect(link.startsWith(scheme)).toBe(true);
      expect(JSON.parse(decodeURIComponent(link.slice(scheme.length)))).toEqual({ name: "simon-says", type: "http", url: URL_ });
    }
  });
  it("commands and the generic config", () => {
    expect(claudeCodeCommand(URL_)).toBe(`claude mcp add --transport http simon-says ${URL_}`);
    expect(geminiCommand(URL_)).toBe(`gemini mcp add --transport http simon-says ${URL_}`);
    expect(JSON.parse(genericConfig(URL_))).toEqual({ mcpServers: { "simon-says": { url: URL_ } } });
  });
});

describe("toolForClientName (logo only)", () => {
  it("knows the tools by their usual names", () => {
    expect(toolForClientName("Claude")).toBe("claude");
    expect(toolForClientName("claude-code")).toBe("claude-code");
    expect(toolForClientName("Claude Code (simon-says)")).toBe("claude-code");
    expect(toolForClientName("ChatGPT")).toBe("chatgpt");
    expect(toolForClientName("Cursor")).toBe("cursor");
    expect(toolForClientName("Visual Studio Code")).toBe("vscode");
    expect(toolForClientName("Gemini CLI MCP Client")).toBe("gemini");
    expect(toolForClientName("AI-assistent")).toBeNull();
    expect(toolForClientName("Precursory")).toBeNull();
  });
});
