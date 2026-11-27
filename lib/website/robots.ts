// robots.txt (RFC 9309), just enough to be polite: the group for our token, else the `*` group;
// the longest matching Allow/Disallow wins (Allow on a tie); `*` and `$` in paths. The file is
// someone else's input, so the work is bounded: at most ROBOTS_MAX_BYTES of text, ROBOTS_MAX_RULES
// rules of at most RULE_MAX_LENGTH characters, and a linear glob matcher (no regular expressions).

export const ROBOTS_MAX_BYTES = 64 * 1024;
export const ROBOTS_MAX_RULES = 500;
export const RULE_MAX_LENGTH = 512;

interface Rule {
  allow: boolean;
  path: string;
}

/** The rules that apply to `token` (lowercase), from the file's text. */
export function robotsRules(text: string, token: string): Rule[] {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;
  let rules = 0;
  // Over the cap: keep whole lines only (a cut rule would mean something else).
  const kept = text.length > ROBOTS_MAX_BYTES ? text.slice(0, text.lastIndexOf("\n", ROBOTS_MAX_BYTES) + 1) : text;
  for (const rawLine of kept.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" || key === "disallow") {
      // An empty Disallow allows everything: no rule.
      if (value && value.length <= RULE_MAX_LENGTH && rules < ROBOTS_MAX_RULES) {
        current.rules.push({ allow: key === "allow", path: value });
        rules++;
      }
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && token.includes(a)));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  return chosen.flatMap((g) => g.rules);
}

/**
 * Does `pattern` (with `*` = any run, a final `$` = end of path) match `path` from its start?
 * Greedy leftmost: the first piece must be a prefix, each middle piece is found with indexOf after
 * the previous one, and an anchored last piece must end the path. Linear in the input sizes.
 */
export function globMatch(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const pieces = (anchored ? pattern.slice(0, -1) : pattern).split("*");
  const first = pieces[0];
  if (!path.startsWith(first)) return false;
  if (pieces.length === 1) return anchored ? path.length === first.length : true;
  let at = first.length;
  const last = pieces[pieces.length - 1];
  for (let i = 1; i < pieces.length - 1; i++) {
    const found = path.indexOf(pieces[i], at);
    if (found < 0) return false;
    at = found + pieces[i].length;
  }
  if (!anchored) return path.indexOf(last, at) >= 0;
  return path.length - last.length >= at && path.endsWith(last);
}

/** May `token` fetch `path` (path + query)? */
export function robotsAllows(rules: Rule[], path: string): boolean {
  let best: Rule | null = null;
  for (const rule of rules) {
    if (!globMatch(rule.path, path)) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) best = rule;
  }
  return best ? best.allow : true;
}
