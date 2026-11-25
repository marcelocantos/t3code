// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Probe the native runtime without application service wrappers.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeDgram from "node:dgram";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const { values } = NodeUtil.parseArgs({
  options: {
    runtime: { type: "string" },
    "control-runtime": { type: "string" },
    output: { type: "string" },
  },
});
NodeAssert.ok(values.runtime, "Pass --runtime with the patched Electron executable.");
const localAddress = Object.values(NodeOS.networkInterfaces())
  .flat()
  .find((a) => a?.family === "IPv4" && !a.internal)?.address;
NodeAssert.ok(localAddress, "The live fixture requires a non-loopback local interface.");
const scratchRoot = NodeChildProcess.execFileSync("scratch-root", { encoding: "utf8" }).trim();
const task = await NodeFSP.mkdtemp(NodePath.join(scratchRoot, "t3code-corporate-electron-check-"));
const connections: string[] = [];
const sockets = new Set<import("node:net").Socket>();
const http = NodeHttp.createServer((request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  if (request.url === "/redirect") {
    response.writeHead(302, { location: `http://${localAddress}:${port}/redirected` });
  } else if (request.url === "/page") {
    response.setHeader("Content-Type", "text/html");
  }
  response.end(
    request.url === "/page" ? "<html><body>Corporate runtime fixture</body></html>" : "fixture-ok",
  );
});
http.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  if (socket.localAddress === localAddress) connections.push("tcp");
});
http.on("upgrade", (request, socket) => {
  const accept = NodeCrypto.createHash("sha1")
    .update(String(request.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.on("data", () => socket.end());
});
const udp = NodeDgram.createSocket("udp4");
udp.on("message", () => connections.push("udp"));
http.listen(0, "0.0.0.0");
udp.bind(0, localAddress);
await Promise.all([
  NodeEvents.EventEmitter.once(http, "listening"),
  NodeEvents.EventEmitter.once(udp, "listening"),
]);
const address = http.address();
NodeAssert.ok(address !== null && typeof address !== "string");
const port = address.port;
const udpPort = udp.address().port;

const probe = String.raw`
const {app, BrowserWindow, session, net, crashReporter} = require('electron');
const assert = require('node:assert/strict');
const config = JSON.parse(process.env.T3_CORPORATE_NETWORK_PROBE);
app.setPath('userData', config.profile);
app.on('window-all-closed', () => {});
async function main() {
  await app.whenReady();
  if (!config.control) {
    crashReporter.start({submitURL:config.external + '/crash', uploadToServer:true});
    assert.equal(crashReporter.getUploadToServer(), false, 'Crash upload cannot be enabled');
    crashReporter.setUploadToServer(true);
    assert.equal(crashReporter.getUploadToServer(), false);
  }
  const results = [];
  for (const [name, current] of [['default', session.defaultSession], ['persistent', session.fromPartition('persist:corporate-check')], ['ephemeral', session.fromPartition('corporate-check')]]) {
    assert.equal(await (await current.fetch(config.local + '/ok')).text(), 'fixture-ok');
    const external = await current.fetch(config.external + '/session').then(() => true, () => false);
    const redirect = await current.fetch(config.local + '/redirect').then(() => true, () => false);
    const bypass = await current.fetch(config.external + '/bypass', {bypassCustomProtocolHandlers:true}).then(() => true, () => false);
    const window = new BrowserWindow({show:false, webPreferences:{session:current, sandbox:true, contextIsolation:true, nodeIntegration:false}});
    await window.loadURL(config.local + '/page');
    const renderer = await window.webContents.executeJavaScript('(' + String(async function(local, external) {
      const fetchAllowed = await fetch(external + '/renderer').then(() => true, () => false);
      const ws = url => new Promise(resolve => { const socket = new WebSocket(url); socket.onopen = () => { socket.close(); resolve(true); }; socket.onerror = () => resolve(false); });
      return {fetchAllowed, localWs:await ws(local.replace('http:', 'ws:') + '/local-ws'), externalWs:await ws(external.replace('http:', 'ws:') + '/external-ws')};
    }) + ')(' + JSON.stringify(config.local) + ',' + JSON.stringify(config.external) + ')');
    assert.equal(renderer.localWs, true);
    if (!config.control) for (const allowed of [external, redirect, bypass, renderer.fetchAllowed, renderer.externalWs]) assert.equal(allowed, false);
    results.push({session:name, external, redirect, bypass, ...renderer});
    if (name === 'default') {
      const rtc = await window.webContents.executeJavaScript('(' + String(async function(host, udpPort, tcpPort) {
        const peer = new RTCPeerConnection({iceServers:[{urls:'stun:' + host + ':' + udpPort}, {urls:'turn:' + host + ':' + tcpPort + '?transport=tcp', username:'test', credential:'test'}]});
        peer.createDataChannel('network-probe');
        const complete = new Promise(resolve => { peer.onicegatheringstatechange = () => {if(peer.iceGatheringState === 'complete')resolve(true);}; });
        await peer.setLocalDescription(await peer.createOffer());
        const deadline = new Promise(resolve => AbortSignal.timeout(8000).addEventListener('abort', () => resolve(false), {once:true}));
        const gathered = await Promise.race([complete, deadline]);
        peer.close();
        return gathered;
      }) + ')(' + JSON.stringify(config.host) + ',' + config.udpPort + ',' + config.port + ')');
      if (!config.control) assert.equal(rtc, true, 'Blocked ICE gathering must settle');
    }
    window.destroy();
  }
  const netExternal = await net.fetch(config.external + '/net').then(() => true, () => false);
  if (!config.control) {
    assert.equal(netExternal, false);
    assert.equal(process.versions.t3_corporate_network, 'loopback-v1');
    await assert.rejects(session.defaultSession.resolveHost('corporate-network.invalid'));
  }
  console.log('CORPORATE_ELECTRON_CHECK=' + JSON.stringify({control:config.control, nativeMarker:process.versions.t3_corporate_network ?? null, results, netExternal}));
  app.exit(0);
}
main().catch(error => {console.error(error); app.exit(1);});
`;
await NodeFSP.writeFile(NodePath.join(task, "probe.cjs"), probe);
const evidence: unknown[] = [];
try {
  for (const runtime of [values["control-runtime"], values.runtime].filter(
    (p): p is string => p !== undefined,
  )) {
    const control = runtime !== values.runtime;
    const before = connections.length;
    const config = {
      control,
      profile: NodePath.join(task, control ? "control-profile" : "corporate-profile"),
      host: localAddress,
      port,
      udpPort,
      local: `http://127.0.0.1:${port}`,
      external: `http://${localAddress}:${port}`,
    };
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      T3_CORPORATE_NETWORK_PROBE: JSON.stringify(config),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const child = NodeChildProcess.spawn(runtime, [NodePath.join(task, "probe.cjs")], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      signal: AbortSignal.timeout(45000),
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const [code, signal] = await NodeEvents.EventEmitter.once(child, "close");
    await NodeFSP.writeFile(
      NodePath.join(task, control ? "control.log" : "corporate.log"),
      stdout + stderr,
    );
    NodeAssert.equal(signal, null, `Runtime interrupted; evidence retained at ${task}`);
    NodeAssert.equal(code, 0, `Evidence retained at ${task}\n${stderr}${stdout}`);
    const line = stdout.split("\n").find((line) => line.startsWith("CORPORATE_ELECTRON_CHECK="));
    NodeAssert.ok(line, `Missing runtime evidence: ${task}`);
    const actualConnections = connections.slice(before);
    if (control) {
      NodeAssert.ok(
        actualConnections.includes("tcp"),
        "The control must reach the external TCP fixture.",
      );
      NodeAssert.ok(
        actualConnections.includes("udp"),
        "The control must reach the external WebRTC STUN fixture.",
      );
    } else
      NodeAssert.deepEqual(
        actualConnections,
        [],
        "Native Electron must emit no external TCP or UDP fixture traffic.",
      );
    evidence.push({
      ...JSON.parse(line.slice("CORPORATE_ELECTRON_CHECK=".length)),
      fixtureConnections: actualConnections,
    });
  }
  if (values.output)
    await NodeFSP.writeFile(values.output, JSON.stringify(evidence, null, 2) + "\n");
  await NodeFSP.rm(task, { recursive: true });
  console.log(
    "PASS: native Chromium sessions and WebRTC deny non-loopback networking; local HTTP/WS works.",
  );
} finally {
  for (const socket of sockets) socket.destroy();
  udp.close();
  await new Promise<void>((resolve) => http.close(() => resolve()));
}
