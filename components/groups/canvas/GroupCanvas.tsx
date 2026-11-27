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
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChangeset,
  type NodeProps,
} from "@xyflow/react";
import { useTranslations } from "next-intl";
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FocusEvent, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/Field";
import { IconPencil, IconPlus } from "@/components/ui/icons";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { canvasPositions, connectCheck, initials, layoutTree, nextFreeSpot, withParent } from "@/lib/groups/canvas";
import { treeRows, type GroupRow } from "@/lib/foretag/tree";
import { cn } from "@/lib/utils";
import type { CanvasApi, CanvasData, CanvasPerson } from "./types";

// The tree as a canvas (Railway-style, Simon 2026-11-27): cards you drag anywhere (their place is
// saved), arrows from a card's bottom to another's top that ARE the tree (parent_group_id), people
// dragged between cards. Admins edit; members look. Every change is optimistic and rolled back when
// the database refuses it; the list editor (GroupTree) stays the phone view and the "Lista" view.

const PERSON_MIME = "application/x-simon-person";
const GRID = 16;
const AVATARS = 10;
/** Room for the "Utan plats" tray (top left) and the toolbar (top right) when fitting the view. */
const FIT = { padding: { top: "84px", left: "264px", right: "48px", bottom: "56px" }, maxZoom: 1 } as const;

type GroupNodeData = { group: GroupRow; members: CanvasPerson[]; head: CanvasPerson | null; parentName: string | null };
type GroupNode = Node<GroupNodeData, "group">;
type AddNode = Node<Record<string, never>, "add">;
type CanvasNode = GroupNode | AddNode;
type TreeEdge = Edge<{ fresh: boolean; parentName: string; childName: string }, "tree">;

interface Ctx {
  isAdmin: boolean;
  dragging: string | null;
  setDragging: (key: string | null) => void;
  expanded: Set<string>;
  toggleExpanded: (id: string) => void;
  openEdit: (id: string) => void;
  openCreate: () => void;
  openPerson: (key: string) => void;
  drop: (key: string, groupId: string | null) => void;
  askDetach: (childId: string) => void;
}
const CanvasCtx = createContext<Ctx | null>(null);
const useCanvas = () => use(CanvasCtx)!;

const prefersReducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function readSnap(): boolean {
  try {
    return window.localStorage.getItem("tree-canvas-snap") === "1";
  } catch {
    return false;
  }
}

export default function GroupCanvas({ data, api }: { data: CanvasData; api: CanvasApi }) {
  return (
    <ReactFlowProvider>
      <Canvas data={data} api={api} />
    </ReactFlowProvider>
  );
}

type Dialogs =
  | { kind: "edit"; id: string }
  | { kind: "create" }
  | { kind: "person"; key: string }
  | { kind: "detach"; childId: string }
  | null;

