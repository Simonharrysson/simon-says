import { describe, expect, it } from "vitest";
import { docUrl, meetingDeleteState } from "./meetings";

const me = "u1";

describe("meetingDeleteState", () => {
  it("never offers deleting a live or ending meeting, even to admins", () => {
    expect(meetingDeleteState({ status: "live", started_by: me }, { isAdmin: true, userId: me })).toBe("active");
    expect(meetingDeleteState({ status: "ending", started_by: me }, { isAdmin: true, userId: me })).toBe("active");
  });
  it("lets the starter or an admin delete a finished meeting", () => {
    expect(meetingDeleteState({ status: "done", started_by: me }, { isAdmin: false, userId: me })).toBe("allowed");
    expect(meetingDeleteState({ status: "abandoned", started_by: "u2" }, { isAdmin: true, userId: me })).toBe("allowed");
  });
  it("hides it from other members", () => {
    expect(meetingDeleteState({ status: "done", started_by: "u2" }, { isAdmin: false, userId: me })).toBe("forbidden");
    expect(meetingDeleteState({ status: "done", started_by: null }, { isAdmin: false, userId: null })).toBe("forbidden");
  });
});

describe("docUrl", () => {
  it("builds the edit link", () => {
    expect(docUrl("abc_123")).toBe("https://docs.google.com/document/d/abc_123/edit");
  });
});
