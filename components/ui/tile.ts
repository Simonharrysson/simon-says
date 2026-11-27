// Choice tiles on a card (radio/checkbox labels): no frame, since a frame inside a card is a box in
// a box (docs/ui.md "No double borders"). A quiet tint, a shade darker on hover, darker still when
// chosen; the radio or checkbox inside carries the state for assistive tech.

export const tileClass = "bg-sunk/60 hover:bg-sunk";
export const tileOnClass = "bg-[color-mix(in_srgb,var(--ink)_9%,var(--surface))]";
