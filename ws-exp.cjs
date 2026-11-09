// Electron experiment: a 12 MB JSON text message over a loopback WebSocket,
// pure ASCII versus the same bytes plus one "×", timed in the renderer:
// arrival (handler start minus send time) and JSON.parse.
const { app, BrowserWindow } = require("electron");
const { WebSocketServer } = require(process.env.WS_MODULE);
const crypto = require("node:crypto");
const chunks = [];
for (let i = 0; i < 1500; i++) chunks.push({ id: crypto.randomBytes(16).toString("hex"), data: crypto.randomBytes(6000).toString("base64") });
const ascii = JSON.stringify({ type: "WORKSPACE_RESPONSE", result: { failed: [{ file: "p/a.html", error: "two layers (1440x900)" }], chunks } });
const wide = ascii.replace("(1440x900)", "(1440×900)");
const escaped = wide.replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
app.whenReady().then(async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.on("listening", resolve));
  const port = server.address().port;
  const win = new BrowserWindow({ show: true, width: 400, height: 300, webPreferences: { backgroundThrottling: false } });
  win.webContents.on("console-message", (_event, _level, message) => { if (message.startsWith("EXP")) console.log(message); });
  server.on("connection", async (socket) => {
    const order = [];
    for (let i = 0; i < 6; i++) order.push(["ascii", ascii], ["wide", wide], ["escaped", escaped]);
    for (const [name, text] of order) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      socket.send(JSON.stringify({ name, sent: Date.now() }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      socket.send(text);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
    app.quit();
  });
  const page = `<script>
    const ws = new WebSocket("ws://127.0.0.1:${port}"); let meta = null;
    ws.onmessage = (event) => {
      const start = performance.now(), now = Date.now();
      if (event.data.length < 1000) { meta = JSON.parse(event.data); meta.mark = performance.now(); return; }
      const parsed = JSON.parse(event.data);
      const parse = performance.now() - start;
      console.log("EXP " + meta.name + " size " + event.data.length + " sinceMeta " + Math.round(start - meta.mark) + " parse " + Math.round(parse) + " chunks " + parsed.result.chunks.length);
    };
  </script>`;
  await win.loadURL("data:text/html," + encodeURIComponent(page));
});
