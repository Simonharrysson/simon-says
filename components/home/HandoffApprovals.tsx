"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { AppLink } from "@/components/ui/AppLink";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { PendingHandoff } from "@/lib/home/tasks";
import { cn } from "@/lib/utils";

// "Väntar på godkännande" on Hem (Företag, 0050): tasks said in a meeting their owner can't see.
// The approver reads (and may rewrite) the wording before it is sent; nothing AI-written crosses
// the visibility boundary unreviewed. A row says what happened in place; the list refreshes after.

type RowState = { kind: "idle" } | { kind: "busy"; action: "approve" | "drop" } | { kind: "done"; action: "approve" | "drop" } | { kind: "error"; text: string };

export function HandoffApprovals({ items }: { items: PendingHandoff[] }) {
  const t = useTranslations("home.approvals");
  return (
    <section data-card aria-labelledby="approvals-title" className="flex flex-col gap-3 rounded-lg bg-surface p-4 shadow-panel sm:p-6">
      <div className="flex flex-col gap-1">
        <h2 id="approvals-title" className="text-lg tracking-[-0.02em]">
          {t("title")} <span className="text-ink-3 tabular-nums">{items.length}</span>
        </h2>
        <p className="max-w-[34rem] text-sm text-ink-2">{t("intro")}</p>
      </div>
      <ul className="flex flex-col">
        {items.map((item) => (
          <ApprovalRow key={item.id} item={item} />
        ))}
      </ul>
    </section>
  );
}

function ApprovalRow({ item }: { item: PendingHandoff }) {
  const t = useTranslations("home.approvals");
  const router = useRouter();
  const id = useId();
  const [text, setText] = useState(item.text);
  const [state, setState] = useState<RowState>({ kind: "idle" });
  const owner = item.ownerName || null;

  async function send(action: "approve" | "drop") {
    if (action === "approve" && !text.trim()) {
      setState({ kind: "error", text: t("empty") });
      return;
    }
    setState({ kind: "busy", action });
    try {
      const res = await fetch("/api/mina-uppgifter/overlamning", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action === "approve" ? { id: item.id, action, text } : { id: item.id, action }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setState({ kind: "done", action });
      router.refresh();
    } catch {
      setState({ kind: "error", text: t("failed") });
    }
  }

  const busy = state.kind === "busy";
  const done = state.kind === "done";
  return (
    <li className={cn("flex flex-col gap-3 border-t border-line py-4 first:border-t-0 first:pt-2 transition-opacity duration-200", done && "opacity-60")}>
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <span className="font-medium">{owner ? t("to", { name: owner }) : t("toUnknown")}</span>
        <span className="text-ink-3">{item.spaceName}</span>
        {item.due && <span className="text-ink-2">{t("dueText", { due: item.due })}</span>}
        <AppLink href={`/orgs/${item.spaceId}/mote/${item.meetingId}`} className="text-ink-3 underline-offset-2 hover:text-ink">
          {t("meeting")}
        </AppLink>
      </p>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-text`}>{t("textLabel", { name: owner ?? "" })}</Label>
        <Textarea id={`${id}-text`} value={text} maxLength={500} rows={2} onChange={(e) => setText(e.target.value)} disabled={busy || done} />
      </div>
      <div className="flex min-h-10 flex-wrap items-center gap-3">
        {done ? (
          <p role="status" className="text-sm font-medium text-green">
            {state.action === "approve" ? t("approved", { name: owner ?? "" }) : t("dropped")}
          </p>
        ) : (
          <>
            <Button variant="primary" size="sm" loading={busy && state.action === "approve"} disabled={busy} onClick={() => void send("approve")}>
              {busy && state.action === "approve" ? t("approving") : t("approve")}
            </Button>
            <Button variant="ghost" size="sm" loading={busy && state.action === "drop"} disabled={busy} onClick={() => void send("drop")}>
              {busy && state.action === "drop" ? t("dropping") : t("drop")}
            </Button>
            {state.kind === "error" && (
              <p role="alert" className="text-sm text-red">
                {state.text}
              </p>
            )}
          </>
        )}
      </div>
    </li>
  );
}