function Canvas({ data, api }: { data: CanvasData; api: CanvasApi }) {
  const t = useTranslations("foretag.canvas");
  const flow = useReactFlow<CanvasNode, TreeEdge>();
  const { orgId, isAdmin } = data;

  // Local copies, optimistic; replaced when the server sends new props (after revalidation).
  const [groups, setGroups] = useState(data.groups);
  const [people, setPeople] = useState(data.people);
  useEffect(() => setGroups(data.groups), [data.groups]);
  useEffect(() => setPeople(data.people), [data.people]);

  const rows = useMemo(() => treeRows(groups), [groups]);
  const activeIds = useMemo(() => new Set(rows.map((r) => r.group.id)), [rows]);
  const byId = useMemo(() => new Map(rows.map((r) => [r.group.id, r.group])), [rows]);
  const peopleByKey = useMemo(() => new Map(people.map((p) => [p.key, p])), [people]);

  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [pending, setPending] = useState(0);
  const [status, setStatus] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
  const [snapOn, setSnapOn] = useState(false);
  const [connecting, setConnecting] = useState(false);
  useEffect(() => setSnapOn(readSnap()), []);

  // A dragged avatar that lands on another card unmounts before its dragend: clear it on any drop.
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

  // ---- Nodes: one per active group (+ the "Ny grupp" card for admins), kept in sync with the data.
  const nodeData = useCallback(
    (g: GroupRow): GroupNodeData => {
      const members = people.filter((p) => p.groupId === g.id);
      const head = g.head_person_id ? (people.find((p) => p.personId === g.head_person_id) ?? null) : null;
      const parent = g.parent_group_id ? byId.get(g.parent_group_id) : undefined;
      return { group: g, members, head, parentName: parent?.name ?? null };
    },
    [people, byId],
  );

  useEffect(() => {
    setNodes((prev) => {
      const before = new Map(prev.map((n) => [n.id, n]));
      const placed = canvasPositions(groups);
      const out: CanvasNode[] = rows.map(({ group }) => {
        const old = before.get(group.id) as GroupNode | undefined;
        const d = nodeData(group);
        return {
          ...(old ?? {}),
          id: group.id,
          type: "group",
          position: old?.position ?? placed.get(group.id) ?? { x: 0, y: 0 },
          data: d,
          draggable: isAdmin,
          connectable: isAdmin,
          deletable: false,
          ariaLabel: t("nodeLabel", { name: group.name, count: d.members.length, parent: d.parentName ?? "none" }),
        } satisfies GroupNode;
      });
      if (isAdmin) {
        const old = before.get("__add");
        const spot = nextFreeSpot(out.map((n) => n.position));
        out.push({
          ...(old ?? {}),
          id: "__add",
          type: "add",
          position: old && out.length === prev.filter((n) => n.type === "group").length ? old.position : spot,
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
  }, [rows, groups, nodeData, isAdmin, t]);

  const edges: TreeEdge[] = useMemo(
    () =>
      rows.flatMap(({ group }) => {
        const parent = group.parent_group_id && activeIds.has(group.parent_group_id) ? byId.get(group.parent_group_id)! : null;
        if (!parent) return [];
        return [
          {
            id: `${parent.id}->${group.id}`,
            type: "tree",
            source: parent.id,
            target: group.id,
            deletable: false,
            selectable: true,
            focusable: true,
            ariaLabel: t("edgeLabel", { parent: parent.name, child: group.name }),
            markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
            data: { fresh: fresh.has(group.id), parentName: parent.name, childName: group.name },
          } satisfies TreeEdge,
        ];
      }),
    [rows, activeIds, byId, fresh, t],
  );
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const shownEdges = useMemo(() => edges.map((e) => ({ ...e, selected: e.id === selectedEdge })), [edges, selectedEdge]);

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
      const n = nodesRef.current.find((x) => x.id === id && x.type === "group");
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

  // ---- Arrows
  const isValidConnection = useCallback((c: Connection | Edge) => connectCheck(groups, c.source, c.target).ok, [groups]);

  const markFresh = (childId: string) => {
    setFresh((s) => new Set(s).add(childId));
    window.setTimeout(
      () =>
        setFresh((s) => {
          const next = new Set(s);
          next.delete(childId);
          return next;
        }),
      900,
    );
  };

  const setParent = useCallback(
    async (childId: string, parentId: string | null) => {
      const child = byId.get(childId);
      if (!child) return;
      const before = groups;
      const old = child.parent_group_id ? byId.get(child.parent_group_id) : undefined;
      setGroups(withParent(groups, childId, parentId));
      if (parentId) markFresh(childId);
      const r = await run(() => api.setParent(orgId, childId, child.name, parentId));
      if (!r?.ok) {
        setGroups(before);
        say(t("failed"), "error");
        return;
      }
      const parent = parentId ? byId.get(parentId) : undefined;
      if (!parent) say(t("detached", { child: child.name }));
      else if (old) say(t("replaced", { child: child.name, old: old.name, parent: parent.name }));
      else say(t("connected", { child: child.name, parent: parent.name }));
    },
    [api, byId, groups, orgId, run, say, t],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      const check = connectCheck(groups, c.source, c.target);
      const names = { parent: byId.get(c.source)?.name ?? "", child: byId.get(c.target)?.name ?? "" };
      if (!check.ok) {
        say(t(`refused.${check.reason}`, names), "error");
        return;
      }
      void setParent(c.target, c.source);
    },
    [byId, groups, say, setParent, t],
  );

  const askDetach = useCallback(
    (childId: string) => {
      const child = byId.get(childId);
      if (!child) return;
      if (!child.parent_group_id || !activeIds.has(child.parent_group_id)) {
        say(t("noArrow", { name: child.name }), "error");
        return;
      }
      setDialog({ kind: "detach", childId });
    },
    [activeIds, byId, say, t],
  );

  // ---- People
  const drop = useCallback(
    async (key: string, groupId: string | null) => {
      const person = peopleByKey.get(key);
      if (!person || person.groupId === groupId) return;
      const before = people;
      setPeople(people.map((p) => (p.key === key ? { ...p, groupId } : p)));
      const who = person.personId ? { personId: person.personId } : { userId: person.userId!, name: person.email?.split("@")[0] ?? person.name };
      const r = await run(() => api.place(orgId, who, groupId));
      if (!r?.ok) {
        setPeople(before);
        say(t("failed"), "error");
        return;
      }
      say(groupId ? t("moved", { name: person.name, group: byId.get(groupId)?.name ?? "" }) : t("unplacedNow", { name: person.name }));
    },
    [api, byId, orgId, people, peopleByKey, run, say, t],
  );

  // ---- Auto layout ("Ordna automatiskt"): tidy top-down, animated by the cards' CSS transition.
  const tidy = useCallback(async () => {
    const layout = layoutTree(groups);
    const spot = nextFreeSpot(layout.values());
    setNodes((nds) => nds.map((n) => (n.type === "add" ? { ...n, position: spot } : layout.has(n.id) ? { ...n, position: layout.get(n.id)! } : n)));
    window.setTimeout(() => void flow.fitView({ ...FIT, duration: prefersReducedMotion() ? 0 : 450 }), 30);
    const positions = [...layout].map(([id, p]) => ({ id, ...p }));
    const r = await run(() => api.savePositions(orgId, positions));
    if (!r?.ok) say(t("failed"), "error");
  }, [api, flow, groups, orgId, run, say, t]);

  // ---- Keyboard: Enter edits the focused card, Delete removes the arrow above it (or the selected arrow).
  const onKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("input, select, textarea, [role=dialog]")) return;
    const nodeEl = target.classList.contains("react-flow__node") ? target : null;
    const edgeEl = target.closest(".react-flow__edge");
    const nodeId = nodeEl?.dataset.id;
    if (!isAdmin) return;
    if (e.key === "Enter" && nodeId && nodeId !== "__add") {
      e.preventDefault();
      e.stopPropagation();
      setDialog({ kind: "edit", id: nodeId });
    } else if (e.key === "Delete" || e.key === "Backspace") {
      const edgeId = edgeEl?.getAttribute("data-id") ?? selectedEdge;
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

  const ctx: Ctx = {
    isAdmin,
    dragging,
    setDragging,
    expanded,
    toggleExpanded: (id) =>
      setExpanded((s) => {
        const next = new Set(s);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    openEdit: (id) => setDialog({ kind: "edit", id }),
    openCreate: () => setDialog({ kind: "create" }),
    openPerson: (key) => setDialog({ kind: "person", key }),
    drop: (key, groupId) => void drop(key, groupId),
    askDetach,
  };

  const unplaced = people.filter((p) => !p.groupId || !activeIds.has(p.groupId));
  const addNode = nodes.find((n) => n.type === "add");

  return (
    <CanvasCtx value={ctx}>
      <div
        className={cn("tree-canvas relative h-[min(72vh,52rem)] min-h-[32rem] overflow-hidden rounded-lg border border-line bg-board", connecting && "is-connecting")}
        role="region"
        aria-label={t("region")}
        aria-describedby="tree-canvas-help"
        data-saving={pending > 0 ? "1" : "0"}
        onKeyDownCapture={onKeyDownCapture}
        onFocusCapture={onFocusCapture}
      >
        <p id="tree-canvas-help" className="sr-only">
          {isAdmin ? `${t("help")} ${t("keyboardHelp")}` : t("readOnlyHelp")}
        </p>
        <ReactFlow<CanvasNode, TreeEdge>
          nodes={nodes}
          edges={shownEdges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange}
          onConnect={onConnect}
          onConnectStart={() => setConnecting(true)}
          onConnectEnd={() => setConnecting(false)}
          isValidConnection={isValidConnection}
          onEdgeClick={(_, edge) => setSelectedEdge(edge.id)}
          onPaneClick={() => setSelectedEdge(null)}
          onNodeDoubleClick={(_, node) => isAdmin && node.type === "group" && setDialog({ kind: "edit", id: node.id })}
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
                    try {
                      window.localStorage.setItem("tree-canvas-snap", e.target.checked ? "1" : "0");
                    } catch {}
                  }}
                />
                {t("snap")}
              </label>
            </Panel>
          )}
          <Panel position="bottom-center" className="!mb-4 pointer-events-none">
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

      <EditDialog dialog={dialog} close={() => setDialog(null)} byId={byId} people={people} rows={rows} data={data} api={api} run={run} say={say} setGroups={setGroups} groups={groups} />
      <CreateDialog
        open={dialog?.kind === "create"}
        close={() => setDialog(null)}
        rows={rows}
        onCreate={async (name, parentId) => {
          const at = addNode?.position ?? nextFreeSpot(nodes.map((n) => n.position));
          const r = await run(() => api.create(orgId, name, parentId, at));
          if (!r?.ok) {
            say(t("failed"), "error");
            return false;
          }
          // Shown at once where it was asked for; the page's data (revalidation) then replaces it.
          setGroups((gs) => withParent([...gs, { id: r.id, name, parent_group_id: parentId, depth: 0, position: 0, canvas_x: at.x, canvas_y: at.y }], r.id, parentId));
          if (parentId) markFresh(r.id);
          say(t("created", { name }));
          return true;
        }}
      />
      <PersonDialog
        person={dialog?.kind === "person" ? (peopleByKey.get(dialog.key) ?? null) : null}
        rows={rows}
        close={() => setDialog(null)}
        onMove={(key, groupId) => void drop(key, groupId)}
      />
      <DetachDialog
        child={dialog?.kind === "detach" ? (byId.get(dialog.childId) ?? null) : null}
        parent={dialog?.kind === "detach" ? (byId.get(byId.get(dialog.childId)?.parent_group_id ?? "") ?? null) : null}
        close={() => setDialog(null)}
        onDetach={(childId) => {
          setSelectedEdge(null);
          void setParent(childId, null);
        }}
      />
    </CanvasCtx>
  );
}

// ---------------------------------------------------------------------------------------------
// Cards

function GroupCard({ id, data, selected, dragging: draggingCard }: NodeProps<GroupNode>) {
  const t = useTranslations("foretag.canvas");
  const ctx = useCanvas();
  const [over, setOver] = useState(false);
  const { group, members, head } = data;
  const open = ctx.expanded.has(id);
  const shown = open ? members : members.slice(0, AVATARS);
  const hidden = members.length - shown.length;

  const accepts = (e: DragEvent) => ctx.isAdmin && e.dataTransfer.types.includes(PERSON_MIME);
  return (
    <div
      data-group-card={group.name}
      className={cn(
        "group-card relative w-[264px] rounded-lg border bg-surface px-4 pt-3 pb-4 text-ink",
        selected ? "border-blue ring-2 ring-blue/25" : "border-line",
        over && "border-blue bg-blue-wash",
        draggingCard && "is-lifted",
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
        ctx.drop(e.dataTransfer.getData(PERSON_MIME), group.id);
      }}
    >
      <Handle type="target" position={Position.Top} isConnectable={ctx.isAdmin} aria-hidden title={t("handleIn", { name: group.name })} className="tree-handle" />
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 text-base leading-6 font-semibold wrap-anywhere">{group.name}</h3>
        {ctx.isAdmin && (
          <button
            type="button"
            className="nodrag nopan -mt-1 -mr-2 inline-flex size-8 flex-none items-center justify-center rounded-md text-ink-3 hover:bg-sunk hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
            aria-label={t("edit", { name: group.name })}
            onClick={() => ctx.openEdit(group.id)}
            tabIndex={-1}
          >
            <IconPencil size={16} />
          </button>
        )}
      </div>
      <p className="mt-0.5 text-xs text-ink-3">
        {head ? t("head", { name: head.name }) : t("people", { count: members.length })}
        {head && <> · {t("people", { count: members.length })}</>}
      </p>
      <ul className="mt-3 flex min-h-9 flex-wrap gap-1.5" aria-label={t("people", { count: members.length })}>
        {shown.map((p) => (
          <li key={p.key}>
            <Avatar person={p} />
          </li>
        ))}
        {hidden > 0 && (
          <li>
            <button
              type="button"
              className="nodrag nopan inline-flex size-9 items-center justify-center rounded-full border border-dashed border-control text-xs font-medium text-ink-2 hover:bg-sunk"
              aria-label={t("moreLabel", { count: hidden })}
              onClick={() => ctx.toggleExpanded(id)}
            >
              {t("more", { count: hidden })}
            </button>
          </li>
        )}
        {open && members.length > AVATARS && (
          <li>
            <button type="button" className="nodrag nopan min-h-9 px-2 text-xs text-ink-2 underline" onClick={() => ctx.toggleExpanded(id)}>
              {t("fewer")}
            </button>
          </li>
        )}
      </ul>
      {over && <p className="pointer-events-none absolute inset-x-0 -bottom-7 text-center text-xs font-medium text-blue">{t("dropHere")}</p>}
      <Handle type="source" position={Position.Bottom} isConnectable={ctx.isAdmin} aria-hidden title={t("handleOut", { name: group.name })} className="tree-handle" />
    </div>
  );
}

function AddCard() {
  const t = useTranslations("foretag.canvas");
  const ctx = useCanvas();
  return (
    <button
      type="button"
      onClick={ctx.openCreate}
      className="nodrag nopan flex h-[132px] w-[264px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-control bg-surface/60 text-sm font-medium text-ink-2 transition-colors hover:border-ink-3 hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
    >
      <IconPlus size={20} />
      {t("addGroup")}
    </button>
  );
}

const PALETTE = ["#e8f1fd", "#e9f8ee", "#fdf1e3", "#f3eefc", "#fdecee", "#eaf6f8"];
const tint = (key: string) => PALETTE[[...key].reduce((s, c) => (s * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE.length];

function Avatar({ person }: { person: CanvasPerson }) {
  const t = useTranslations("foretag.canvas");
  const ctx = useCanvas();
  const face = (
    <span
      aria-hidden
      className={cn("inline-flex size-9 items-center justify-center rounded-full text-xs font-semibold text-[#171717] ring-2 ring-surface", person.admin && "ring-blue/40")}
      style={{ background: tint(person.key) }}
    >
      {initials(person.name)}
    </span>
  );
  if (!ctx.isAdmin) {
    return (
      <span className="inline-flex" title={person.name}>
        {face}
        <span className="sr-only">{t("personLabelReadOnly", { name: person.name, you: person.you ? "yes" : "no" })}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      draggable
      data-person={person.name}
      title={person.name}
      className={cn(
        "nodrag nopan avatar-drag inline-flex cursor-grab rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus active:cursor-grabbing",
        ctx.dragging === person.key && "opacity-40",
      )}
      onDragStart={(e) => {
        e.dataTransfer.setData(PERSON_MIME, person.key);
        e.dataTransfer.effectAllowed = "move";
        ctx.setDragging(person.key);
      }}
      onDragEnd={() => ctx.setDragging(null)}
      onClick={() => ctx.openPerson(person.key)}
    >
      {face}
      <span className="sr-only">{t("personLabel", { name: person.name, you: person.you ? "yes" : "no" })}</span>
    </button>
  );
}

function Tray({ people }: { people: CanvasPerson[] }) {
  const t = useTranslations("foretag.canvas");
  const ctx = useCanvas();
  const [over, setOver] = useState(false);
  if (!people.length && !ctx.isAdmin) return null;
  return (
    <section
      aria-labelledby="tray-title"
      data-tray
      className={cn("w-56 rounded-lg border bg-surface/95 p-3 shadow-lift backdrop-blur-sm", over ? "border-blue bg-blue-wash" : "border-line", !people.length && !ctx.dragging && "opacity-80")}
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
        ctx.drop(e.dataTransfer.getData(PERSON_MIME), null);
      }}
    >
      <h3 id="tray-title" className="text-sm font-semibold">
        {t("unplaced")} <span className="font-normal text-ink-3">{people.length}</span>
      </h3>
      {people.length ? (
        <ul className="mt-2 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
          {people.map((p) => (
            <li key={p.key}>
              <Avatar person={p} />
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
// Arrows: a soft curve from the parent's bottom to the child's top, drawn in when it is new.

function TreeArrow({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, selected, data }: EdgeProps<TreeEdge>) {
  const t = useTranslations("foretag.canvas");
  const ctx = useCanvas();
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const childId = id.split("->")[1];
  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} className={cn("tree-arrow", data?.fresh && "is-fresh", selected && "is-selected")} pathLength={1} interactionWidth={24} />
      {selected && ctx.isAdmin && (
        <EdgeLabelRenderer>
          <div className="nodrag nopan pointer-events-auto absolute" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
            <Button size="sm" variant="secondary" onClick={() => ctx.askDetach(childId)}>
              {t("detach")}
            </Button>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const NODE_TYPES = { group: GroupCard, add: AddCard };
const EDGE_TYPES = { tree: TreeArrow };

// ---------------------------------------------------------------------------------------------
// Dialogs

function groupOptions(rows: { group: GroupRow; depth: number }[], except?: Set<string>) {
  return rows
    .filter((r) => !except?.has(r.group.id))
    .map((r) => (
      <option key={r.group.id} value={r.group.id}>
        {`${" ".repeat(r.depth)}${r.group.name}`}
      </option>
    ));
}

function EditDialog({
  dialog,
  close,
  byId,
  people,
  rows,
  data,
  api,
  run,
  say,
  groups,
  setGroups,
}: {
  dialog: Dialogs;
  close: () => void;
  byId: Map<string, GroupRow>;
  people: CanvasPerson[];
  rows: { group: GroupRow; depth: number }[];
  data: CanvasData;
  api: CanvasApi;
  run: <T>(w: () => Promise<T>) => Promise<T | null>;
  say: (text: string, tone?: "ok" | "error") => void;
  groups: GroupRow[];
  setGroups: (g: GroupRow[]) => void;
}) {
  const t = useTranslations("foretag.canvas");
  const group = dialog?.kind === "edit" ? (byId.get(dialog.id) ?? null) : null;
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setConfirmArchive(false), [group?.id]);
  if (!group) return <Dialog open={false} />;
  const named = people.filter((p) => p.personId).sort((a, b) => a.name.localeCompare(b.name, "sv"));
  const hasChildren = rows.some((r) => r.group.parent_group_id === group.id);
  const canArchive = !data.keepLastGroup || rows.length > 1;

  const save = async (form: FormData) => {
    const name = form.get("name")?.toString().trim() ?? "";
    const head = form.get("head")?.toString() || null;
    setBusy(true);
    const before = groups;
    setGroups(groups.map((g) => (g.id === group.id ? { ...g, name: name || g.name, head_person_id: head } : g)));
    const results = await Promise.all([
      name && name !== group.name ? run(() => api.rename(data.orgId, group.id, name, group.parent_group_id)) : Promise.resolve({ ok: true as const }),
      head !== (group.head_person_id ?? null) ? run(() => api.setHead(data.orgId, group.id, head)) : Promise.resolve({ ok: true as const }),
    ]);
    setBusy(false);
    if (results.some((r) => !r?.ok)) {
      setGroups(before);
      say(t("failed"), "error");
      return;
    }
    say(t("saved"));
    close();
  };

  const archive = async () => {
    setBusy(true);
    const r = await run(() => api.archive(data.orgId, group.id));
    setBusy(false);
    if (!r?.ok) {
      say(t("failed"), "error");
      return;
    }
    setGroups(groups.map((g) => (g.id === group.id ? { ...g, archived_at: new Date().toISOString() } : g)));
    say(t("archived", { name: group.name }));
    close();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent aria-describedby={undefined}>
        <form action={save}>
          <DialogBody>
            <DialogTitle>{t("editTitle", { name: group.name })}</DialogTitle>
            <Field id="canvas-group-name" name="name" label={t("name")} defaultValue={group.name} required maxLength={40} autoFocus />
            <div className="flex flex-col gap-2">
              <Label htmlFor="canvas-group-head">{t("headField")}</Label>
              <NativeSelect id="canvas-group-head" name="head" defaultValue={group.head_person_id ?? ""} aria-describedby="canvas-group-head-hint">
                <option value="">{t("noHead")}</option>
                {named.map((p) => (
                  <option key={p.key} value={p.personId!}>
                    {p.name}
                  </option>
                ))}
              </NativeSelect>
              <p id="canvas-group-head-hint" className="text-xs text-ink-3">
                {t("headHint")}
              </p>
            </div>
            {canArchive && (
              <div className="mt-2 border-t border-line pt-3">
                {hasChildren ? (
                  <p className="text-xs text-ink-3">{t("archiveBlocked")}</p>
                ) : confirmArchive ? (
                  <Button type="button" size="sm" variant="danger" disabled={busy} onClick={() => void archive()}>
                    {t("archiveConfirm", { name: group.name })}
                  </Button>
                ) : (
                  <Button type="button" size="sm" variant="danger-quiet" onClick={() => setConfirmArchive(true)}>
                    {t("archive")}
                  </Button>
                )}
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              {t("cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? t("saving") : t("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateDialog({ open, close, rows, onCreate }: { open: boolean; close: () => void; rows: { group: GroupRow; depth: number }[]; onCreate: (name: string, parentId: string | null) => Promise<boolean> }) {
  const t = useTranslations("foretag.canvas");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <form
          action={async (form) => {
            const name = form.get("name")?.toString().trim() ?? "";
            if (!name) return;
            setBusy(true);
            const ok = await onCreate(name, form.get("parentId")?.toString() || null);
            setBusy(false);
            if (ok) close();
          }}
        >
          <DialogBody>
            <DialogTitle>{t("createTitle")}</DialogTitle>
            <DialogDescription>{t("createText")}</DialogDescription>
            <Field id="canvas-new-name" name="name" label={t("name")} required maxLength={40} autoFocus />
            <div className="flex flex-col gap-2">
              <Label htmlFor="canvas-new-parent">{t("under")}</Label>
              <NativeSelect id="canvas-new-parent" name="parentId" defaultValue="">
                <option value="">{t("top")}</option>
                {groupOptions(rows)}
              </NativeSelect>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              {t("cancel")}
            </Button>
            <Button type="submit" variant="primary" icon={<IconPlus />} disabled={busy}>
              {busy ? t("creating") : t("create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PersonDialog({ person, rows, close, onMove }: { person: CanvasPerson | null; rows: { group: GroupRow; depth: number }[]; close: () => void; onMove: (key: string, groupId: string | null) => void }) {
  const t = useTranslations("foretag.canvas");
  const tp = useTranslations("foretag.people");
  return (
    <Dialog open={person !== null} onOpenChange={(o) => !o && close()}>
      {person && (
        <DialogContent aria-describedby={undefined}>
          <form
            action={(form) => {
              onMove(person.key, form.get("groupId")?.toString() || null);
              close();
            }}
          >
            <DialogBody>
              <DialogTitle>{t("personTitle", { name: person.name })}</DialogTitle>
              <div className="flex flex-col gap-2">
                <Label htmlFor="canvas-person-group">{t("personField", { name: person.name })}</Label>
                <NativeSelect id="canvas-person-group" name="groupId" defaultValue={person.groupId ?? ""} autoFocus>
                  <option value="">{tp("noPlace")}</option>
                  {groupOptions(rows)}
                </NativeSelect>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close}>
                {t("cancel")}
              </Button>
              <Button type="submit" variant="primary">
                {t("move")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}

function DetachDialog({ child, parent, close, onDetach }: { child: GroupRow | null; parent: GroupRow | null; close: () => void; onDetach: (childId: string) => void }) {
  const t = useTranslations("foretag.canvas");
  const open = child !== null && parent !== null;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      {open && (
        <DialogContent>
          <DialogBody>
            <DialogTitle>{t("detachTitle", { parent: parent.name, child: child.name })}</DialogTitle>
            <DialogDescription>{t("detachText", { parent: parent.name, child: child.name })}</DialogDescription>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close} autoFocus>
              {t("cancel")}
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                onDetach(child.id);
                close();
              }}
            >
              {t("detach")}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
