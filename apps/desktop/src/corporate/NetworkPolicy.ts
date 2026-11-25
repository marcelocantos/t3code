import type { App, Session } from "electron";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";

export function allowsCorporateRequest(rawUrl: string): boolean {
  const url = URL.parse(rawUrl);
  if (url === null) return false;
  switch (url.protocol) {
    case "http:":
    case "https:":
    case "ws:":
    case "wss:":
      return isLocalLoopbackHost(url.hostname);
    case "file:":
      return url.hostname === "" || url.hostname === "localhost";
    case "t3code:":
    case "t3code-dev:":
      return url.hostname === "app";
    case "about:":
    case "blob:":
    case "data:":
    case "devtools:":
      return true;
    default:
      return false;
  }
}

// A fixed proxy has no DIRECT fallback; any proxy traffic stays on loopback even before a session is configured.
const DISCARD_TCP_PORT = 9;
const LOOPBACK_ONLY_PROXY = `socks5://127.0.0.1:${DISCARD_TCP_PORT}`;
const LOOPBACK_PROXY_BYPASS = "localhost;127.0.0.0/8;[::1]";

export function installCorporateNetworkPolicy(app: App): void {
  if (app.isReady()) throw new Error("Corporate network policy must be installed before ready.");
  app.commandLine.appendSwitch("proxy-server", LOOPBACK_ONLY_PROXY);
  app.commandLine.appendSwitch("proxy-bypass-list", LOOPBACK_PROXY_BYPASS);
  app.commandLine.appendSwitch(
    "host-resolver-rules",
    [
      "EXCLUDE 127.0.0.1",
      "EXCLUDE ::1",
      "EXCLUDE [::1]",
      "EXCLUDE ::ffff:7f00:1",
      "EXCLUDE [::ffff:7f00:1]",
      "MAP localhost 127.0.0.1",
      "MAP localhost. 127.0.0.1",
      "MAP * ~NOTFOUND",
    ].join(", "),
  );
  app.commandLine.appendSwitch("disable-background-networking");
  app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", "disable_non_proxied_udp");

  const configure = (session: Session) => {
    session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (request, callback) => {
      callback({ cancel: !allowsCorporateRequest(request.url) });
    });
    void session
      .setProxy({
        mode: "fixed_servers",
        proxyRules: LOOPBACK_ONLY_PROXY,
        proxyBypassRules: LOOPBACK_PROXY_BYPASS,
      })
      .catch(() => app.exit(1));
  };
  app.on("session-created", configure);
  app.on("web-contents-created", (_event, contents) => {
    contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  });
}
