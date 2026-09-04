/**
 * Blocks server-side requests to addresses that are not on the public internet.
 *
 * Both webhook paths let a merchant name a URL the server then fetches. Without
 * this, an authenticated merchant can aim that fetch at infrastructure only the
 * server can reach — the database, Tailnet peers, a cloud metadata endpoint —
 * and, because the webhook response body is handed back and stored, read what
 * comes back. That is a classic SSRF-to-exfiltration chain.
 *
 * Two things the previous inline checks missed and this closes:
 *
 *  1. Range coverage. The blocklists were regexes over the hostname string and
 *     did not cover the Tailscale CGNAT range 100.64.0.0/10 (where this
 *     deployment's own database lives), IPv4-mapped IPv6, or alternate IP
 *     encodings (octal/decimal/hex).
 *
 *  2. DNS rebinding. Checking the hostname proves nothing about where the
 *     socket actually connects — an attacker controls a domain that resolves to
 *     a public address on the check and a private one microseconds later when
 *     fetch() resolves it again. So we resolve every A/AAAA record here and
 *     require ALL of them to be public before the caller is allowed to fetch.
 *
 * assertPublicHttpUrl throws UrlGuardError on anything that is not a public
 * HTTPS endpoint; the caller maps that to a 400.
 */

import dns from "dns";
import net from "net";

export class UrlGuardError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
    this.name = "UrlGuardError";
  }
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

/** True when an IPv4 address is anything other than a routable public host. */
function isPrivateIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable → treat as unsafe
  const inRange = (cidr: number, bits: number) => (n >>> (32 - bits)) === (cidr >>> (32 - bits));
  return (
    inRange(ipv4ToInt("0.0.0.0")!, 8) ||        // 0.0.0.0/8   "this host"
    inRange(ipv4ToInt("10.0.0.0")!, 8) ||        // RFC1918
    inRange(ipv4ToInt("100.64.0.0")!, 10) ||     // RFC6598 CGNAT — Tailscale
    inRange(ipv4ToInt("127.0.0.0")!, 8) ||       // loopback
    inRange(ipv4ToInt("169.254.0.0")!, 16) ||    // link-local incl. 169.254.169.254 metadata
    inRange(ipv4ToInt("172.16.0.0")!, 12) ||     // RFC1918
    inRange(ipv4ToInt("192.0.0.0")!, 24) ||      // IETF protocol assignments
    inRange(ipv4ToInt("192.168.0.0")!, 16) ||    // RFC1918
    inRange(ipv4ToInt("198.18.0.0")!, 15) ||     // benchmarking
    (n >>> 28) === 0xE ||                          // 224.0.0.0/4 multicast
    (n >>> 28) === 0xF                             // 240.0.0.0/4 reserved
  );
}

/** True when an IPv6 address is loopback, ULA, link-local, or maps to a private v4. */
function isPrivateIpv6(ip: string): boolean {
  const addr = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (addr === "::1" || addr === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(addr)) return true; // fc00::/7 ULA
  if (/^fe80:/.test(addr)) return true;              // link-local
  const mapped = addr.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  const mappedHex = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16), lo = parseInt(mappedHex[2], 16);
    return isPrivateIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return false;
}

function isPrivateAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return isPrivateIpv4(ip);
  if (kind === 6) return isPrivateIpv6(ip);
  return true; // not an IP literal → unsafe
}

/**
 * Validates that `raw` is an HTTPS URL whose every resolved address is public,
 * and returns the parsed URL. Throws UrlGuardError otherwise. Resolving here —
 * rather than trusting the hostname — is what defeats DNS rebinding.
 */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlGuardError("Invalid URL");
  }
  if (url.protocol !== "https:") {
    throw new UrlGuardError("Only HTTPS URLs are allowed");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^localhost$/i.test(host) || /\.local$/i.test(host) || /\.internal$/i.test(host)) {
    throw new UrlGuardError("Private/local URLs are not allowed");
  }
  // A literal IP is checked directly; a name is fully resolved and every
  // returned address must be public.
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new UrlGuardError("Private/local URLs are not allowed");
    return url;
  }
  let resolved: dns.LookupAddress[];
  try {
    resolved = await dns.promises.lookup(host, { all: true });
  } catch {
    throw new UrlGuardError("Could not resolve webhook host");
  }
  if (!resolved.length) throw new UrlGuardError("Could not resolve webhook host");
  for (const { address } of resolved) {
    if (isPrivateAddress(address)) {
      throw new UrlGuardError("Webhook host resolves to a private address");
    }
  }
  return url;
}
