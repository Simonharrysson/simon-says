"use client";

import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { reducedMotion } from "@/lib/motion";

type Box = { x: number; y: number; w: number; h: number };
type Mark = { box: Box | null; snap: boolean };

const SLIDE = "transform var(--dur-spring) var(--ease-spring), width var(--dur-spring) var(--ease-spring)";

function measure(root: HTMLElement, key: string | null | undefined): Box | null {
  if (!key) return null;
  const el = root.querySelector<HTMLElement>(`[data-slider-key="${CSS.escape(key)}"]`);
  if (!el) return null;
  const r = root.getBoundingClientRect();
  const b = el.getBoundingClientRect();
  return { x: b.left - r.left, y: b.top - r.top, w: b.width, h: b.height };
}

/**
 * A sliding active marker and hover pill for a row of links (the top rail, a förening's tabs):
 * one element each, moved with transform on the app's spring (width follows; both are absolutely
 * placed, so nothing else lays out). Items carry `data-slider-key`. Until the first measure (the
 * server HTML, no JS) the links' own `aria-current` styles show; once measured, the container
 * gets `data-slider` and CSS hands the look over to the marker (app/globals.css "Sliders").
 * The first placement, a resize and a font swap snap; only a change of item slides. The hover
 * pill is for a mouse only (touch "hovers" on tap) and fades in where it enters.
 */
export function useSlider<T extends HTMLElement>(active: string | undefined) {
  const ref = useRef<T>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [activeMark, setActive] = useState<Mark>({ box: null, snap: true });
  const [hoverMark, setHover] = useState<Mark>({ box: null, snap: true });
  const last = useRef<{ active?: string; hover: string | null }>({ hover: null });

  const place = useCallback(
    (resized: boolean) => {
      const root = ref.current;
      if (!root) return;
      const prev = last.current;
      setActive((m) => ({ box: measure(root, active), snap: resized || !m.box || prev.active === undefined || reducedMotion() }));
      setHover((m) => ({ box: hoverKey ? measure(root, hoverKey) : m.box, snap: resized || !prev.hover || reducedMotion() }));
      last.current = { active, hover: hoverKey };
    },
    [active, hoverKey],
  );

  useLayoutEffect(() => place(false), [place]);

  // Fonts, wrapping and window size move the items without a change of item: follow, don't slide.
  const placeRef = useRef(place);
  placeRef.current = place;
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    let first = true; // observe() reports every size once: nothing has changed yet
    const ro = new ResizeObserver(() => {
      if (first) first = false;
      else placeRef.current(true);
    });
    ro.observe(root);
    root.querySelectorAll("[data-slider-key]").forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, []);

  const style = (mark: Mark, visible: boolean): CSSProperties =>
    mark.box
      ? {
          width: mark.box.w,
          height: mark.box.h,
          transform: `translate(${mark.box.x}px, ${mark.box.y}px)`,
          opacity: visible ? 1 : 0,
          transition: mark.snap ? "opacity 150ms ease" : `${SLIDE}, opacity 150ms ease`,
        }
      : { opacity: 0 };

  return {
    ref,
    ready: activeMark.box !== null,
    activeStyle: style(activeMark, activeMark.box !== null),
    hoverStyle: style(hoverMark, hoverKey !== null && hoverKey !== active),
    hoverProps: {
      onPointerOver: (e: PointerEvent) => {
        if (e.pointerType !== "mouse") return;
        const key = (e.target as Element).closest<HTMLElement>("[data-slider-key]")?.dataset.sliderKey ?? null;
        if (key) setHoverKey(key);
      },
      onPointerLeave: () => setHoverKey(null),
    },
  };
}
