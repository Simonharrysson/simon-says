import { describe, expect, it } from "vitest";
import {
  chooseCreationAccount,
  chooseExistingAccount,
  choosePickerAccount,
  driveAccountView,
  driveResultOf,
  mayDisconnect,
  memberNames,
  type DriveAccountState,
} from "./drive-account-rules";
import { docShareTargets } from "@/lib/meetings/share-targets";

// Fictional förening: its Workspace account styrelsen@ekdala.test, connected by admin u-admin.

const account = (over: Partial<DriveAccountState> = {}): DriveAccountState => ({
  googleSub: "sub-ekdala",
  googleEmail: "styrelsen@ekdala.test",
  connectedBy: "u-admin",
  folderId: "folderAAAAAAAAAA",
  lostAt: null,
  ...over,
});

describe("chooseCreationAccount (a new Doc)", () => {
  it("no förening account, or no shared folder (a group's or private meeting): the starter's grant", () => {
    expect(chooseCreationAccount(null, "folderAAAAAAAAAA")).toEqual({ use: "starter" });
    expect(chooseCreationAccount(account(), null)).toEqual({ use: "starter" });
  });

  it("the meeting folder the account picked: the förening's account", () => {
    expect(chooseCreationAccount(account(), "folderAAAAAAAAAA")).toEqual({ use: "org", sub: "sub-ekdala" });
  });

  it("a folder the account did not pick (picked before connecting, or by another admin): the starter's grant, as before", () => {
    expect(chooseCreationAccount(account({ folderId: null }), "folderAAAAAAAAAA")).toEqual({ use: "starter" });
    expect(chooseCreationAccount(account({ folderId: "folderBBBBBBBBBB" }), "folderAAAAAAAAAA")).toEqual({ use: "starter" });
  });

  it("the account owns the folder but Google refused it: lost, never someone else's Drive", () => {
    expect(chooseCreationAccount(account({ lostAt: "2026-11-20T10:00:00Z" }), "folderAAAAAAAAAA")).toEqual({ use: "lost" });
  });
});

describe("chooseExistingAccount (a Doc already made)", () => {
  it("made with the starter's grant: stays with the starter", () => {
    expect(chooseExistingAccount(account(), null)).toEqual({ use: "starter" });
    expect(chooseExistingAccount(null, undefined)).toEqual({ use: "starter" });
  });

  it("made by the förening's account: only that very account, while it is accepted", () => {
    expect(chooseExistingAccount(account(), "sub-ekdala")).toEqual({ use: "org" });
    expect(chooseExistingAccount(null, "sub-ekdala")).toEqual({ use: "lost" });
    expect(chooseExistingAccount(account({ googleSub: "sub-other" }), "sub-ekdala")).toEqual({ use: "lost" });
    expect(chooseExistingAccount(account({ lostAt: "2026-11-20T10:00:00Z" }), "sub-ekdala")).toEqual({ use: "lost" });
  });
});

describe("choosePickerAccount", () => {
  it("the admin who connected it gets the förening's Drive; everyone else their own", () => {
    expect(choosePickerAccount(account(), "u-admin")).toEqual({ use: "org" });
    expect(choosePickerAccount(account(), "u-other-admin")).toEqual({ use: "own" });
    expect(choosePickerAccount(null, "u-admin")).toEqual({ use: "own" });
  });

  it("lost: the connecting admin renews it (no Picker of their own Drive instead)", () => {
    expect(choosePickerAccount(account({ lostAt: "2026-11-20T10:00:00Z" }), "u-admin")).toEqual({ use: "lost" });
    expect(choosePickerAccount(account({ lostAt: "2026-11-20T10:00:00Z" }), "u-other")).toEqual({ use: "own" });
  });
});

describe("mayDisconnect, driveAccountView, driveResultOf", () => {
  it("any admin, and whoever connected it", () => {
    expect(mayDisconnect(account(), "u-other", true)).toBe(true);
    expect(mayDisconnect(account(), "u-admin", false)).toBe(true);
    expect(mayDisconnect(account(), "u-member", false)).toBe(false);
  });

  it("the folder card's view: address and states only", () => {
    expect(driveAccountView(null, "u-admin", null)).toBeNull();
    expect(driveAccountView(account(), "u-admin", "folderAAAAAAAAAA")).toEqual({ email: "styrelsen@ekdala.test", lost: false, folderPicked: true, mine: true, connectedByName: null, replaced: null });
    expect(driveAccountView(account(), "u-other", "folderBBBBBBBBBB")).toMatchObject({ folderPicked: false, mine: false });
    expect(driveAccountView(account({ folderId: null }), "u-admin", null)).toMatchObject({ folderPicked: false });
  });

  it("only the known results", () => {
    expect(["ok", "nej", "fel", "bort"].map(driveResultOf)).toEqual(["ok", "nej", "fel", "bort"]);
    expect(driveResultOf("<script>")).toBeNull();
    expect(driveResultOf(["ok"])).toBeNull();
    expect(driveResultOf(undefined)).toBeNull();
  });
});

describe("who connected it, and a replaced account (security review)", () => {
  const names = memberNames([{ member_user_id: "u-admin", name: "Anna Berg" }], [{ userId: "u-admin", email: "anna@ekdala.test" }, { userId: "u-erik", email: "erik@ekdala.test" }]);
  const NOW = new Date("2026-11-28T12:00:00Z");
  const replaced = account({ connectedBy: "u-erik", replacedBy: "u-erik", replacedEmail: "gamla@ekdala.test", replacedAt: "2026-11-20T12:00:00Z" });

  it("Kopplat av: the board name, else the address", () => {
    expect(driveAccountView(account(), "u-x", null, names)?.connectedByName).toBe("Anna Berg");
    expect(driveAccountView(account({ connectedBy: "u-erik" }), "u-x", null, names)?.connectedByName).toBe("erik@ekdala.test");
  });

  it("the other admins see who replaced which account for 30 days; the replacer does not", () => {
    expect(driveAccountView(replaced, "u-admin", null, names, NOW)?.replaced).toEqual({ email: "gamla@ekdala.test", byName: "erik@ekdala.test", at: "2026-11-20T12:00:00Z" });
    expect(driveAccountView(replaced, "u-erik", null, names, NOW)?.replaced).toBeNull();
    expect(driveAccountView(replaced, "u-admin", null, names, new Date("2026-12-25T12:00:00Z"))?.replaced).toBeNull();
  });
});

describe("docShareTargets", () => {
  const members = [
    { userId: "u1", email: "Starter@ekdala.test", role: "admin" as const },
    { userId: "u2", email: "kassor@ekdala.test", role: "member" as const },
    { userId: "u3", email: "styrelsen@ekdala.test", role: "member" as const },
    { userId: "u4", email: "", role: "member" as const },
  ];
  const user = { id: "u1", email: "starter@ekdala.test" };

  it("the starter's grant: everyone else with an email (the starter owns it)", () => {
    expect(docShareTargets(members, { user }).map((m) => m.userId)).toEqual(["u2", "u3"]);
  });

  it("the förening's account: the starter too, never the account itself", () => {
    expect(docShareTargets(members, { user, driveAccountEmail: "Styrelsen@ekdala.test" }).map((m) => m.userId)).toEqual(["u1", "u2"]);
  });

  it("the tree's viewers only", () => {
    expect(docShareTargets(members, { user, shareTo: new Set(["u3"]) }).map((m) => m.userId)).toEqual(["u3"]);
  });
});
