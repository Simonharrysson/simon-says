"use client";

import { useTranslations } from "next-intl";
import { useId, useRef, useState, type ReactNode } from "react";
import { ButtonLink } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { CopyCode } from "@/components/ui/CopyCode";
import { IconChevronDown, IconExternal, IconPlus } from "@/components/ui/icons";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  CHATGPT_HELP_URL,
  CHATGPT_URL,
  CLAUDE_CONNECTORS_URL,
  claudeCodeCommand,
  cursorInstallLink,
  genericConfig,
  geminiCommand,
  TOOL_NAMES,
  TOOLS,
  vscodeInstallLink,
  type ToolId,
} from "@/lib/mcp/clients";
import { cn } from "@/lib/utils";

// Konto → Koppla till din AI: a tile per AI tool (lib/mcp/clients.ts), and under the tiles the
// chosen tool's steps: numbered, with the address or command to copy, a one-click install where
// the tool has one, and a first question to try. Radix Tabs: arrow keys move between tiles.

/** A neutral monogram per tool (no brand marks: their owners' rules don't cover this use). */
const MONOGRAM: Record<ToolId, string> = {
  claude: "Cl",
  chatgpt: "Ch",
  cursor: "Cu",
  vscode: "VS",
  "claude-code": ">_",
  gemini: "Ge",
  other: "{ }",
};

export function ToolMark({ tool, className }: { tool: ToolId | null; className?: string }) {
  const mono = tool === "claude-code" || tool === "other" || tool === null;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-md bg-surface text-[0.8125rem] font-semibold tracking-tight text-ink",
        mono && "font-mono font-medium",
        className,
      )}
    >
      {tool ? MONOGRAM[tool] : "AI"}
    </span>
  );
}

export function useToolName() {
  const t = useTranslations("connect");
  return (tool: ToolId) => (tool === "other" ? t("tools.other.name") : TOOL_NAMES[tool]);
}

