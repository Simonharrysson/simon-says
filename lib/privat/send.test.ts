import { describe, expect, it } from "vitest";
import { taskTextWithDue } from "./send";

describe("a task's stored text", () => {
  it("keeps the due date, cutting the text first so both fit in 500", () => {
    expect(taskTextWithDue("Skriv inledningen", "torsdag")).toBe("Skriv inledningen (torsdag)");
    expect(taskTextWithDue("Skriv inledningen", null)).toBe("Skriv inledningen");
    const long = taskTextWithDue("x".repeat(600), "fredag");
    expect(long).toHaveLength(500);
    expect(long.endsWith(" (fredag)")).toBe(true);
    expect(taskTextWithDue("x".repeat(600), null)).toHaveLength(500);
  });
});
