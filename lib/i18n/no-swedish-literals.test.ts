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

/** Files not moved to the catalogs yet. Shrinks to nothing; don't add to it. */
const NOT_YET = new Set<string>([
  "app/(app)/orgs/[id]/forbered/page.tsx",
  "app/(app)/orgs/[id]/kom-igang/actions.ts",
  "app/(app)/orgs/[id]/kom-igang/page.tsx",
  "app/(app)/orgs/[id]/page.tsx",
  "app/(app)/orgs/page.tsx",
  "app/api/google/picker-token/route.ts",
  "app/api/meetings/[id]/doc-access/route.ts",
  "app/api/meetings/route.ts",
  "app/api/meetings/test/route.ts",
  "app/api/mejl/avsluta/route.ts",
  "app/api/orgs/[id]/agenda-candidates/route.ts",
  "app/api/orgs/[id]/format/route.ts",
  "app/api/orgs/[id]/formats/propose/route.ts",
  "app/api/orgs/[id]/formats/route.ts",
  "app/api/orgs/[id]/formats/stadgar/route.ts",
  "app/api/orgs/[id]/goals/propose/route.ts",
  "app/api/orgs/[id]/goals/route.ts",
  "app/api/orgs/[id]/history/drive/route.ts",
  "app/api/orgs/[id]/history/estimate/route.ts",
  "app/api/orgs/[id]/history/import/route.ts",
  "app/api/orgs/[id]/history/jobs/[jobId]/cancel/route.ts",
  "app/api/orgs/[id]/history/jobs/[jobId]/items/[itemId]/route.ts",
  "app/api/orgs/[id]/history/jobs/[jobId]/route.ts",
  "app/api/orgs/[id]/history/jobs/[jobId]/seen/route.ts",
  "app/api/orgs/[id]/history/jobs/route.ts",
  "app/api/orgs/[id]/history/route.ts",
  "app/api/orgs/[id]/invites/route.ts",
  "app/api/orgs/[id]/logo/route.ts",
  "app/api/orgs/[id]/meeting-folder/route.ts",
  "app/api/orgs/[id]/onboarding/formats/route.ts",
  "app/api/orgs/[id]/onboarding/stadgar/route.ts",
  "app/api/orgs/[id]/prepare/route.ts",
  "app/integritet/page.tsx",
  "app/meetings/[id]/page.tsx",
  "app/meetings/ny/[orgId]/page.tsx",
  "components/google/Picker.tsx",
  "components/live/AgendaStep.tsx",
  "components/live/ConsentStep.tsx",
  "components/live/DocLink.tsx",
  "components/live/LiveBanners.tsx",
  "components/live/LiveDialog.tsx",
  "components/live/LiveMeeting.tsx",
  "components/live/LiveMeetingController.tsx",
  "components/live/MeetingControls.tsx",
  "components/live/MeetingEnded.tsx",
  "components/live/MeetingTimer.tsx",
  "components/live/NameRound.tsx",
  "components/live/PartialStrip.tsx",
  "components/live/ResumeMeeting.tsx",
  "components/live/SignedInAgain.tsx",
  "components/live/SpeakerList.tsx",
  "components/onboarding/KomIgangCard.tsx",
  "components/onboarding/logo-image.ts",
  "components/onboarding/Onboarding.tsx",
  "components/onboarding/OnboardingShell.tsx",
  "components/onboarding/steps.tsx",
  "components/views/DocAccessButton.tsx",
  "components/views/DriveSteps.tsx",
  "components/views/FormatCard.tsx",
  "components/views/FormatEditor.tsx",
  "components/views/HistoryImport.tsx",
  "components/views/ImportProgress.tsx",
  "components/views/InviteByEmail.tsx",
  "components/views/JoinView.tsx",
  "components/views/LandingView.tsx",
  "components/views/LoginView.tsx",
  "components/views/OrgDetailView.tsx",
  "components/views/OrgSettingsForm.tsx",
  "components/views/OrgsView.tsx",
  "components/views/OverviewView.tsx",
  "components/views/PersonRow.tsx",
  "components/views/PrepareMeeting.tsx",
  "components/views/StartMeetingForm.tsx",
  "components/views/StatusView.tsx",
  "components/views/SummarySettingsForm.tsx",
  "components/views/useMeetingFolderPicker.ts",
]);

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
      .filter((p) => !Object.keys(ALLOWED).some((prefix) => p.startsWith(prefix)) && !NOT_YET.has(p))
      .flatMap(swedishLiterals);
    expect(offenders).toEqual([]);
  });
});
