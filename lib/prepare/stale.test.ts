import { describe, expect, it } from "vitest";
import { preparedDocState } from "./stale";

describe("preparedDocState", () => {
  it("trashed is gone for everyone; not found is gone only for the preparer", () => {
    expect(preparedDocState({ ok: true, name: "x" }, false)).toBe("ok");
    expect(preparedDocState({ ok: false, error: "trashed" }, false)).toBe("gone");
    expect(preparedDocState({ ok: false, error: "not_found" }, true)).toBe("gone");
    expect(preparedDocState({ ok: false, error: "not_found" }, false)).toBe("no_access");
    expect(preparedDocState({ ok: false, error: "no_edit" }, true)).toBe("no_access");
  });
});
