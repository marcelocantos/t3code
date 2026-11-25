// @effect-diagnostics nodeBuiltinImport:off - Exercise Node's native socket APIs without application wrappers.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeDns from "node:dns";
import * as NodeDgram from "node:dgram";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodeUtil from "node:util";

const { values } = NodeUtil.parseArgs({
  options: {
    runtime: { type: "string" },
    "harness-node": { type: "string" },
    electron: { type: "boolean", default: false },
  },
});
NodeAssert.ok(values.runtime, "Pass --runtime with the corporate Node executable.");
const harnessNode = values["harness-node"] ?? process.execPath;
const localAddress = Object.values(NodeOS.networkInterfaces())
  .flat()
  .find((address) => address?.family === "IPv4" && !address.internal)?.address;
NodeAssert.ok(localAddress, "A non-loopback local interface is required for the negative control.");

const PROBE_TIMEOUT_MS = 45000;
const TRANSFER_TIMEOUT_MS = 15000;
let dnsRequests = 0;
const dnsFixture = NodeDgram.createSocket("udp4");
dnsFixture.on("message", (request, sender) => {
  dnsRequests++;
  const response = Buffer.from(request);
  response.writeUInt16BE(0x8183, 2);
  response.writeUInt16BE(0, 6);
  response.writeUInt16BE(0, 8);
  response.writeUInt16BE(0, 10);
  dnsFixture.send(response, sender.port, sender.address);
});
dnsFixture.bind(0, localAddress);
await NodeEvents.EventEmitter.once(dnsFixture, "listening");
const dnsPort = dnsFixture.address().port;
const controlResolver = new NodeDns.promises.Resolver({ timeout: PROBE_TIMEOUT_MS, tries: 1 });
controlResolver.setServers([`${localAddress}:${dnsPort}`]);
await NodeAssert.rejects(controlResolver.resolve4("corporate-network.invalid"), {
  code: "ENOTFOUND",
});
NodeAssert.equal(dnsRequests, 1, "The ordinary DNS control must reach the fixture.");

let fixtureConnections = 0;
const fixture = NodeHttp.createServer((_request, response) => response.end("harness-network-ok"));
fixture.on("connection", () => fixtureConnections++);
fixture.listen(0, localAddress);
await NodeEvents.EventEmitter.once(fixture, "listening");
const address = fixture.address();
NodeAssert.ok(address && typeof address !== "string");

const probe = String.raw`
  const assert = require('node:assert/strict');
  const net = require('node:net');
  const http = require('node:http');
  const dns = require('node:dns');
  const dgram = require('node:dgram');
  const { once } = require('node:events');
  const { spawn } = require('node:child_process');
  const [host, port, harnessNode, resolveError, dnsPort] = process.argv.slice(1);
  const connect = (host, port) => new Promise(resolve => {
    const socket = net.connect({ host, port });
    socket.once('error', error => resolve(error.code));
    socket.once('connect', () => { socket.destroy(); resolve('allowed'); });
  });
  (async () => {
    assert.equal(await connect(host, Number(port)), 'EACCES', 'External TCP must be denied before connect');
    assert.equal(await connect('::ffff:' + host, Number(port)), 'EACCES', 'Mapped external IPv4 must be denied');
    for (const host of ['0.0.0.0', '::']) {
      const server = net.createServer();
      server.listen(0, host);
      const [error] = await once(server, 'error');
      assert.equal(error.code, 'EACCES', 'Wildcard listeners must be denied');
    }
    assert.throws(() => dgram.createSocket('udp4'), { code: 'ERR_ACCESS_DENIED' });
    assert.throws(() => dgram.createSocket('udp6'), { code: 'ERR_ACCESS_DENIED' });
    await assert.rejects(dns.promises.lookup('corporate-network.invalid'), { code: 'EACCES' });
    dns.setServers([host + ':' + dnsPort]);
    await assert.rejects(dns.promises.resolve4('corporate-network.invalid'), { code: resolveError });
    assert.equal((await dns.promises.lookup('LOCALHOST.')).address, '127.0.0.1');
    assert.equal((await dns.promises.lookup('localhost', { family: 6 })).address, '::1');
    assert.deepEqual(await dns.promises.lookup('localhost', { all: true }), [
      { address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 },
    ]);
    assert.deepEqual(await dns.promises.lookup('localhost', { all: true, order: 'ipv6first' }), [
      { address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 },
    ]);
    await new Promise((resolve, reject) => dns.lookup('localhost', (error, result) => {
      if (error) reject(error); else { assert.equal(result, '127.0.0.1'); resolve(); }
    }));
    for (const host of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      const server = http.createServer((_request, response) => response.end('local-ui-ok'));
      server.on('upgrade', (_request, socket) => socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'));
      server.listen(0, host);
      await once(server, 'listening');
      const port = server.address().port;
      const endpoint = process.report.getReport().libuv.find(handle => handle.type === 'tcp' && handle.localEndpoint?.port === port)?.localEndpoint;
      assert.ok(endpoint, 'The live local listener must appear in the diagnostic report');
      assert.equal(endpoint.host, endpoint.ip4 ?? endpoint.ip6, 'Diagnostic reports must avoid reverse DNS');
      const response = await fetch('http://[' + (host.includes(':') ? host : '::ffff:' + host) + ']:' + port);
      assert.equal(await response.text(), 'local-ui-ok');
      assert.equal(await (await fetch('http://localhost:' + port)).text(), 'local-ui-ok');
      await new Promise((resolve, reject) => {
        const socket = net.connect({ host, port });
        socket.on('error', reject);
        let data = '';
        socket.on('data', chunk => data += chunk);
        socket.on('end', () => { assert.match(data, /101 Switching Protocols/); resolve(); });
        socket.on('connect', () => socket.write('GET /ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'));
      });
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    const harness = spawn(harnessNode, ['-e', 'fetch(process.argv[1]).then(r=>r.text()).then(t=>process.stdout.write(t))', 'http://' + host + ':' + port], { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    harness.stdout.on('data', chunk => output += chunk);
    const [code] = await once(harness, 'exit');
    assert.equal(code, 0);
    assert.equal(output, 'harness-network-ok', 'Harness networking must survive the parent restriction');
    assert.equal(process.versions.t3_corporate_network, 'loopback-v1');
    assert.equal(process.features.inspector, false, 'The corporate runtime must exclude the Node inspector');
    assert.throws(() => require('node:quic'), { code: 'ERR_UNKNOWN_BUILTIN_MODULE' }, 'QUIC must not bypass the UDP restriction');
    console.log('PASS: external TCP, mapped addresses, wildcard binds, UDP and DNS denied; local HTTP/WS, numeric diagnostic reports and harness networking preserved');
  })().catch(error => { console.error(error); process.exitCode = 1; });
`;

