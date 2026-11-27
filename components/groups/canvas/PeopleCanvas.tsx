"use client";

import "@xyflow/react/dist/base.css";
import "./canvas.css";

import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChangeset,
  type NodeProps,
} from "@xyflow/react";
import { useLocale, useTranslations } from "next-intl";
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FocusEvent, type KeyboardEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/Field";
import { IconPencil, IconPlus } from "@/components/ui/icons";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { parentChoices, treeRows } from "@/lib/foretag/tree";
import { canvasPositions, connectCheck, initials, layoutTree, nextFreeSpot, type ConnectCheck } from "@/lib/groups/canvas";
import { asTreeRows, type TreePersonView } from "@/lib/groups/people";
import { ownerOf } from "@/lib/groups/teams";
import { cn } from "@/lib/utils";
import type { CanvasApi, CanvasData, ManagerTo, PersonInput, Who } from "./types";

// The people tree as a canvas (Railway-style, Simon 2026-11-27, people first): a card per person,
// dragged anywhere (the place is saved); an arrow from a person's bottom to another's top means
// "rapporterar till" (one manager each, never a cycle); new people from "+ Lägg till person" or the
// "+" under a card. Admins edit, members look. Every change is optimistic and rolled back when the
// database refuses it. The list (PeopleTree) is the phone view and "Lista".

const PERSON_MIME = "application/x-simon-person";
const GRID = 16;
/** Room for the "Utan plats" tray (top left) and the toolbar (top right) when fitting the view. */
const FIT = { padding: { top: "84px", left: "264px", right: "48px", bottom: "56px" }, maxZoom: 1 } as const;
const CARD = { width: 240, height: 96, gapX: 40, gapY: 88 };

type PersonNodeData = { person: TreePersonView; managerName: string | null; reports: number };
type PersonNode = Node<PersonNodeData, "person">;
type AddNode = Node<Record<string, never>, "add">;
type CanvasNode = PersonNode | AddNode;
type ReportEdge = Edge<{ fresh: boolean }, "reports">;

type Dialogs = { kind: "edit"; id: string } | { kind: "add"; manager: string | null } | { kind: "manager"; key: string } | { kind: "detach"; childId: string } | null;

interface Ctx {
  isAdmin: boolean;
  dragging: string | null;
  setDragging: (key: string | null) => void;
  open: (d: Dialogs) => void;
  dropOn: (key: string, managerId: string | null) => void;
  askDetach: (childId: string) => void;
}
const CanvasCtx = createContext<Ctx | null>(null);
const useCanvas = () => use(CanvasCtx)!;

const prefersReducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const store = {
  get(key: string) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      window.localStorage.setItem(key, value);
    } catch {}
  },
};

export default function PeopleCanvas({ data, api }: { data: CanvasData; api: CanvasApi }) {
  return (
    <ReactFlowProvider>
      <Canvas data={data} api={api} />
    </ReactFlowProvider>
  );
}

const whoOf = (p: TreePersonView): Who => (p.personId ? { personId: p.personId } : { userId: p.userId!, name: p.email?.split("@")[0] ?? p.name });

