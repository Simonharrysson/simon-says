// robots.txt (RFC 9309), just enough to be polite: the group for our token, else the `*` group;
// the longest matching Allow/Disallow wins (Allow on a tie); `*` and `$` in paths.

interface Rule {
  allow: boolean;
  path: string;
}

/** The rules that apply to `token` (lowercase), from the file's text. */
export function robotsRules(text: string, token: string): Rule[] {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
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
      if (value) current.rules.push({ allow: key === "allow", path: value });
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && token.includes(a)));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  return chosen.flatMap((g) => g.rules);
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp(`^${body.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}${anchored ? "$" : ""}`);
  return re.test(path);
}

/** May `token` fetch `path` (path + query)? */
export function robotsAllows(rules: Rule[], path: string): boolean {
  let best: Rule | null = null;
  for (const rule of rules) {
    if (!matches(rule.path, path)) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) best = rule;
  }
  return best ? best.allow : true;
}
