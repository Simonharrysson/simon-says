import { beforeAll, describe, expect, it } from "vitest";
import { testEnv } from "@/test/env";
import { verifyCron } from "./cron";

beforeAll(() => {
  Object.assign(process.env, { ...testEnv, CRON_SECRET: "s3cret" });
});

const req = (authorization?: string) =>
  new Request("https://example.com/api/health", {
    headers: authorization === undefined ? {} : { authorization },
  });

describe("verifyCron", () => {
  it("accepts the matching bearer", () => {
    expect(verifyCron(req("Bearer s3cret"))).toBe(true);
  });
  it("rejects a mismatched bearer", () => {
    expect(verifyCron(req("Bearer wrong"))).toBe(false);
    expect(verifyCron(req("Bearer s3cret2"))).toBe(false);
  });
  it("rejects a missing header", () => {
    expect(verifyCron(req())).toBe(false);
  });
});