function Canvas({ data, api }: { data: CanvasData; api: CanvasApi }) {
  const t = useTranslations("foretag.tree");
  const tt = useTranslations("foretag.teams");
  const locale = useLocale();
  const flow = useReactFlow<CanvasNode, ReportEdge>();
  // The cards stay hidden until the first fit has placed them: never a frame with a card on the
  // canvas's edge (a double border) or a jump from where they were drawn first.
  const measured = useNodesInitialized();
  const [fitted, setFitted] = useState(false);
  useEffect(() => {
    if (!measured || fitted) return;
    let live = true;
    void Promise.resolve(flow.fitView({ ...FIT, duration: 0 })).finally(() => live && setFitted(true));
    return () => {
      live = false;
    };
  }, [measured, fitted, flow]);
  const { orgId, isAdmin } = data;

  // A local copy, optimistic; replaced when the server sends new props (after revalidation).
  const [people, setPeople] = useState(data.people);
  useEffect(() => setPeople(data.people), [data.people]);

  const rows = useMemo(() => asTreeRows(people), [people]);
  const ordered = useMemo(() => treeRows(rows), [rows]);
  const byId = useMemo(() => new Map(people.flatMap((p) => (p.personId ? [[p.personId, p] as const] : []))), [people]);
  const byKey = useMemo(() => new Map(people.map((p) => [p.key, p])), [people]);
  const reportsOf = useCallback((id: string) => people.filter((p) => p.managerId === id && p.placed).length, [people]);

  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [pending, setPending] = useState(0);
  const [status, setStatus] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
  const [snapOn, setSnapOn] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  useEffect(() => setSnapOn(store.get("tree-canvas-snap") === "1"), []);

  // A dragged avatar that lands on a card unmounts before its dragend: clear it on any drop.
  useEffect(() => {
    const clear = () => setDragging(null);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, []);

  const say = useCallback((text: string, tone: "ok" | "error" = "ok") => setStatus({ text, tone }), []);
  useEffect(() => {
    if (!status) return;
    const id = window.setTimeout(() => setStatus(null), 5000);
    return () => window.clearTimeout(id);
  }, [status]);

  /** Run a write; count it in `pending` (the "Sparar…" state and data-saving for tests). */
  const run = useCallback(async <T,>(write: () => Promise<T>): Promise<T | null> => {
    setPending((n) => n + 1);
    try {
      return await write();
    } catch {
      return null;
    } finally {
      setPending((n) => n - 1);
    }
  }, []);

  // ---- Nodes: one per person in the tree (+ the "Lägg till person" card for admins), kept in sync.
  useEffect(() => {
    setNodes((prev) => {
      const before = new Map(prev.map((n) => [n.id, n]));
      const placed = canvasPositions(rows, CARD);
      const out: CanvasNode[] = ordered.map(({ group }) => {
        const person = byId.get(group.id)!;
        const old = before.get(group.id) as PersonNode | undefined;
        const manager = person.managerId ? (byId.get(person.managerId)?.name ?? null) : null;
        const reports = reportsOf(group.id);
        return {
          ...(old ?? {}),
          id: group.id,
          type: "person",
          position: old?.position ?? placed.get(group.id) ?? { x: 0, y: 0 },
          data: { person, managerName: manager, reports },
          draggable: isAdmin,
          connectable: isAdmin,
          deletable: false,
          ariaLabel: t("nodeLabel", { name: person.name, role: person.role ?? "none", manager: manager ?? "none", reports }),
        } satisfies PersonNode;
      });
      if (isAdmin) {
        const old = before.get("__add");
        const count = prev.filter((n) => n.type === "person").length;
        out.push({
          ...(old ?? {}),
          id: "__add",
          type: "add",
          position: old && count === out.length ? old.position : nextFreeSpot(out.map((n) => n.position), CARD),
          data: {},
          draggable: false,
          selectable: false,
          connectable: false,
          deletable: false,
          focusable: false,
        } satisfies AddNode);
      }
      return out;
    });
  }, [ordered, rows, byId, reportsOf, isAdmin, t]);

  const edges: ReportEdge[] = useMemo(
    () =>
      ordered.flatMap(({ group }) => {
        const person = byId.get(group.id)!;
        const manager = person.managerId ? byId.get(person.managerId) : undefined;
        if (!manager) return [];
        return [
          {
            id: `${manager.personId}->${person.personId}`,
            type: "reports",
            source: manager.personId!,
            target: person.personId!,
            deletable: false,
            selectable: true,
            focusable: true,
            selected: selectedEdge === `${manager.personId}->${person.personId}`,
            ariaLabel: t("edgeLabel", { child: person.name, manager: manager.name }),
            markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
            data: { fresh: fresh.has(person.personId!) },
          } satisfies ReportEdge,
        ];
      }),
    [ordered, byId, fresh, selectedEdge, t],
  );

  // ---- Saving positions: after a drag ends or a keyboard move, debounced, never mid-drag.
  const queued = useRef(new Set<string>());
  const timer = useRef<number | null>(null);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const flush = useCallback(async () => {
    timer.current = null;
    const ids = [...queued.current];
    queued.current.clear();
    const positions = ids.flatMap((id) => {
      const n = nodesRef.current.find((x) => x.id === id && x.type === "person");
      return n ? [{ id, x: Math.round(n.position.x * 10) / 10, y: Math.round(n.position.y * 10) / 10 }] : [];
    });
    if (!positions.length) return;
    const r = await run(() => api.savePositions(orgId, positions));
    if (!r?.ok) say(t("failed"), "error");
  }, [api, orgId, run, say, t]);
  const queueSave = useCallback(
    (ids: string[]) => {
      if (!isAdmin) return;
      for (const id of ids) if (id !== "__add") queued.current.add(id);
      // One "pending" for the whole debounce window, counted once when it opens.
      if (timer.current) window.clearTimeout(timer.current);
      else setPending((n) => n + 1);
      timer.current = window.setTimeout(() => {
        setPending((n) => n - 1);
        void flush();
      }, 350);
    },
    [flush, isAdmin],
  );
  const onNodesChange = useCallback(
    (changes: NodeChangeset<CanvasNode>) => {
      setNodes((nds) => changes.applyTo(nds));
      const settled = changes.getByType("position").filter((c) => !c.dragging && c.position);
      if (settled.length) queueSave(settled.map((c) => c.id));
    },
    [queueSave],
  );

  // ---- Reporting lines
  const markFresh = (id: string) => {
    setFresh((s) => new Set(s).add(id));
    window.setTimeout(
      () =>
        setFresh((s) => {
          const next = new Set(s);
          next.delete(id);
          return next;
        }),
      900,
    );
  };

  /** Move `person` (optimistically) under `to`; roll back when refused. */
  const setManager = useCallback(
    async (person: TreePersonView, to: ManagerTo) => {
      const before = people;
      const managerId = typeof to === "object" ? to.manager : null;
      const old = person.managerId ? byId.get(person.managerId) : undefined;
      setPeople(people.map((p) => (p.key === person.key ? { ...p, placed: to !== "none", managerId } : p)));
      if (managerId && person.personId) markFresh(person.personId);
      const r = await run(() => api.setManager(orgId, whoOf(person), to));
      if (!r?.ok) {
        setPeople(before);
        const reason = r && "reason" in r ? r.reason : undefined;
        const managerName = managerId ? (byId.get(managerId)?.name ?? "") : "";
        say(
          reason === "has_reports"
            ? t("refused.hasReports", { name: person.name })
            : reason === "not_placed"
              ? t("refused.notPlaced", { manager: managerName })
              : reason === "cycle"
                ? t("refused.cycle", { child: person.name, manager: managerName })
                : t("failed"),
          "error",
        );
        return false;
      }
      const manager = managerId ? byId.get(managerId) : undefined;
      if (to === "top") say(t("toTop", { name: person.name }));
      else if (to === "none") say(t("toNone", { name: person.name }));
      else if (old && old.personId !== managerId) say(t("replaced", { child: person.name, manager: manager?.name ?? "", old: old.name }));
      else say(t("connected", { child: person.name, manager: manager?.name ?? "" }));
      return true;
    },
    [api, byId, orgId, people, run, say, t],
  );

  const refuse = useCallback(
    (check: Extract<ConnectCheck, { ok: false }>, manager: string, child: string) => say(t(`refused.${check.reason}`, { manager, child }), "error"),
    [say, t],
  );
  const isValidConnection = useCallback((c: Connection | Edge) => connectCheck(rows, c.source, c.target).ok, [rows]);
  const onConnect = useCallback(
    (c: Connection) => {
      const manager = byId.get(c.source);
      const child = byId.get(c.target);
      if (!manager || !child) return;
      const check = connectCheck(rows, c.source, c.target);
      if (!check.ok) return refuse(check, manager.name, child.name);
      void setManager(child, { manager: c.source });
    },
    [byId, refuse, rows, setManager],
  );

  const askDetach = useCallback(
    (childId: string) => {
      const child = byId.get(childId);
      if (!child) return;
      if (!child.managerId) return say(t("noArrow", { name: child.name }), "error");
      setDialog({ kind: "detach", childId });
    },
    [byId, say, t],
  );

  /** An avatar from the tray dropped on a card: reports to that person. */
  const dropOn = useCallback(
    (key: string, managerId: string | null) => {
      const person = byKey.get(key);
      if (!person) return;
      if (managerId) {
        // Someone outside the tree has no reports: any manager in the tree will do.
        const check = person.placed && person.personId ? connectCheck(rows, managerId, person.personId) : ({ ok: true, replaces: null } as const);
        if (!check.ok) return refuse(check, byId.get(managerId)?.name ?? "", person.name);
        void setManager(person, { manager: managerId });
      } else if (person.placed) {
        void setManager(person, "none");
      }
    },
    [byId, byKey, refuse, rows, setManager],
  );

  // ---- "Ordna automatiskt": tidy top-down, animated by the cards' CSS transition.
  const tidy = useCallback(async () => {
    const layout = layoutTree(rows, CARD);
    const spot = nextFreeSpot(layout.values(), CARD);
    setNodes((nds) => nds.map((n) => (n.type === "add" ? { ...n, position: spot } : layout.has(n.id) ? { ...n, position: layout.get(n.id)! } : n)));
    window.setTimeout(() => void flow.fitView({ ...FIT, duration: prefersReducedMotion() ? 0 : 450 }), 30);
    const r = await run(() => api.savePositions(orgId, [...layout].map(([id, p]) => ({ id, ...p }))));
    if (!r?.ok) say(t("failed"), "error");
  }, [api, flow, orgId, rows, run, say, t]);

  // ---- Keyboard: Enter edits the focused card, Delete removes the arrow above it (or the selected arrow).
  const onKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (!isAdmin || target.closest("input, select, textarea, button, [role=dialog]")) return;
    const nodeId = target.classList.contains("react-flow__node") ? target.dataset.id : undefined;
    const edgeId = target.closest(".react-flow__edge")?.getAttribute("data-id") ?? selectedEdge;
    if (e.key === "Enter" && nodeId && nodeId !== "__add") {
      e.preventDefault();
      e.stopPropagation();
      setDialog({ kind: "edit", id: nodeId });
    } else if (e.key === "Delete" || e.key === "Backspace") {
      const childId = nodeId && nodeId !== "__add" ? nodeId : edgeId ? edgeId.split("->")[1] : null;
      if (!childId) return;
      e.preventDefault();
      e.stopPropagation();
      askDetach(childId);
    }
  };
  // A card that gets keyboard focus is selected, so the arrow keys move it at once.
  const onFocusCapture = (e: FocusEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    if (!isAdmin || !el.classList.contains("react-flow__node") || !el.matches(":focus-visible")) return;
    const id = el.dataset.id;
    setNodes((nds) => nds.map((n) => (n.selected === (n.id === id) ? n : { ...n, selected: n.id === id })));
  };

  const ctx: Ctx = { isAdmin, dragging, setDragging, open: setDialog, dropOn, askDetach };
  const unplaced = people.filter((p) => !p.placed);
  const addSpot = nodes.find((n) => n.type === "add")?.position ?? null;
  const teamOf = (managerName: string) => tt("team", { owner: ownerOf(managerName, locale) });

  const detachChild = dialog?.kind === "detach" ? (byId.get(dialog.childId) ?? null) : null;
  const detachManager = detachChild?.managerId ? (byId.get(detachChild.managerId) ?? null) : null;

  return (
    <CanvasCtx value={ctx}>
      <div
        className={cn("tree-canvas relative h-[min(72vh,52rem)] min-h-[32rem] overflow-hidden rounded-lg border border-line bg-board", connecting && "is-connecting")}
        role="region"
        aria-label={t("region")}
        aria-describedby="tree-canvas-help"
        data-saving={pending > 0 ? "1" : "0"}
        data-fitted={fitted ? "1" : undefined}
        onKeyDownCapture={onKeyDownCapture}
        onFocusCapture={onFocusCapture}
      >
        <p id="tree-canvas-help" className="sr-only">
          {isAdmin ? `${t("help")} ${t("keyboardHelp")}` : t("readOnlyHelp")}
        </p>
        <ReactFlow<CanvasNode, ReportEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange}
          onConnect={onConnect}
          onConnectStart={() => setConnecting(true)}
          onConnectEnd={() => setConnecting(false)}
          isValidConnection={isValidConnection}
          onEdgeClick={(_, edge) => setSelectedEdge(edge.id)}
          onPaneClick={() => setSelectedEdge(null)}
          onNodeDoubleClick={(_, node) => isAdmin && node.type === "person" && setDialog({ kind: "edit", id: node.id })}
          nodesDraggable={isAdmin}
          nodesConnectable={isAdmin}
          nodesFocusable
          edgesFocusable
          elementsSelectable
          deleteKeyCode={null}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
          snapToGrid={snapOn}
          snapGrid={[GRID, GRID]}
          fitView
          fitViewOptions={FIT}
          defaultViewport={{ x: 264, y: 84, zoom: 1 }}
          minZoom={0.2}
          maxZoom={1.75}
          nodeDragThreshold={2}
          connectionRadius={36}
          proOptions={{ hideAttribution: true }}
          ariaLabelConfig={{
            "node.a11yDescription.default": isAdmin ? t("nodeDescription") : t("nodeDescriptionReadOnly"),
            "node.a11yDescription.keyboardDisabled": isAdmin ? t("nodeDescription") : t("nodeDescriptionReadOnly"),
            "node.a11yDescription.ariaLiveMessage": ({ direction }: { direction: string }) =>
              t("movedCard", { direction: t(`directions.${direction as "up" | "down" | "left" | "right"}`) }),
            "edge.a11yDescription.default": isAdmin ? t("edgeDescription") : "",
            "controls.ariaLabel": t("controls"),
            "controls.zoomIn.ariaLabel": t("zoomIn"),
            "controls.zoomOut.ariaLabel": t("zoomOut"),
            "controls.fitView.ariaLabel": t("fit"),
            "minimap.ariaLabel": t("minimap"),
          }}
        >
          <Background variant={BackgroundVariant.Dots} gap={GRID * 1.5} size={1.25} />
          <Controls showInteractive={false} position="bottom-left" />
          <MiniMap position="bottom-right" pannable zoomable nodeBorderRadius={8} className="tree-minimap" nodeClassName={(n) => (n.type === "add" ? "tree-minimap-add" : "tree-minimap-node")} />
          <Panel position="top-left" className="!m-3">
            <Tray people={unplaced} />
          </Panel>
          {isAdmin && (
            <Panel position="top-right" className="!m-3 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" onClick={() => void tidy()}>
                {t("tidy")}
              </Button>
              <label className="flex min-h-8 cursor-pointer items-center gap-2 rounded-md border border-control bg-surface px-2 text-sm">
                <input
                  type="checkbox"
                  checked={snapOn}
                  onChange={(e) => {
                    setSnapOn(e.target.checked);
                    store.set("tree-canvas-snap", e.target.checked ? "1" : "0");
                  }}
                />
                {t("snap")}
              </label>
            </Panel>
          )}
          <Panel position="bottom-center" className="pointer-events-none !mb-4">
            <p
              role="status"
              aria-live="polite"
              className={cn(
                "rounded-md px-3 py-1.5 text-sm shadow-lift transition-opacity duration-200",
                status || pending > 0 ? "bg-surface opacity-100" : "opacity-0",
                status?.tone === "error" && "text-red",
              )}
            >
              {status?.text ?? (pending > 0 ? t("saving") : "")}
            </p>
          </Panel>
        </ReactFlow>
      </div>

      <PersonDialog
        dialog={dialog}
        close={() => setDialog(null)}
        people={people}
        byId={byId}
        onAdd={async (input, to) => {
          const manager = typeof to === "object" ? (nodes.find((n) => n.id === to.manager)?.position ?? null) : null;
          const at = manager ? { x: manager.x, y: manager.y + CARD.height + CARD.gapY } : addSpot;
          const r = await run(() => api.addPerson(orgId, input, to, at));
          if (!r?.ok) {
            say(r && "reason" in r && r.reason === "duplicate" ? t("failed") : t("failed"), "error");
            return false;
          }
          const view: TreePersonView = {
            key: `p:${r.id}`,
            personId: r.id,
            userId: null,
            name: input.name,
            role: input.role || null,
            email: input.email || null,
            admin: false,
            you: false,
            placed: to !== "none",
            managerId: typeof to === "object" ? to.manager : null,
            canvas_x: at?.x ?? null,
            canvas_y: at?.y ?? null,
          };
          setPeople((ps) => [...ps, view]);
          if (typeof to === "object") markFresh(r.id);
          say(t("added", { name: input.name }));
          return true;
        }}
        onEdit={async (person, input, to) => {
          const before = people;
          setPeople(people.map((p) => (p.key === person.key ? { ...p, name: input.name, role: input.role || null, email: input.email || null } : p)));
          const changedInfo = input.name !== person.name || input.role !== (person.role ?? "") || input.email !== (person.email ?? "");
          if (changedInfo && person.personId) {
            const r = await run(() => api.editPerson(orgId, person.personId!, input));
            if (!r?.ok) {
              setPeople(before);
              say(t("failed"), "error");
              return false;
            }
          }
          const now = !person.placed ? "none" : (person.managerId ?? "top");
          const next = typeof to === "object" ? to.manager : to;
          if (next !== now) return setManager({ ...person, name: input.name }, to);
          say(t("saved"));
          return true;
        }}
        onManager={(person, to) => void setManager(person, to)}
      />
      <Dialog open={detachChild !== null && detachManager !== null} onOpenChange={(o) => !o && setDialog(null)}>
        {detachChild && detachManager && (
          <DialogContent>
            <DialogBody>
              <DialogTitle>{t("detachTitle", { manager: detachManager.name, child: detachChild.name })}</DialogTitle>
              <DialogDescription>{t("detachText", { child: detachChild.name, team: teamOf(detachManager.name) })}</DialogDescription>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setDialog(null)} autoFocus>
                {t("cancel")}
              </Button>
              <Button
                type="button"
                variant="danger"
                onClick={() => {
                  setSelectedEdge(null);
                  setDialog(null);
                  void setManager(detachChild, "top");
                }}
              >
                {t("detach")}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </CanvasCtx>
  );
}

