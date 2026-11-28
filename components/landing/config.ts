// What the landing shows from configuration rather than copy. Only true things go here.

/**
 * AI assistants on "Din AI vet vad ni bestämt". `live` = the MCP OAuth allow-list
 * (lib/mcp/oauth.ts) accepts it today; `soon` = not yet (ChatGPT, Cursor and VS Code wait for
 * PR #60's redirect URIs). Flip to `live` when that ships. Neutral monograms, no brand marks
 * (their brand rules need permission first).
 */
export const ASSISTANTS: { name: string; mark: string; status: "live" | "soon" }[] = [
  { name: "Claude", mark: "Cl", status: "live" },
  { name: "ChatGPT", mark: "GPT", status: "soon" },
  { name: "Cursor", mark: "Cu", status: "soon" },
  { name: "VS Code", mark: "VS", status: "soon" },
];

/**
 * Quotes from real users, with their permission. Empty until there are some: the section is
 * hidden while this is empty. Never invent one.
 */
export const TESTIMONIALS: { quote: string; name: string; role: string }[] = [];

/** Where "Företag: hör av dig" and the founder note's mail go. */
export const CONTACT_EMAIL = "simon@harrysson.co";

export const REPO_URL = "https://github.com/Simonharrysson/simon-says";
