import { expect, it } from "vite-plus/test";
import { allowsCorporateRequest } from "./NetworkPolicy.ts";

it.each([
  ["http://127.0.0.1:3773/api", true],
  ["ws://localhost:3773/ws", true],
  ["https://[::1]:3773", true],
  ["http://[::ffff:127.0.0.1]:3773", true],
  ["http://0x7f000001:3773", true],
  ["t3code://app/index.html", true],
  ["file:///local/image.png", true],
  ["data:text/plain,local", true],
  ["http://0.0.0.0:3773", false],
  ["http://192.168.1.1", false],
  ["ws://[::ffff:192.168.1.1]:3773/ws", false],
  ["https://app.t3.codes", false],
  ["http://localhost.example.com", false],
  ["http://127.0.0.1@external.example.com", false],
  ["file://external.example.com/share/file.png", false],
  ["t3code://external.example.com", false],
  ["invalid URL", false],
])("allows corporate resource %s: %s", (url, allowed) => {
  expect(allowsCorporateRequest(url)).toBe(allowed);
});
