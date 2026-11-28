"use client";

import { useTranslations } from "next-intl";
import { Fragment, useId, useRef, useState, type ReactNode } from "react";
import { BrandLogo, type LogoId } from "@/components/ui/BrandLogo";
import { Presence, PresenceDiv } from "@/components/motion/Presence";
import { ButtonLink } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { CopyCode } from "@/components/ui/CopyCode";
import { IconChevronDown, IconExternal, IconPlus } from "@/components/ui/icons";
import {
  CHATGPT_URL,
  CLAUDE_CONNECTORS_URL,
  claudeCodeCommand,
  cursorInstallLink,
  genericConfig,
  geminiCommand,
  OFFICIAL_GUIDES,
  TOOL_NAMES,
  TOOLS,
  vscodeInstallLink,
  type ToolId,
} from "@/lib/mcp/clients";
import { cn } from "@/lib/utils";

// Konto → Koppla till din AI: a tile per AI tool (lib/mcp/clients.ts) with its own mark. Choosing
// one shows its steps right where the click was: on a phone (and below 1024 px) they open under
// the chosen tile's row, on a wide screen in a panel beside the grid. Numbered steps, the
// address or command to copy, a one-click install where the tool has one, the tool's official
// guide and a first question to try. The tiles are disclosure buttons (aria-expanded).

/** A tool's mark on a small surface tile. */
export function ToolMark({ logo, className }: { logo: LogoId; className?: string }) {
  return (
    <span aria-hidden="true" className={cn("grid size-9 shrink-0 place-items-center rounded-md bg-surface", className)}>
      <BrandLogo id={logo} size={20} />
    </span>
  );
}

export function useToolName() {
  const t = useTranslations("connect");
  return (tool: ToolId) => (tool === "other" ? t("tools.other.name") : TOOL_NAMES[tool]);
}

const COLS = 2;
const rowOf = (index: number) => Math.floor(index / COLS);
/** The last tile of a row (the odd last tool has a row of its own). */
const rowEnd = (row: number) => Math.min(row * COLS + COLS - 1, TOOLS.length - 1);

/** The tiles and the chosen tool's steps. */
export function ConnectPicker({ mcpUrl }: { mcpUrl: string }) {
  const t = useTranslations("connect");
  const name = useToolName();
  const [tool, setTool] = useState<ToolId | null>("claude");
  const uid = useId();
  const inline = useRef<HTMLDivElement>(null);
  const selectedRow = tool ? rowOf(TOOLS.indexOf(tool)) : -1;

  const choose = (next: ToolId) => {
    // Choosing the open one again closes it (on a phone that folds the steps away).
    setTool((cur) => (cur === next ? null : next));
    // Below 1024 px the steps open under the row: keep them in view once they have opened.
    if (window.matchMedia("(max-width: 63.99rem)").matches) {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      setTimeout(() => inline.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "nearest" }), reduce ? 0 : 320);
    }
  };

  return (
    <div className="flex flex-col gap-5 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:items-start lg:gap-6">
      <div role="group" aria-label={t("pickLabel")} className="grid grid-cols-2 gap-2">
        {TOOLS.map((id, i) => {
          const selected = tool === id;
          return (
            <Fragment key={id}>
              <button
                type="button"
                aria-expanded={selected}
                aria-controls={`${uid}-inline ${uid}-side`}
                aria-describedby={`${uid}-${id}-desc`}
                onClick={() => choose(id)}
                className={cn(
                  "press group/tile flex min-h-16 min-w-0 cursor-pointer items-center gap-3 rounded-lg bg-sunk p-3 text-left",
                  "transition-[background-color,outline-color] duration-150 ease-out hover:bg-[color-mix(in_srgb,var(--surface-sunk)_92%,var(--ink))]",
                  // Selected: tinted, with a ring drawn inside the tile (an outline, so it never sits on a frame).
                  "aria-expanded:bg-blue-wash aria-expanded:outline-2 aria-expanded:-outline-offset-2 aria-expanded:outline-blue",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
                  id === "other" && "col-span-2",
                )}
              >
                <ToolMark logo={id} />
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium leading-tight text-ink">{name(id)}</span>
                  <span id={`${uid}-${id}-desc`} aria-hidden="true" className="line-clamp-2 text-xs leading-snug text-ink-2 max-sm:hidden">
                    {t(`tools.${id}.desc`)}
                  </span>
                </span>
              </button>
              {/* Below 1024 px: the steps open under the chosen tile's row. */}
              {i === rowEnd(rowOf(i)) && (
                <Presence>
                  {tool && selectedRow === rowOf(i) && (
                    <PresenceDiv key={`row-${rowOf(i)}`} className="col-span-2 lg:hidden">
                      <div ref={inline} id={`${uid}-inline`} className="scroll-mt-24 pt-2 pb-3">
                        <div key={tool} className="animate-panel-in">
                          <ToolSteps tool={tool} mcpUrl={mcpUrl} />
                        </div>
                      </div>
                    </PresenceDiv>
                  )}
                </Presence>
              )}
            </Fragment>
          );
        })}
      </div>
      {/* 1024 px and up: beside the grid, staying in view while the tiles are used. */}
      <div id={`${uid}-side`} className="hidden lg:sticky lg:top-24 lg:block">
        {tool ? (
          <div key={tool} className="animate-panel-in">
            <ToolSteps tool={tool} mcpUrl={mcpUrl} />
          </div>
        ) : (
          <p className="rounded-lg bg-sunk px-4 py-6 text-sm text-ink-3">{t("pickHint")}</p>
        )}
      </div>
    </div>
  );
}

