import { describe, expect, it } from "vitest";
import { isBlockedAddress, v6Groups } from "./ip";

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "127.255.0.9",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.10",
    "169.254.169.254", // cloud metadata
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "198.18.0.1",
    "192.0.2.5",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd00:ec2::254", // AWS metadata over IPv6
    "ff02::1",
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "64:ff9b::10.0.0.1", // NAT64 to a private address
    "2001:db8::1",
    "2002:c0a8:0101::1", // 6to4
    "[::1]",
    "not-an-ip",
    "",
  ])("blocks %s", (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each(["93.184.216.34", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "::ffff:8.8.8.8", "64:ff9b::8.8.8.8"])(
    "allows public %s",
    (ip) => expect(isBlockedAddress(ip)).toBe(false),
  );

  it("expands IPv6 forms", () => {
    expect(v6Groups("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(v6Groups("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
    expect(v6Groups("1::2::3")).toBeNull();
  });
});
