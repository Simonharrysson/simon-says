"use client";

import { useTranslations } from "next-intl";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { IconPause, IconPlay, IconStop } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import type { EndStats, TaskAnswer } from "@/lib/notes/tasks";
import { EndTasksDialog, NO_PROGRESS, type EndAsk, type EndProgress } from "./EndTasksDialog";
import { LiveDialog, type LiveDialogHandle } from "./LiveDialog";

/**
 * Paus / Fortsätt and Avsluta. Paus is the big, always-reachable button (people ask for it
 * mid-sentence). Avsluta asks once, because ending runs the final pass and can't be undone.
 * With `canPause={false}` (the meeting has stopped on its own) only Avsluta is offered.
 * With `askTasks` (the förening asks for Vem, När and Klart när) Avsluta first reads the
 * incomplete tasks: any → the tasks dialog (fill in, leave, or Avsluta ändå), none → the usual question.
 */
export function MeetingControls({
  status,
  onPause,
  onResume,
  onStop,
  busy,
  canPause = true,
  className,
  askTasks,
}: {
  status: "live" | "paused" | "ending";
  onPause: () => void;
  onResume: () => void;
  onStop: (answers?: TaskAnswer[], stats?: EndStats) => void;
  /** The incomplete tasks to ask about before ending (empty: none); never throws. */
  askTasks?: () => Promise<EndAsk>;
  /** A pause/resume/stop request is in flight. */
  busy?: boolean;
  canPause?: boolean;
  className?: string;
}) {
  const t = useTranslations("live");
  const dialog = useRef<LiveDialogHandle>(null);
  const ending = status === "ending";
  // Read after awaits: the render's `ending` is stale once askTasks resolves.
  const endingRef = useRef(ending);
  useEffect(() => {
    endingRef.current = ending;
  }, [ending]);
  const [ask, setAsk] = useState<EndAsk | null>(null);
  // Typed and handled answers survive Esc / Fortsätt mötet, so reopening shows them.
  const [progress, setProgress] = useState<EndProgress>(NO_PROGRESS);
  const [checking, setChecking] = useState(false);
  // The meeting stopped on its own (a cap, another tab) while a dialog was open: close it, so it
  // can't end the meeting a second time.
  useEffect(() => {
    if (!ending) return;
    endingRef.current = true;
    setAsk(null);
    dialog.current?.close();
  }, [ending]);
  const askEnd = async () => {
    if (!askTasks) return dialog.current?.showModal();
    setChecking(true);
    const open = await askTasks();
    setChecking(false);
    if (endingRef.current) return;
    if (open.tasks.length) setAsk(open);
    else dialog.current?.showModal();
  };
  return (
    <div className={cn("flex gap-2 max-[52rem]:[&>button]:flex-1", className)}>
      {canPause &&
        (status === "paused" ? (
          <Button variant="primary" size="lg" icon={<IconPlay size={18} />} onClick={onResume} loading={busy} className="min-w-36">
            {t("controls.resume")}
          </Button>
        ) : (
          <Button
            size="lg"
            icon={<IconPause size={18} />}
            onClick={onPause}
            loading={busy && !ending}
            disabled={ending}
            className="min-w-36 border-[1.5px] border-ink"
          >
            {t("controls.pause")}
          </Button>
        ))}
      <Button
        size="lg"
        variant="danger-quiet"
        icon={<IconStop size={16} />}
        onClick={() => void askEnd()}
        disabled={ending || checking}
        loading={ending || checking}
      >
        {ending ? t("controls.ending") : t("controls.end")}
      </Button>

      <LiveDialog
        ref={dialog}
        id="stop"
        title={t("controls.endTitle")}
        stayLabel={t("controls.stay")}
        confirmLabel={t("controls.confirmEnd")}
        confirmIcon={<IconStop size={16} />}
        onConfirm={() => {
          if (!endingRef.current) onStop();
        }}
      >
        {t("stopCopy")}
      </LiveDialog>
      {ask && (
        <EndTasksDialog
          open
          tasks={ask.tasks}
          owners={ask.owners}
          setAsking={ask.setAsking}
          progress={progress}
          onProgress={setProgress}
          onOpenChange={(o) => {
            if (!o) setAsk(null);
          }}
          onConfirm={(answers, stats) => {
            if (!endingRef.current) onStop(answers, stats);
          }}
        />
      )}
    </div>
  );
}
