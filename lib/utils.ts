import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge must know our own theme keys, or it mistakes `text-2xs` for a colour and
// `shadow-panel` for a shadow colour and drops the wrong class.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["2xs", "display"],
      shadow: ["panel", "lift"],
      spacing: ["gutter"],
      container: ["page"],
      font: ["logo", "system", "heading"],
    },
  },
});

/** Join class names (clsx) and let later Tailwind utilities win over earlier ones (tailwind-merge). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
