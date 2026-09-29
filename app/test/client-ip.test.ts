import { expect, test } from "vitest";
import { clientIpOf } from "../src/client-ip.ts";

const SOCKET = "127.0.0.1";

test.each([
  ["one address", "203.0.113.7", "203.0.113.7"],
  ["the rightmost of several, which the proxy wrote", "198.51.100.1, 203.0.113.7", "203.0.113.7"],
  ["the rightmost, without spaces", "198.51.100.1,203.0.113.7", "203.0.113.7"],
  ["an IPv6 address", "2001:db8::1", "2001:db8::1"],
])("trusting the proxy, X-Forwarded-For with %s gives %s", (_, forwardedFor, expected) => {
  expect(clientIpOf(SOCKET, forwardedFor, true)).toBe(expected);
});

test.each([undefined, "", " , "])(
  "trusting the proxy, X-Forwarded-For %j leaves the socket's address",
  (forwardedFor) => {
    expect(clientIpOf(SOCKET, forwardedFor, true)).toBe(SOCKET);
  },
);

test("without trusting a proxy, X-Forwarded-For is ignored", () => {
  expect(clientIpOf(SOCKET, "203.0.113.7", false)).toBe(SOCKET);
});