/** The tiles and the chosen tool's steps. */
export function ConnectPicker({ mcpUrl }: { mcpUrl: string }) {
  const t = useTranslations("connect");
  const name = useToolName();
  const [tool, setTool] = useState<ToolId>("claude");
  const panel = useRef<HTMLDivElement>(null);
  const uid = useId();

  const choose = (next: string) => {
    setTool(next as ToolId);
    // On a phone the steps are below the tiles: bring them into view.
    const el = panel.current;
    if (el && window.matchMedia("(max-width: 47.99rem)").matches) {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      requestAnimationFrame(() => el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" }));
    }
  };

  return (
    <Tabs value={tool} onValueChange={choose} className="gap-5">
      <TabsList aria-label={t("pickLabel")} className="grid grid-cols-2 gap-2">
        {TOOLS.map((id) => (
          <TabsTrigger
            key={id}
            value={id}
            // Named by the tool alone ("Claude"); the line under it is its description.
            aria-describedby={`${uid}-${id}-desc`}
            className={cn(
              "press group/tile flex min-h-16 min-w-0 cursor-pointer items-center gap-3 rounded-lg bg-sunk p-3 text-left",
              // "Annat verktyg" (the odd one) takes the whole last row.
              id === "other" && "col-span-2",
              "transition-[background-color,color] duration-150 ease-out hover:bg-[color-mix(in_srgb,var(--surface-sunk)_88%,var(--ink))]",
              "data-[state=active]:bg-blue-wash",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
            )}
          >
            <ToolMark tool={id} />
            <span className="flex min-w-0 flex-col">
              <span className="font-medium leading-tight text-ink group-data-[state=active]/tile:text-blue">
                {name(id)}
              </span>
              <span id={`${uid}-${id}-desc`} aria-hidden="true" className="truncate text-xs leading-snug text-ink-3 max-sm:hidden">{t(`tools.${id}.desc`)}</span>
            </span>
          </TabsTrigger>
        ))}
      </TabsList>
      <div ref={panel} className="scroll-mt-24">
        {TOOLS.map((id) => (
          <TabsContent key={id} value={id} className="animate-panel-in">
            <ToolSteps tool={id} mcpUrl={mcpUrl} />
          </TabsContent>
        ))}
      </div>
    </Tabs>
  );
}

function ToolSteps({ tool, mcpUrl }: { tool: ToolId; mcpUrl: string }) {
  const t = useTranslations("connect");
  const name = useToolName();
  const b = { b: (chunks: ReactNode) => <strong className="font-semibold text-ink">{chunks}</strong> };
  // Every tool has steps 1–3 (Claude 4, ChatGPT 5) in connect.json; the key is checked there.
  const step = (key: "1" | "2" | "3" | "4" | "5") => <p>{t.rich(`steps.${tool}.${key}` as Parameters<typeof t.rich>[0], b)}</p>;
  const address = <CopyCode value={mcpUrl} label={t("addressLabel")} />;

  let steps: ReactNode[];
  let actions: ReactNode = null;
  let note: ReactNode = null;
  switch (tool) {
    case "claude":
      steps = [step("1"), step("2"), <>{step("3")}{address}</>, step("4")];
      actions = <External href={CLAUDE_CONNECTORS_URL} primary>{t("openClaude")}</External>;
      break;
    case "chatgpt":
      note = t("steps.chatgpt.note");
      steps = [step("1"), step("2"), <>{step("3")}{address}</>, step("4"), step("5")];
      actions = (
        <>
          <External href={CHATGPT_URL} primary>{t("openChatgpt")}</External>
          <External href={CHATGPT_HELP_URL}>{t("chatgptHelp")}</External>
        </>
      );
      break;
    case "cursor":
      steps = [step("1"), step("2"), <>{step("3")}<CopyCode value={genericConfig(mcpUrl)} label={t("configLabel")} block /></>];
      actions = <External href={cursorInstallLink(mcpUrl)} primary app>{t("addToCursor")}</External>;
      break;
    case "vscode":
      steps = [step("1"), step("2"), step("3")];
      actions = (
        <>
          <External href={vscodeInstallLink(mcpUrl)} primary app>{t("addToVscode")}</External>
          <External href={vscodeInstallLink(mcpUrl, true)} app>{t("addToVscodeInsiders")}</External>
        </>
      );
      break;
    case "claude-code":
      steps = [<>{step("1")}<CopyCode value={claudeCodeCommand(mcpUrl)} label={t("commandLabel")} /></>, step("2"), step("3")];
      break;
    case "gemini":
      steps = [<>{step("1")}<CopyCode value={geminiCommand(mcpUrl)} label={t("commandLabel")} /></>, step("2"), step("3")];
      break;
    case "other":
      steps = [<>{step("1")}{address}</>, <>{step("2")}<CopyCode value={genericConfig(mcpUrl)} label={t("configLabel")} block /></>, step("3")];
      break;
  }

  return (
    <section aria-label={name(tool)} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold">{t("stepsTitle", { tool: name(tool) })}</h3>
        {note && <p className="text-sm text-ink-3">{note}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      <ol className="flex flex-col gap-3">
        {steps.map((s, i) => (
          <li key={i} className="grid grid-cols-[1.5rem_1fr] gap-x-3">
            <span aria-hidden="true" className="grid size-6 place-items-center rounded-full bg-sunk text-xs font-semibold tabular-nums text-ink-2">
              {i + 1}
            </span>
            <div className="flex min-w-0 flex-col gap-2 pt-0.5 text-ink-2">{s}</div>
          </li>
        ))}
      </ol>
      <p className="rounded-md bg-blue-wash px-3 py-2 text-sm text-ink">{t.rich("tryIt", b)}</p>
    </section>
  );
}

/** A link out: a new tab for websites, the app itself for an install link (cursor:, vscode:). */
function External({ href, primary, app, children }: { href: string; primary?: boolean; app?: boolean; children: ReactNode }) {
  const t = useTranslations("connect");
  return (
    <ButtonLink
      href={href}
      variant={primary ? "primary" : "secondary"}
      icon={app ? <IconPlus size={16} /> : <IconExternal size={16} />}
      {...(app ? {} : { target: "_blank", rel: "noopener noreferrer" })}
    >
      {children}
      {!app && <span className="sr-only"> {t("newTab")}</span>}
    </ButtonLink>
  );
}

/** "Koppla en till": when something is connected, the tiles wait behind this. */
export function AddAnother({ children }: { children: ReactNode }) {
  const t = useTranslations("connect");
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="group/add flex flex-col">
      <div>
        <CollapsibleTrigger className="press -mx-2 inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-2 text-sm font-medium text-ink hover:bg-sunk focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
          <IconPlus size={16} />
          {t("addAnother")}
          <IconChevronDown size={16} className="text-ink-3 transition-[rotate] duration-(--dur-press) [transition-timing-function:var(--ease-press)] group-data-[state=open]/add:rotate-180" />
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent
        forceMount
        className="grid grid-rows-[0fr] invisible transition-[grid-template-rows,visibility] duration-(--dur-press) [transition-timing-function:var(--ease-press)] data-[state=open]:visible data-[state=open]:grid-rows-[1fr]"
      >
        <div className="min-h-0 overflow-hidden">
          <div className="-m-1 p-1 pt-5">{children}</div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
