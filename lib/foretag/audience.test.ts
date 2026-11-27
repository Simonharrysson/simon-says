import { describe, expect, it } from "vitest";
import { audiencePeople } from "./audience";

const people = [
  { id: "anna", member_user_id: "u-anna", group_id: "vd" },
  { id: "erik", member_user_id: "u-erik", group_id: "led" },
  { id: "jonas", member_user_id: "u-jonas", group_id: "dev" },
  { id: "lisa", member_user_id: "u-lisa", group_id: "dev" },
  { id: "maja", member_user_id: "u-maja", group_id: "com" },
  { id: "namn", member_user_id: null, group_id: "dev" },
];
const ids = (r: { id: string }[]) => r.map((p) => p.id);

describe("audiencePeople", () => {
  it("a group meeting: its group, not the heads above (they open it in the app)", () => {
    expect(ids(audiencePeople({ groupId: "dev", people, attendeeIds: [], viewerIds: ["u-anna", "u-erik", "u-jonas", "u-lisa"] }))).toEqual(["jonas", "lisa"]);
  });
  it("attendees too, when they can see it", () => {
    expect(ids(audiencePeople({ groupId: "dev", people, attendeeIds: ["u-erik", "u-maja"], viewerIds: ["u-erik", "u-jonas", "u-lisa"] }))).toEqual(["erik", "jonas", "lisa"]);
  });
  it("a Privat möte: only the attendees who can see it", () => {
    expect(ids(audiencePeople({ groupId: "led", people, attendeeIds: ["u-erik"], viewerIds: ["u-anna", "u-erik"] }))).toEqual(["erik"]);
  });
  it("Hela företaget: every linked viewer", () => {
    expect(ids(audiencePeople({ groupId: null, people, attendeeIds: [], viewerIds: people.flatMap((p) => (p.member_user_id ? [p.member_user_id] : [])) }))).toEqual(["anna", "erik", "jonas", "lisa", "maja"]);
  });
});
