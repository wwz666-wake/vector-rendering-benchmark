/* 用 Chrome DevTools Protocol 真实等待页面探针完成，再导出 DOM 或截图。
   仅使用 Node 22 内置模块（fetch / WebSocket / child_process），无需 puppeteer。

   node tools/shot.mjs --url=<url> --out=<file> --mode=dom|screenshot
       [--chrome=<exe>] [--wait=<selector>] [--timeout=<ms>]
       [--delay=<ms>] [--window=1440,3300]
*/
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = Object.fromEntries(
  process.argv.slice(2).map((s) => {
    const i = s.indexOf("=");
    return [s.slice(2, i < 0 ? undefined : i), i < 0 ? "" : s.slice(i + 1)];
  })
);

const url = argv.url;
const out = argv.out;
const mode = argv.mode || "dom";
const waitSelector = argv.wait || "pre.probe-done";
const timeoutMs = Number(argv.timeout || 90000);
const delayMs = Number(argv.delay || 0);
const [width, height] = (argv.window || "1440,3300").split(",").map(Number);
const chrome = argv.chrome ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

if (!url || !out) throw new Error("缺少 --url 或 --out");

const profile = mkdtempSync(join(tmpdir(), "flower-cdp-"));
const proc = spawn(chrome, [
  "--headless=new",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--enable-unsafe-webgpu",
  "--enable-unsafe-swiftshader",
  "--hide-scrollbars",
  "--remote-allow-origins=*",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  `--window-size=${width},${height}`,
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function port() {
  for (let i = 0; i < 200; i++) {
    try {
      const text = readFileSync(join(profile, "DevToolsActivePort"), "utf8");
      const value = Number(text.split("\n")[0]);
      if (value) return value;
    } catch { /* 尚未写入 */ }
    await sleep(100);
  }
  throw new Error("Chrome DevTools 端口未就绪");
}

let ws;
try {
  const p = await port();
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/json/version`);
      if (res.ok) break;
    } catch { /* 继续等待 */ }
    await sleep(100);
  }
  const tabs = await (await fetch(`http://127.0.0.1:${p}/json/list`)).json();
  const page = tabs.find((t) => t.type === "page");
  if (!page) throw new Error("未找到 CDP 页面");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width, height, deviceScaleFactor: 1, mobile: false
  });
  await send("Page.navigate", { url });

  const expression = `!!document.querySelector(${JSON.stringify(waitSelector)})`;
  const start = Date.now();
  let ready = false;
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await send("Runtime.evaluate", { expression, returnByValue: true });
      if (r.result && r.result.value === true) { ready = true; break; }
    } catch { /* 导航过程中上下文尚未就绪 */ }
    await sleep(300);
  }
  if (!ready) throw new Error(`等待 ${waitSelector} 超时 (${timeoutMs} ms)`);
  if (delayMs) await sleep(delayMs);

  if (mode === "dom") {
    const r = await send("Runtime.evaluate", {
      expression: "document.documentElement.outerHTML",
      returnByValue: true
    });
    writeFileSync(out, r.result.value, "utf8");
    console.log(`DOM 已导出: ${out} (${r.result.value.length} 字符)`);
  } else if (mode === "screenshot") {
    const r = await send("Page.captureScreenshot", {
      format: "png", captureBeyondViewport: true
    });
    writeFileSync(out, Buffer.from(r.data, "base64"));
    console.log(`截图已导出: ${out}`);
  } else {
    throw new Error("未知 --mode: " + mode);
  }
} finally {
  try { if (ws) ws.close(); } catch { /* ignore */ }
  try { proc.kill(); } catch { /* ignore */ }
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
