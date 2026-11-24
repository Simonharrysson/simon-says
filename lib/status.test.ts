import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { StatusView } from "@/components/views/StatusView";
import { loadStatus } from "./status";

const NOW = new Date("2026-11-24T12:00:00Z");

// Minimal query-builder fake. It deliberately ignores .eq("show_on_status") so the test also
// proves loadStatus re-checks the flag itself.
function fakeDb(tables: Record<string, Record<string, unknown>[]>, startedCount = 4) {
  const make = (table: string, head = false) => {
    const b: Record<string, unknown> = {};
    const result = () => ({ data: head ? null : tables[table], count: startedCount, error: null });
    for (const m of ["in", "eq", "gte"]) b[m] = () => b;
    b.then = (res: (v: unknown) => unknown) => Promise.resolve(result()).then(res);
    return b;
  };
  return {
    from: (table: string) => ({
      select: (_cols: string, opts?: { head?: boolean }) => make(table, opts?.head),
    }),
  } as unknown as SupabaseClient;
}

const tables = {
  meetings: [
    { id: "m1", org_id: "o1", started_at: "2026-11-24T11:00:00Z", failed_ticks: 0 },
    { id: "m2", org_id: "o2", started_at: "2026-11-24T11:30:00Z", failed_ticks: 0 },
  ],
  orgs: [
    { id: "o1", name: "Synliga Föreningen", show_on_status: true },
    { id: "o2", name: "Hemliga Klubben", show_on_status: false },
  ],
  usage_daily: [{ seconds: 3600 }, { seconds: 1830 }],
};

describe("loadStatus", () => {
  it("returns names only for opted-in orgs and aggregates", async () => {
    const data = await loadStatus(fakeDb(tables), false, NOW);
    expect(data.liveMeetings.map((m) => m.orgName)).toEqual(["Synliga Föreningen", null]);
    expect(data.minutesThisWeek).toBe(91);
    expect(data.meetingsThisWeek).toBe(4);
    expect(data.health).toBe("ok");
    expect(JSON.stringify(data)).not.toContain("Hemliga Klubben");
  });

  it("reports paused on the kill switch and degraded on repeated failed ticks", async () => {
    expect((await loadStatus(fakeDb(tables), true, NOW)).health).toBe("paused");
    const failing = { ...tables, meetings: [{ ...tables.meetings[0], failed_ticks: 3 }] };
    expect((await loadStatus(fakeDb(failing), false, NOW)).health).toBe("degraded");
  });

  it("keeps a non-opted-in org name out of the rendered HTML", async () => {
    const data = await loadStatus(fakeDb(tables), false, NOW);
    const html = renderToStaticMarkup(createElement(StatusView, { data }));
    expect(html).toContain("Synliga Föreningen");
    expect(html).toContain("En förening");
    expect(html).not.toContain("Hemliga Klubben");
  });
});
