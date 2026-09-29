/**
 * The address a request counts against for per-IP limits. Behind a reverse proxy that overwrites
 * X-Forwarded-For with the address it saw, as Caddy does by default, that is the header's rightmost
 * entry: the proxy wrote it, and the client can only add entries to its left. Unless the proxy is
 * trusted, anyone could send the header, so the socket's address counts.
 */
export function clientIpOf(socketAddress: string, forwardedFor: string | undefined, trustProxy: boolean): string {
  if (!trustProxy) return socketAddress;
  return forwardedFor?.split(",").at(-1)?.trim() || socketAddress;
}