function ToolSteps({ tool, mcpUrl }: { tool: ToolId; mcpUrl: string }) {
  const t = useTranslations("connect");
  const name = useToolName();
  const b = { b: (chunks: ReactNode) => <strong className="font-semibold text-ink">{chunks}</strong> };
  // Every tool has steps 1–3 (Claude 4, ChatGPT 5) in connect.json; the key is checked there.
  const step = (key: "1" | "2" | "3" | "4" | "5") => <p>{t.rich(`steps.${tool}.${key}` as Parameters<typeof t.rich>[0], b)}</p>;
  const address = <CopyCode value={mcpUrl} label={t("addressLabel")} />;

  // A step is its text, and maybe something to copy (wider than the text on a phone).
  let steps: (ReactNode | [ReactNode, ReactNode])[];
  let actions: ReactNode = null;
  let note: ReactNode = null;
  switch (tool) {
    case "claude":
      steps = [step("1"), step("2"), [step("3"), address], step("4")];
      actions = <External href={CLAUDE_CONNECTORS_URL} primary>{t("openClaude")}</External>;
      break;
    case "chatgpt":
      note = t("steps.chatgpt.note");
      steps = [step("1"), step("2"), [step("3"), address], step("4"), step("5")];
      actions = <External href={CHATGPT_URL} primary>{t("openChatgpt")}</External>;
      break;
    case "cursor":
      steps = [step("1"), step("2"), [step("3"), <CopyCode value={genericConfig(mcpUrl)} label={t("configLabel")} block />]];
      actions = <External href={cursorInstallLink(mcpUrl)} primary app>{t("addToCursor")}</External>;
      break;
    case "vscode":
      steps = [step("1"), [step("2"), address], step("3")];
      actions = (
        <>
          <External href={vscodeInstallLink(mcpUrl)} primary app>{t("addToVscode")}</External>
          <External href={vscodeInstallLink(mcpUrl, true)} app>{t("addToVscodeInsiders")}</External>
        </>
      );
      break;
    case "claude-code":
      steps = [[step("1"), <CopyCode value={claudeCodeCommand(mcpUrl)} label={t("commandLabel")} />], step("2"), step("3")];
      break;
    case "gemini":
      steps = [[step("1"), <CopyCode value={geminiCommand(mcpUrl)} label={t("commandLabel")} />], step("2"), step("3")];
      break;
    case "other":
      steps = [[step("1"), address], [step("2"), <CopyCode value={genericConfig(mcpUrl)} label={t("configLabel")} block />], step("3")];
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
        {steps.map((entry, i) => {
          const [text, extra] = Array.isArray(entry) ? entry : [entry, null];
          return (
            <li key={i} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3 gap-y-2">
              <span aria-hidden="true" className="grid size-6 place-items-center rounded-full bg-sunk text-xs font-semibold tabular-nums text-ink-2">
                {i + 1}
              </span>
              <div className="pt-0.5 text-ink-2">{text}</div>
              {extra && <div className="col-start-2 min-w-0 max-sm:col-span-2 max-sm:col-start-1">{extra}</div>}
            </li>
          );
        })}
      </ol>
      <p className="rounded-md bg-blue-wash px-3 py-2 text-sm text-ink">{t.rich("tryIt", b)}</p>
      {OFFICIAL_GUIDES[tool] && (
        <a href={OFFICIAL_GUIDES[tool]} target="_blank" rel="noopener noreferrer" className="self-start text-sm">
          {tool === "other" ? t("mcpGuide") : t("officialGuide", { tool: name(tool) })}
          <span aria-hidden="true"> ↗</span>
          <span className="sr-only"> {t("newTab")}</span>
        </a>
      )}
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
      {/* The animated grid is a child: Radix zeroes the content node's transition around a toggle. */}
      <CollapsibleContent forceMount>
        <div className="grid grid-rows-[0fr] invisible transition-[grid-template-rows,visibility] duration-(--dur-press) [transition-timing-function:var(--ease-press)] group-data-[state=open]/add:visible group-data-[state=open]/add:grid-rows-[1fr]">
          <div className="min-h-0 overflow-hidden">
            <div className="-m-1 p-1 pt-5">{children}</div>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
