// The Google Doc keeps its own look wherever we draw it (landing demo, format preview): white
// paper in a system face, Google's greys, in both themes, so people recognise "that's the Doc".

export const docPaperClass =
  "rounded-[4px] bg-white px-[clamp(1.25rem,3.5vw,2.25rem)] pt-[clamp(1.25rem,3vw,2rem)] pb-[clamp(1.5rem,3vw,2.25rem)] font-system text-[clamp(0.8125rem,0.75rem+0.3vw,0.9375rem)] leading-normal text-[#202124] shadow-[0_0_0_1px_rgb(0_0_0/0.08),0_4px_12px_-6px_rgb(0_0_0/0.12)]";
export const docTitleClass = "text-[1.45em] leading-tight font-semibold tracking-[-0.01em]";
export const docLiveClass = "mt-[0.2em] text-[0.85em] font-semibold text-[#b3261e]";
export const docAttendClass = "mt-[0.75em] text-[#5f6368]";
export const docHeadingClass =
  "mt-[1.1em] border-b border-[#e0e0e0] pb-[0.2em] text-[0.8em] font-bold tracking-[0.06em] text-[#5f6368] uppercase";
export const docLineClass = "mt-[0.4em] flex items-baseline gap-[0.55em]";
export const docCheckClass = "font-bold text-[#137333]";
/** An empty task box in the Doc. */
export const docBoxClass = "inline-block size-[0.8em] flex-none translate-y-[0.08em] rounded-[2px] border-[1.5px] border-current opacity-70";
export const docNowClass = "text-[#3c4043] italic";
