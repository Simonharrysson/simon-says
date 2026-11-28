"use client";

import { useTranslations } from "next-intl";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import type { AgentInfo } from "@/lib/agent/tasks";

const TONE: Record<AgentInfo["status"], BadgeTone> = { open: "neutral", in_progress: "info", blocked: "alert", done: "success" };

/** A task the meeting gave Claude: "Hos Claude · Pågår" and Claude's latest note (update_agent_task). */
export function AgentStatus({ agent }: { agent: AgentInfo }) {
  const t = useTranslations("agent");
  return (
    <div className="flex flex-col gap-1" data-agent-status={agent.status}>
      <Badge tone={TONE[agent.status]}>{t("label", { status: t(`status.${agent.status}`) })}</Badge>
      {agent.note && <p className="text-sm text-ink-2 wrap-anywhere">{t("note", { note: agent.note })}</p>}
    </div>
  );
}
