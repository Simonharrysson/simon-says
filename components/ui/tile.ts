// Choice tiles on a card (radio/checkbox labels): no frame, since a frame inside a card is a box in
// a box (docs/ui.md "No double borders"). Unchosen: a visible grey fill (about 1.2:1 against the
// card, light and dark), a step darker on hover. Chosen: inverted, ink with on-ink text (over 10:1
// against the unchosen fill); the radio inside follows. The input carries the state for assistive tech.
// Written out in full: Tailwind only sees literal class names.

export const tileClass = "bg-[color-mix(in_srgb,var(--ink)_10%,var(--surface))] hover:bg-[color-mix(in_srgb,var(--ink)_15%,var(--surface))]";
export const tileOnClass =
  "bg-ink text-on-ink [&_input]:accent-[var(--on-ink)] [&_.text-ink-2]:text-on-ink [&_.text-ink-3]:text-[color-mix(in_srgb,var(--on-ink)_75%,transparent)]";
