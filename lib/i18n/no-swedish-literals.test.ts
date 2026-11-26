import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Lint-ish guard: user-facing copy lives in lib/i18n/messages, not in components. Scans every
// string literal, template part and JSX text in components/** and app/** for Swedish letters
// (å ä ö). Comments are ignored (the TypeScript parser drops them). It can't see Swedish without
// those letters ("Logga in"); reviews and the English screenshots catch those.
//
// ALLOWED: files that may keep Swedish literals, and why. Keep it short; prefer the catalogs.

const ROOT = join(__dirname, "..", "..");
const SCANNED = ["components", "app"];

const ALLOWED: Record<string, string> = {
  // The /design gallery is a dev tool: its chrome (view titles, groups) may stay Swedish, and its
  // fake data is Swedish on purpose (Doc content, names, agenda items).
  "components/design/": "dev-only /design gallery chrome and fake data",
};

/** Literals that may appear anywhere (proper nouns, Doc-bound values, technical tokens). */
const ALLOWED_LITERALS = new Set<string>([]);

function files(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function swedishLiterals(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(join(ROOT, path), "utf8"), ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    let text: string | null = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      // Module specifiers ("@/lib/…") are paths, not copy.
      if (!ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent)) text = node.text;
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) text = node.text;
    else if (ts.isJsxText(node)) text = node.text.trim();
    if (text && /[åäöÅÄÖ]/.test(text) && !ALLOWED_LITERALS.has(text)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      found.push(`${path}:${line + 1}: ${text.slice(0, 80)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("no Swedish literals outside the catalogs", () => {
  it("components/** and app/** keep their copy in lib/i18n/messages", () => {
    const offenders = SCANNED.flatMap(files)
      .map((p) => relative(ROOT, join(ROOT, p)))
      .filter((p) => !Object.keys(ALLOWED).some((prefix) => p.startsWith(prefix)))
      .flatMap(swedishLiterals);
    expect(offenders).toEqual([]);
  });
});