// ---------------------------------------------------------------------------------------------
// Cards

const PALETTE = ["#e8f1fd", "#e9f8ee", "#fdf1e3", "#f3eefc", "#fdecee", "#eaf6f8"];
const tint = (key: string) => PALETTE[[...key].reduce((s, c) => (s * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE.length];

function Face({ person, size = "md" }: { person: TreePersonView; size?: "md" | "lg" }) {
  return (
    <span
      aria-hidden
      className={cn("inline-flex flex-none items-center justify-center rounded-full font-semibold text-[#171717]", size === "lg" ? "size-11 text-sm" : "size-9 text-xs")}
      style={{ background: tint(person.key) }}
    >
      {initials(person.name)}
    </span>
  );
}

function PersonCard({ id, data, selected, dragging: lifted }: NodeProps<PersonNode>) {
  const t = useTranslations("foretag.tree");
  const ctx = useCanvas();
  const [over, setOver] = useState(false);
  const { person, reports } = data;
  const accepts = (e: DragEvent) => ctx.isAdmin && e.dataTransfer.types.includes(PERSON_MIME);
  return (
    <div
      data-person-card={person.name}
      className={cn(
        "group-card relative flex w-[240px] items-center gap-3 rounded-lg border bg-surface px-3 py-3 text-ink",
        selected ? "border-blue ring-2 ring-blue/25" : "border-line",
        over && "border-blue bg-blue-wash",
        lifted && "is-lifted",
      )}
      onDragOver={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        if (!accepts(e)) return;
        e.preventDefault();
        ctx.dropOn(e.dataTransfer.getData(PERSON_MIME), id);
      }}
    >
      <Handle type="target" position={Position.Top} isConnectable={ctx.isAdmin} aria-hidden className="tree-handle" />
      <Face person={person} size="lg" />
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm leading-5 font-semibold" title={person.name}>
          {person.name}
          {person.you && <span className="ml-1 font-normal text-ink-3">{t("youMark")}</span>}
        </h3>
        {person.role && <p className="truncate text-xs text-ink-2">{person.role}</p>}
        <p className="mt-1 flex items-center gap-1.5 text-xs text-ink-3">
          {person.admin && <Badge tone="info">{t("admin")}</Badge>}
          {reports > 0 && <span>{t("reports", { count: reports })}</span>}
        </p>
      </div>
      {ctx.isAdmin && (
        <button
          type="button"
          tabIndex={-1}
          className="nodrag nopan -mt-6 -mr-1 inline-flex size-7 flex-none items-center justify-center self-start rounded-md text-ink-3 hover:bg-sunk hover:text-ink"
          aria-label={t("edit", { name: person.name })}
          onClick={() => ctx.open({ kind: "edit", id })}
        >
          <IconPencil size={14} />
        </button>
      )}
      {ctx.isAdmin && (
        <button
          type="button"
          tabIndex={-1}
          className="add-report nodrag nopan absolute -bottom-3 left-1/2 inline-flex size-6 translate-x-3 items-center justify-center rounded-full border border-control bg-surface text-ink-2 shadow-sm hover:border-ink-3 hover:text-ink"
          aria-label={t("addReport", { name: person.name })}
          onClick={() => ctx.open({ kind: "add", manager: id })}
        >
          <IconPlus size={12} />
        </button>
      )}
      {over && <p className="pointer-events-none absolute inset-x-0 -bottom-7 text-center text-xs font-medium text-blue">{t("dropHere", { name: person.name })}</p>}
      <Handle type="source" position={Position.Bottom} isConnectable={ctx.isAdmin} aria-hidden className="tree-handle" />
    </div>
  );
}

function AddCard() {
  const t = useTranslations("foretag.tree");
  const ctx = useCanvas();
  return (
    <button
      type="button"
      onClick={() => ctx.open({ kind: "add", manager: null })}
      className="nodrag nopan flex h-[72px] w-[240px] items-center justify-center gap-2 rounded-lg border border-dashed border-control bg-surface/60 text-sm font-medium text-ink-2 transition-colors hover:border-ink-3 hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
    >
      <IconPlus size={18} />
      {t("addPerson")}
    </button>
  );
}

function Tray({ people }: { people: TreePersonView[] }) {
  const t = useTranslations("foretag.tree");
  const ctx = useCanvas();
  const [over, setOver] = useState(false);
  if (!people.length && !ctx.isAdmin) return null;
  return (
    <section
      aria-labelledby="tray-title"
      data-tray
      className={cn("w-56 rounded-lg border bg-surface/95 p-3 shadow-lift backdrop-blur-sm", over ? "border-blue bg-blue-wash" : "border-line")}
      onDragOver={(e) => {
        if (!ctx.isAdmin || !e.dataTransfer.types.includes(PERSON_MIME)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        if (!ctx.isAdmin || !e.dataTransfer.types.includes(PERSON_MIME)) return;
        e.preventDefault();
        ctx.dropOn(e.dataTransfer.getData(PERSON_MIME), null);
      }}
    >
      <h3 id="tray-title" className="text-sm font-semibold">
        {t("unplaced")} <span className="font-normal text-ink-3">{people.length}</span>
      </h3>
      {people.length ? (
        <ul className="mt-2 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
          {people.map((p) => (
            <li key={p.key}>
              {ctx.isAdmin ? (
                <button
                  type="button"
                  draggable
                  data-person={p.name}
                  title={p.name}
                  className={cn(
                    "nodrag nopan inline-flex cursor-grab rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus active:cursor-grabbing",
                    ctx.dragging === p.key && "opacity-40",
                  )}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(PERSON_MIME, p.key);
                    e.dataTransfer.effectAllowed = "move";
                    ctx.setDragging(p.key);
                  }}
                  onDragEnd={() => ctx.setDragging(null)}
                  onClick={() => ctx.open({ kind: "manager", key: p.key })}
                >
                  <Face person={p} />
                  <span className="sr-only">{t("personLabel", { name: p.name, you: p.you ? "yes" : "no" })}</span>
                </button>
              ) : (
                <span className="inline-flex" title={p.name}>
                  <Face person={p} />
                  <span className="sr-only">{p.name}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-xs text-ink-3">{ctx.dragging ? t("unplacedDrop") : t("unplacedEmpty")}</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Arrows: a soft curve from the manager's bottom to the report's top, drawn in when it is new.

function ReportArrow({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, selected, data }: EdgeProps<ReportEdge>) {
  const t = useTranslations("foretag.tree");
  const ctx = useCanvas();
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} className={cn("tree-arrow", data?.fresh && "is-fresh", selected && "is-selected")} pathLength={1} interactionWidth={24} />
      {selected && ctx.isAdmin && (
        <EdgeLabelRenderer>
          <div className="nodrag nopan pointer-events-auto absolute" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
            <Button size="sm" variant="secondary" onClick={() => ctx.askDetach(id.split("->")[1])}>
              {t("detach")}
            </Button>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const NODE_TYPES = { person: PersonCard, add: AddCard };
const EDGE_TYPES = { reports: ReportArrow };

// ---------------------------------------------------------------------------------------------
// The person dialog: add (optionally under someone), edit, or just "Rapporterar till".

function managerValue(p: TreePersonView | null): string {
  if (!p) return "top";
  return !p.placed ? "none" : (p.managerId ?? "top");
}
const toOf = (v: string): ManagerTo => (v === "top" || v === "none" ? v : { manager: v });

function PersonDialog({
  dialog,
  close,
  people,
  byId,
  onAdd,
  onEdit,
  onManager,
}: {
  dialog: Dialogs;
  close: () => void;
  people: TreePersonView[];
  byId: Map<string, TreePersonView>;
  onAdd: (input: PersonInput, to: ManagerTo) => Promise<boolean>;
  onEdit: (person: TreePersonView, input: PersonInput, to: ManagerTo) => Promise<boolean>;
  onManager: (person: TreePersonView, to: ManagerTo) => void;
}) {
  const t = useTranslations("foretag.tree");
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const kind = dialog?.kind;
  const person =
    dialog?.kind === "edit" ? (byId.get(dialog.id) ?? null) : dialog?.kind === "manager" ? (people.find((p) => p.key === dialog.key) ?? null) : null;
  useEffect(() => setConfirmRemove(false), [dialog]);
  const open = kind === "add" || ((kind === "edit" || kind === "manager") && person !== null);
  const rows = asTreeRows(people);
  const allowed = new Set((person?.personId ? parentChoices(rows, person.personId) : rows).map((r) => r.id));
  const options = treeRows(rows).filter((r) => allowed.has(r.group.id));
  const initial = dialog?.kind === "add" ? (dialog.manager ?? "top") : managerValue(person);
  const hasReports = person?.personId ? people.some((p) => p.managerId === person.personId && p.placed) : false;
  const manager = dialog?.kind === "add" && dialog.manager ? byId.get(dialog.manager) : undefined;

  const select = (
    <div className="flex flex-col gap-2">
      <Label htmlFor="canvas-person-manager">{person ? t("reportsToFor", { name: person.name }) : t("reportsTo")}</Label>
      <NativeSelect id="canvas-person-manager" name="to" defaultValue={initial} autoFocus={kind === "manager"}>
        <option value="top">{t("top")}</option>
        <option value="none" disabled={hasReports}>
          {t("none")}
        </option>
        {options.map((r) => (
          <option key={r.group.id} value={r.group.id}>
            {`${" ".repeat(r.depth)}${r.group.name}`}
          </option>
        ))}
      </NativeSelect>
      <p className="text-xs text-ink-3">{t("topHint")}</p>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      {open && (
        <DialogContent aria-describedby={undefined}>
          <form
            action={async (form) => {
              const input = {
                name: form.get("name")?.toString().trim() ?? person?.name ?? "",
                role: form.get("role")?.toString().trim() ?? person?.role ?? "",
                email: form.get("email")?.toString().trim() ?? person?.email ?? "",
              };
              const to = toOf(form.get("to")?.toString() ?? "top");
              if (kind === "manager" && person) {
                onManager(person, to);
                close();
                return;
              }
              if (!input.name) return;
              setBusy(true);
              const ok = kind === "add" ? await onAdd(input, to) : await onEdit(person!, input, to);
              setBusy(false);
              if (ok) close();
            }}
          >
            <DialogBody>
              <DialogTitle>
                {kind === "add" ? (manager ? t("addReport", { name: manager.name }) : t("addTitle")) : kind === "manager" ? t("managerTitle", { name: person!.name }) : t("editTitle", { name: person!.name })}
              </DialogTitle>
              {kind !== "manager" && (
                <>
                  <Field id="canvas-person-name" name="name" label={t("name")} defaultValue={person?.name ?? ""} required maxLength={100} autoFocus />
                  <Field id="canvas-person-email" name="email" type="email" label={t("email")} hint={t("emailHint")} defaultValue={person?.personId ? (person.email ?? "") : ""} maxLength={254} />
                  <Field id="canvas-person-role" name="role" label={t("role")} defaultValue={person?.role ?? ""} maxLength={40} />
                </>
              )}
              {select}
              {kind === "edit" && person?.placed && (
                <div className="mt-1 border-t border-line pt-3">
                  {hasReports ? (
                    <p className="text-xs text-ink-3">{t("refused.hasReports", { name: person.name })}</p>
                  ) : confirmRemove ? (
                    <div className="flex flex-col items-start gap-2">
                      <p className="text-xs text-ink-2">{t("removeText", { name: person.name })}</p>
                      <Button
                        type="button"
                        size="sm"
                        variant="danger"
                        onClick={() => {
                          onManager(person, "none");
                          close();
                        }}
                      >
                        {t("removeConfirm", { name: person.name })}
                      </Button>
                    </div>
                  ) : (
                    <Button type="button" size="sm" variant="danger-quiet" onClick={() => setConfirmRemove(true)}>
                      {t("removeFromTree")}
                    </Button>
                  )}
                </div>
              )}
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close}>
                {t("cancel")}
              </Button>
              <Button type="submit" variant="primary" disabled={busy} icon={kind === "add" ? <IconPlus /> : undefined}>
                {busy ? t("adding") : kind === "add" ? t("add") : t("save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}
