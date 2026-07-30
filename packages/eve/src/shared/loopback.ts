const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "[::1]"]);
const IPV4_LITERAL = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Returns whether a WHATWG URL hostname identifies a loopback host.
 *
 * Callers pass `URL.hostname`, which normalizes supported IPv4 spellings
 * (including shortened, octal, and hexadecimal forms) to dotted decimal.
 * Requiring all four numeric octets prevents DNS names such as
 * `127.attacker.example` from being mistaken for the `127.0.0.0/8` block.
 */
export function isLoopbackHostname(hostname: string): boolean {
  if (LOOPBACK_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost")) {
    return true;
  }

  const match = IPV4_LITERAL.exec(hostname);
  if (match === null || Number(match[1]) !== 127) return false;
  return match.slice(1).every((octet) => Number(octet) <= 255);
}
