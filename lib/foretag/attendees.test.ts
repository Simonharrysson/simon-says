import { describe, expect, it } from "vitest";
import { attendeeIdsFor } from "./attendees";

describe("attendeeIdsFor", () => {
  const members = [
    { userId: "u1", email: "Simon@harrysson.co" },
    { userId: "u2", email: "anna@harrysson.co" },
    { userId: "u3", email: "" },
  ];
  it("exact address matches only, once each, in guest order", () => {
    expect(attendeeIdsFor(["anna@harrysson.co", "kund@acme.se", "simon@HARRYSSON.co", "anna@harrysson.co"], members)).toEqual(["u2", "u1"]);
  });
  it("no near matches (a display name or another domain never counts)", () => {
    expect(attendeeIdsFor(["anna@harrysson.se", "Anna"], members)).toEqual([]);
  });
});
