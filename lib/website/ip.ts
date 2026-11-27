import { isIP } from "node:net";

// Which addresses "Hämta styrelsen från webbplatsen" may connect to: public unicast only. Every
// address a host name resolves to is checked (lib/website/fetch.ts), and the connection goes to
// the address that was checked, so a name can't point us at the app's own network, a cloud
// metadata service (169.254.169.254, fd00:ec2::254) or anything else that isn't the public web.

type Range = [base: number, bits: number];

const V4_BLOCKED: Range[] = [
  [v4("0.0.0.0"), 8], // "this network"
  [v4("10.0.0.0"), 8], // private
  [v4("100.64.0.0"), 10], // carrier-grade NAT
  [v4("127.0.0.0"), 8], // loopback
  [v4("169.254.0.0"), 16], // link-local, cloud metadata
  [v4("172.16.0.0"), 12], // private
  [v4("192.0.0.0"), 24], // IETF protocol assignments
  [v4("192.0.2.0"), 24], // documentation
  [v4("192.88.99.0"), 24], // 6to4 relay
  [v4("192.168.0.0"), 16], // private
  [v4("198.18.0.0"), 15], // benchmarking
  [v4("198.51.100.0"), 24], // documentation
  [v4("203.0.113.0"), 24], // documentation
  [v4("224.0.0.0"), 4], // multicast
  [v4("240.0.0.0"), 4], // reserved, broadcast
];

function v4(ip: string): number {
  return ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);
}

function v4Blocked(ip: string): boolean {
  const n = v4(ip);
  return V4_BLOCKED.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
}

/** The eight 16-bit groups of an IPv6 address (with an embedded dotted IPv4 tail), or null. */
export function v6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase().replace(/%.*$/, "");
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    if (isIP(dotted[1]) !== 4) return null;
    const n = v4(dotted[1]);
    text = text.slice(0, -dotted[1].length) + `${Math.floor(n / 65536).toString(16)}:${(n % 65536).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : null;
}

function v6Blocked(ip: string): boolean {
  const g = v6Groups(ip);
  if (!g) return true;
  const embedded = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  // ::ffff:a.b.c.d (IPv4-mapped) and 64:ff9b::a.b.c.d (NAT64): judged by the IPv4 inside.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4Blocked(embedded(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4Blocked(embedded(g[6], g[7]));
  // Only global unicast (2000::/3) is public at all.
  if ((g[0] & 0xe000) !== 0x2000) return true; // ::, ::1, fc00::/7, fe80::/10, ff00::/8, ...
  if (g[0] === 0x2001 && g[1] < 0x200) return true; // 2001::/23 IETF protocol assignments (Teredo, ...)
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation
  if (g[0] === 0x2002) return true; // 6to4: tunnels to an arbitrary IPv4
  if (g[0] === 0x3fff && g[1] < 0x1000) return true; // documentation (3fff::/20)
  return false;
}

/** True unless `ip` is a public unicast IPv4/IPv6 address. Anything unparsable is blocked. */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip.replace(/^\[|\]$/g, ""));
  if (kind === 4) return v4Blocked(ip);
  if (kind === 6) return v6Blocked(ip.replace(/^\[|\]$/g, ""));
  return true;
}
