import type { Page } from "@playwright/test";

// No double borders (e2e/specs/borders.spec.ts). Inside a card, never a second full frame: a
// bordered (or ring-outlined) box that sits in a framed card with a small inset and most of its
// width reads as a box in a box, and two lines whose edges touch read as one thick line. Controls
// (inputs, selects, textareas, buttons and what is inside them) are left out: they are framed on
// purpose. So are table cells (a table's grid) and faithful pictures of another product's UI
// (`data-picture`: the invite e-mail as Gmail shows it), and anything hidden from assistive tech.

export interface BorderOffender {
  kind: "box-in-box" | "touching-ancestor" | "touching-sibling";
  /** The element: tag, classes and the start of its text. */
  element: string;
  /** The framed card it sits in, or the sibling it touches. */
  other: string;
  detail: string;
}

/** Run in the page: every visible double border on it. */
export function auditBorders(page: Page, opts: { maxInset?: number; minWidthShare?: number; touch?: number } = {}): Promise<BorderOffender[]> {
  return page.evaluate(({ maxInset, minWidthShare, touch }) => {
    type Side = "top" | "right" | "bottom" | "left";
    const SIDES: Side[] = ["top", "right", "bottom", "left"];
    const CONTROL = "input, textarea, select, button, [role=button], [role=checkbox], [role=switch], [role=radio], [role=combobox], [role=slider], [data-slot=button], nextjs-portal";

    const describe = (el: Element): string => {
      const cls = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean).slice(0, 8).join(".");
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 70);
      return `<${el.tagName.toLowerCase()}${cls ? "." + cls : ""}> "${text}"`;
    };
    const opaque = (color: string): boolean => {
      const m = color.match(/rgba?\(([^)]+)\)/) ?? color.match(/color\(srgb ([^)]+)\)/);
      if (!m) return color !== "transparent";
      const parts = m[1].split(/[\s,/]+/).filter(Boolean);
      const alpha = parts.length >= 4 ? Number(parts[3]) : 1;
      return alpha > 0.05;
    };
    /** Which sides draw a line (a border, or a ring box-shadow on all four). */
    const lines = (el: Element): Record<Side, boolean> => {
      const cs = getComputedStyle(el);
      const out = { top: false, right: false, bottom: false, left: false };
      for (const s of SIDES) {
        const style = cs.getPropertyValue(`border-${s}-style`);
        const width = parseFloat(cs.getPropertyValue(`border-${s}-width`));
        if (style !== "none" && style !== "hidden" && width > 0 && opaque(cs.getPropertyValue(`border-${s}-color`))) out[s] = true;
      }
      // A ring: a box-shadow with no offset or blur and a spread (Tailwind ring-*, shadow-panel).
      const shadow = cs.boxShadow;
      if (shadow && shadow !== "none") {
        const layers = shadow.split(/,(?![^(]*\))/);
        for (const layer of layers) {
          const color = layer.match(/(rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-f]+)/i)?.[0] ?? "";
          const nums = layer.replace(color, "").match(/-?[\d.]+px/g)?.map(parseFloat) ?? [];
          const [x = 0, y = 0, blur = 0, spread = 0] = nums;
          if (x === 0 && y === 0 && blur === 0 && spread > 0 && opaque(color)) {
            for (const s of SIDES) out[s] = true;
          }
        }
      }
      return out;
    };
    const framed = (l: Record<Side, boolean>) => SIDES.filter((s) => l[s]).length >= 3;
    const visible = (el: Element, r: DOMRect): boolean => {
      if (r.width < 8 || r.height < 8) return false;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "contents") return false;
      if (el.closest("[aria-hidden=true], [hidden], [inert]")) return false;
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
      return true;
    };

    interface Box {
      el: Element;
      r: DOMRect;
      l: Record<Side, boolean>;
    }
    const all: Box[] = [];
    for (const el of document.body.querySelectorAll("*")) {
      if (el.matches(CONTROL) || el.closest(CONTROL) || el.closest("td, th, [data-picture]")) continue;
      const l = lines(el);
      if (!SIDES.some((s) => l[s])) continue;
      const r = el.getBoundingClientRect();
      if (!visible(el, r)) continue;
      all.push({ el, r, l });
    }
    const byEl = new Map(all.map((b) => [b.el, b]));
    const nearestFramed = (el: Element): Box | null => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const b = byEl.get(p);
        if (b && framed(b.l)) return b;
      }
      return null;
    };

    const found: BorderOffender[] = [];
    for (const b of all) {
      const card = nearestFramed(b.el);
      if (card) {
        const inset = { top: b.r.top - card.r.top, right: card.r.right - b.r.right, bottom: card.r.bottom - b.r.bottom, left: b.r.left - card.r.left };
        if (framed(b.l)) {
          const share = b.r.width / card.r.width;
          if (share > minWidthShare && Math.max(inset.left, inset.right) <= maxInset) {
            found.push({
              kind: "box-in-box",
              element: describe(b.el),
              other: describe(card.el),
              detail: `inset ${Math.round(inset.left)}/${Math.round(inset.right)} px, ${Math.round(share * 100)} % of the card's width`,
            });
            continue;
          }
        }
        // A line on the card's own edge: two lines where one is drawn.
        const touching = SIDES.filter((s) => b.l[s] && Math.abs(inset[s]) <= touch);
        if (touching.length) {
          found.push({ kind: "touching-ancestor", element: describe(b.el), other: describe(card.el), detail: `${touching.join(", ")} edge on the card's edge` });
          continue;
        }
      }
      // Two framed siblings stacked edge to edge.
      if (framed(b.l)) {
        for (let s = b.el.nextElementSibling; s; s = s.nextElementSibling) {
          const o = byEl.get(s);
          if (!o || !framed(o.l)) continue;
          const overlapX = Math.min(b.r.right, o.r.right) - Math.max(b.r.left, o.r.left);
          const overlapY = Math.min(b.r.bottom, o.r.bottom) - Math.max(b.r.top, o.r.top);
          const gapY = Math.max(o.r.top - b.r.bottom, b.r.top - o.r.bottom);
          const gapX = Math.max(o.r.left - b.r.right, b.r.left - o.r.right);
          if ((overlapX > 8 && gapY <= touch) || (overlapY > 8 && gapX <= touch)) {
            found.push({ kind: "touching-sibling", element: describe(b.el), other: describe(o.el), detail: `${Math.round(Math.max(gapX, gapY))} px apart` });
          }
        }
      }
    }
    return found;
  }, { maxInset: opts.maxInset ?? 48, minWidthShare: opts.minWidthShare ?? 0.7, touch: opts.touch ?? 2 });
}

export const formatOffenders = (where: string, list: BorderOffender[]): string[] =>
  list.map((o) => `${where}: ${o.kind} ${o.element} in/next to ${o.other} (${o.detail})`);
