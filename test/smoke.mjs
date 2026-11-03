// Protocol smoke test: starts relay.mjs on a random port and simulates
// a daemon (control + data socket) and a client.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const PORT = 20000 + Math.floor(Math.random() * 20000);
const relayPath = fileURLToPath(new URL("../relay.mjs", import.meta.url));
const relay = spawn(process.execPath, [relayPath], { env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1" }, stdio: ["ignore", "pipe", "inherit"] });
await new Promise((r) => relay.stdout.on("data", (d) => d.toString().includes("listening") && r()));

const B = `ws://127.0.0.1:${PORT}/ws?serverId=srv_test&v=2`;
const open = (u) => new Promise((r, j) => { const w = new WebSocket(u); w.once("open", () => r(w)); w.once("error", j); });
const next = (w) => new Promise((r) => w.once("message", (d, b) => r(b ? d : d.toString())));
let failed = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) failed++; };

try {
  const ctl = await open(B + "&role=server");
  ok(JSON.parse(await next(ctl)).type === "sync", "control gets sync on connect");
  const cli = await open(B + "&role=client&connectionId=c1");
  const ev = JSON.parse(await next(ctl));
  ok(ev.type === "connected" && ev.connectionId === "c1", "control notified of client");
  cli.send("early-frame");
  cli.send(Buffer.from([1, 2, 3]), { binary: true });
  const data = await open(B + "&role=server&connectionId=c1");
  const m = [];
  await new Promise((r) => data.on("message", (d, b) => { m.push(b ? [...d].join(",") : d.toString()); if (m.length === 2) r(); }));
  ok(m[0] === "early-frame" && m[1] === "1,2,3", "buffered frames flushed (text + binary preserved)");
  data.removeAllListeners("message");
  const p = next(cli); data.send("hello-client"); ok((await p) === "hello-client", "server -> client forward");
  const p2 = next(data); cli.send("hello-server"); ok((await p2) === "hello-server", "client -> server forward");
  const closed = new Promise((r) => data.once("close", (c) => r(c)));
  const disc = next(ctl);
  cli.close();
  ok((await closed) === 1001, "data socket closed when client leaves");
  ok(JSON.parse(await disc).type === "disconnected", "control notified of disconnect");
  const bad = await fetch(`http://127.0.0.1:${PORT}/ws`); ok(bad.status === 426, "plain GET /ws -> 426");
  const h = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json(); ok(h.status === "ok", "health endpoint");
  ctl.close();
} catch (e) {
  console.error(e); failed++;
} finally {
  relay.kill();
}
console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
