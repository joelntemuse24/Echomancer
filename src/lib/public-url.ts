/**
 * Client-safe checks for a link the paste page may read.
 *
 * The server repeats this check, then resolves DNS and refuses any address
 * that is not a public http(s) host. This module only looks at the URL itself.
 */

export const PUBLIC_URL_MAX_LENGTH = 2048;

export type PublicUrlCode = "INVALID_URL" | "URL_BLOCKED";

export type PublicUrlCheck =
  | { ok: true; url: URL }
  | { ok: false; code: PublicUrlCode; message: string };

const INVALID_MESSAGE = "Paste a full http or https link.";
const BLOCKED_MESSAGE = "That link can't be read.";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.google.com",
]);

export class PublicUrlError extends Error {
  constructor(
    readonly code:
      | PublicUrlCode
      | "URL_UNREACHABLE"
      | "URL_UNSUPPORTED"
      | "URL_TOO_LARGE"
      | "URL_EMPTY",
    message: string
  ) {
    super(message);
    this.name = "PublicUrlError";
  }
}

function invalid(): PublicUrlCheck {
  return { ok: false, code: "INVALID_URL", message: INVALID_MESSAGE };
}

function blocked(): PublicUrlCheck {
  return { ok: false, code: "URL_BLOCKED", message: BLOCKED_MESSAGE };
}

/** Add https when someone pastes `example.com/story` or `//example.com/story`. */
export function normalizeUrlInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return `https://${trimmed}`;
}

export function stripUrlHost(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  return host;
}

function ipv4Parts(host: string): [number, number, number, number] | null {
  const pieces = host.split(".");
  if (pieces.length !== 4) return null;
  const parts: number[] = [];
  for (const piece of pieces) {
    if (!/^\d{1,3}$/.test(piece)) return null;
    const value = Number(piece);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    parts.push(value);
  }
  const a = parts[0];
  const b = parts[1];
  const c = parts[2];
  const d = parts[3];
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    return null;
  }
  return [a, b, c, d];
}

export function isBlockedIpv4(host: string): boolean {
  const parts = ipv4Parts(host);
  if (!parts) return true;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function expandIpv6(host: string): number[] | null {
  let value = host.toLowerCase();
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (dotted) {
    const v4 = dotted[2];
    const prefix = dotted[1];
    const parts = v4 ? ipv4Parts(v4) : null;
    if (!parts || prefix === undefined) return null;
    const hi = (parts[0] << 8) | parts[1];
    const lo = (parts[2] << 8) | parts[3];
    value = `${prefix}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const groups = side.split(":");
    const out: number[] = [];
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };

  const leftSide = halves[0] ?? "";
  const rightSide = halves[1] ?? "";
  if (halves.length === 1) {
    const groups = parseSide(leftSide);
    if (!groups || groups.length !== 8) return null;
    return groups;
  }

  const left = parseSide(leftSide);
  const right = parseSide(rightSide);
  if (!left || !right) return null;
  if (left.length + right.length >= 8) return null;
  return [
    ...left,
    ...Array<number>(8 - left.length - right.length).fill(0),
    ...right,
  ];
}

function ipv4FromGroups(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function at(groups: number[], index: number): number {
  return groups[index] ?? 0;
}

export function isBlockedIpv6(host: string): boolean {
  const groups = expandIpv6(host);
  if (!groups || groups.length !== 8) return true;
  if (groups.every((group) => group === 0)) return true;
  if (groups.slice(0, 7).every((group) => group === 0) && at(groups, 7) === 1) {
    return true;
  }
  const g0 = at(groups, 0);
  const g1 = at(groups, 1);
  if ((g0 & 0xff00) === 0xff00) return true;
  if ((g0 & 0xffc0) === 0xfe80) return true;
  if ((g0 & 0xfe00) === 0xfc00) return true;
  if (g0 === 0x2001 && g1 === 0x0db8) return true;

  const mapped =
    groups.slice(0, 5).every((group) => group === 0) && at(groups, 5) === 0xffff;
  if (mapped) return isBlockedIpv4(ipv4FromGroups(at(groups, 6), at(groups, 7)));

  const compatible = groups.slice(0, 6).every((group) => group === 0);
  if (compatible) {
    return isBlockedIpv4(ipv4FromGroups(at(groups, 6), at(groups, 7)));
  }

  const nat64 =
    g0 === 0x0064 &&
    g1 === 0xff9b &&
    groups.slice(2, 6).every((group) => group === 0);
  if (nat64) return isBlockedIpv4(ipv4FromGroups(at(groups, 6), at(groups, 7)));

  return false;
}

export function isBlockedAddress(address: string): boolean {
  const host = stripUrlHost(address);
  if (ipv4Parts(host)) return isBlockedIpv4(host);
  if (host.includes(":")) return isBlockedIpv6(host);
  return true;
}

function isBlockedDomain(host: string): boolean {
  if (BLOCKED_HOSTS.has(host)) return true;
  return (
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".localdomain") ||
    host.endsWith(".internal") ||
    host.endsWith(".arpa")
  );
}

function isPublicDomain(host: string): boolean {
  if (!/^[a-z0-9.-]+$/.test(host)) return false;
  if (host.startsWith("-") || host.endsWith("-") || host.includes("..")) {
    return false;
  }
  const labels = host.split(".");
  if (labels.length < 2) return false;
  if (
    labels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        label.startsWith("-") ||
        label.endsWith("-")
    )
  ) {
    return false;
  }
  const tld = labels[labels.length - 1];
  return Boolean(tld && tld.length >= 2);
}

export function checkPublicHttpUrl(raw: string): PublicUrlCheck {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > PUBLIC_URL_MAX_LENGTH) return invalid();

  let url: URL;
  try {
    url = new URL(normalizeUrlInput(trimmed));
  } catch {
    return invalid();
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return invalid();
  if (url.username || url.password) return invalid();
  if (url.port && url.port !== "80" && url.port !== "443") return invalid();

  const host = stripUrlHost(url.hostname);
  if (!host) return invalid();

  if (ipv4Parts(host)) {
    return isBlockedIpv4(host) ? blocked() : { ok: true, url };
  }
  if (host.includes(":")) {
    return isBlockedIpv6(host) ? blocked() : { ok: true, url };
  }
  if (isBlockedDomain(host)) return blocked();
  if (!isPublicDomain(host)) return invalid();
  return { ok: true, url };
}