try {
  // Grants must not override the compiled restriction; ordinary child runtimes receive no deny flag.
  const grants = values.electron
    ? []
    : ["--permission", "--allow-net", "--allow-child-process", "--allow-fs-read=*"];
  const child = NodeChildProcess.spawn(
    values.runtime,
    [
      ...grants,
      "-e",
      probe,
      localAddress,
      String(address.port),
      harnessNode,
      values.electron ? "EACCES" : "ERR_ACCESS_DENIED",
      String(dnsPort),
    ],
    {
      stdio: "inherit",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      env: {
        ...process.env,
        NODE_OPTIONS: grants.join(" "),
        ...(values.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      },
    },
  );
  const [code, signal] = await NodeEvents.EventEmitter.once(child, "exit");
  NodeAssert.equal(signal, null);
  NodeAssert.equal(code, 0, "The corporate runtime network contract failed.");
  NodeAssert.equal(dnsRequests, 1, "The restricted runtime must send no DNS fixture traffic.");
  NodeAssert.equal(
    fixtureConnections,
    1,
    "Only the independent harness may contact the external fixture.",
  );
  for (const host of [localAddress, "127.0.0.1"]) {
    const transferServer = NodeHttp.createServer();
    const accepted = new Set<import("node:net").Socket>();
    transferServer.on("connection", (socket) => {
      accepted.add(socket);
      socket.on("close", () => accepted.delete(socket));
    });
    transferServer.listen(0, host);
    await NodeEvents.EventEmitter.once(transferServer, "listening");
    const transferAddress = transferServer.address();
    NodeAssert.ok(transferAddress && typeof transferAddress !== "string");
    const socket = NodeNet.createConnection({ host, port: transferAddress.port });
    await NodeEvents.EventEmitter.once(socket, "connect");
    const receiver: NodeChildProcess.ChildProcess = NodeChildProcess.spawn(
      values.runtime,
      [
        ...grants,
        "-e",
        String.raw`
      const reply = code => process.send({code}, () => process.disconnect());
      process.on('uncaughtException', error => reply(error.code));
      process.on('message', (_message, socket) => { socket?.destroy(); reply(socket ? 'allowed' : 'missing'); });
      process.send('ready');
    `,
      ],
      {
        stdio: ["ignore", "ignore", "inherit", "ipc"],
        env: {
          ...process.env,
          NODE_OPTIONS: grants.join(" "),
          ...(values.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        },
        signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
      },
    );
    try {
      const [ready] = await NodeEvents.EventEmitter.once(receiver, "message");
      NodeAssert.equal(ready, "ready");
      const completed = Promise.all([
        NodeEvents.EventEmitter.once(receiver, "message"),
        NodeEvents.EventEmitter.once(receiver, "exit"),
      ]);
      receiver.send({ socket: true }, socket, { keepOpen: true });
      const [[result], [exitCode]] = await completed;
      NodeAssert.deepEqual(
        result,
        { code: host === localAddress ? "EACCES" : "allowed" },
        "Transferred sockets must obey the native loopback boundary.",
      );
      NodeAssert.equal(exitCode, 0);
    } finally {
      if (receiver.exitCode === null && receiver.signalCode === null) receiver.kill();
      socket.destroy();
      for (const socket of accepted) socket.destroy();
      await new Promise<void>((resolve) => transferServer.close(() => resolve()));
    }
  }
  process.stdout.write(
    "PASS: transferred non-loopback sockets denied; loopback socket transfer preserved.\n",
  );
} finally {
  dnsFixture.close();
  await new Promise<void>((resolve, reject) =>
    fixture.close((error) => (error ? reject(error) : resolve())),
  );
}
