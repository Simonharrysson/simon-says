import { describe, expect, it } from "vitest";
import { loginError, orgNotice, orgsNotice } from "./messages";

describe("notices", () => {
  it("maps every login error code and falls back for unknown ones", () => {
    for (const code of ["drive", "refresh", "avbrutet", "start", "kod"]) expect(loginError(code)).not.toBeNull();
    expect(loginError("nonsense")).toEqual(loginError("kod"));
    expect(loginError(undefined)).toBeNull();
  });
  it("maps the org action codes, errors as danger and results as success", () => {
    for (const code of ["limit", "invalid", "inbjudan"]) expect(orgsNotice(code)?.tone).toBe("danger");
    expect(orgsNotice(undefined, "raderad")?.tone).toBe("success");
    for (const code of ["namn", "mote-forbidden", "mote-not_found", "mote-active", "org-active", "org-name_mismatch", "org-forbidden"]) {
      expect(orgNotice(code)?.tone).toBe("danger");
    }
    expect(orgNotice(undefined, "mote")?.tone).toBe("success");
    expect(orgNotice("unknown")).toBeNull();
    for (const code of ["admin-last_admin", "admin-forbidden", "admin-not_member", "admin-not_found", "admin-invalid", "medlem-last_admin"]) {
      expect(orgNotice(code)?.tone).toBe("danger");
    }
    expect(orgNotice(undefined, "admin-ny")?.tone).toBe("success");
    expect(orgNotice(undefined, "admin-bort")?.tone).toBe("success");
    expect(orgNotice("admin-last_admin")?.text).toContain("Gör någon annan till admin först");
  });
});
