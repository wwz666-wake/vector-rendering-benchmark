"""无头 Chrome 验证：导出渲染像素、几何快照、量化指标与整页截图。

不依赖 numpy / OpenCV / puppeteer：像素读回与指标计算全部在页面内
由 tools/probe.js 用 Canvas 2D 完成，本脚本只负责调度 Chrome 与落盘。

用法： python tools/verify.py
需要先运行 python tools/build.py 生成 index.html。
"""
import base64
import html
import json
import shutil
import subprocess
import sys
import tempfile
import threading
from functools import partial
from html.parser import HTMLParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VERIFY = ROOT / "verify"
VERIFY.mkdir(exist_ok=True)
PORT = 8766


def chrome_path():
    candidates = [
        Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
        Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
        Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
        Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
    ]
    for p in candidates:
        if p.exists():
            return str(p)
    found = shutil.which("google-chrome") or shutil.which("chromium")
    if found:
        return found
    raise SystemExit("未找到 Chrome / Edge，无法执行无头验证")


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class ProbeParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.items = {}
        self.current = None
        self.buffer = []
        self.done = False

    def handle_starttag(self, tag, attrs):
        if tag != "pre":
            return
        data = dict(attrs)
        cls = data.get("class", "")
        if not cls.startswith("probe-"):
            return
        if cls == "probe-done":
            self.done = True
        self.current = (data.get("data-name", ""), cls)
        self.buffer = []

    def handle_data(self, data):
        if self.current:
            self.buffer.append(data)

    def handle_endtag(self, tag):
        if tag == "pre" and self.current:
            name, cls = self.current
            self.items[name] = (cls, html.unescape("".join(self.buffer)))
            self.current = None


def run_shot(exe, url, out, mode="dom", wait="pre.probe-done",
             delay=0, window="1440,3300", wait_ms=90000, timeout=240):
    """通过 tools/shot.mjs 用 CDP 真实等待页面，避免虚拟时间打断 WebGPU 初始化。"""
    cmd = [
        "node", str(ROOT / "tools" / "shot.mjs"),
        f"--url={url}",
        f"--out={out}",
        f"--mode={mode}",
        f"--chrome={exe}",
        f"--wait={wait}",
        f"--delay={delay}",
        f"--window={window}",
        f"--timeout={wait_ms}",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True,
                            encoding="utf-8", errors="replace", timeout=timeout)
    if result.returncode != 0:
        raise SystemExit(f"CDP {mode} 失败: {result.stdout}\n{result.stderr}")
    print(result.stdout.strip())
    return out


def parse_probe(dom, label):
    parser = ProbeParser()
    parser.feed(dom)
    if not parser.done:
        raise SystemExit(f"{label}: 探针未执行完毕，DOM 中没有 probe-done 标记")
    if "probe-error.txt" in parser.items:
        raise SystemExit(f"{label}: " + parser.items["probe-error.txt"][1][:800])
    print(f"{label}: 探针完成，导出 {len(parser.items)} 项")
    return parser.items


def main():
    exe = chrome_path()
    if not (ROOT / "index.html").exists():
        raise SystemExit("请先运行 python tools/build.py")

    server = ThreadingHTTPServer(
        ("127.0.0.1", PORT),
        partial(QuietHandler, directory=str(ROOT)),
    )
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"本地预览服务: http://127.0.0.1:{PORT}/")

    results = {}
    try:
        for bg in ("dark", "white"):
            dom_path = ROOT / f".probe-{bg}.html"
            run_shot(exe, f"http://127.0.0.1:{PORT}/index.html?probe&bg={bg}",
                     str(dom_path), mode="dom", wait_ms=90000)
            results[bg] = parse_probe(dom_path.read_text(encoding="utf-8"), f"[{bg}]")
            dom_path.unlink(missing_ok=True)
            if "probe-status.json" in results[bg]:
                status = json.loads(results[bg]["probe-status.json"][1])
                print(f"[{bg}] WebGL={status['webgl']} WebGPU={status['webgpu']} "
                      f"GL读回={status['glCaptured']} GPU读回={status['gpuCaptured']}")

            shot_path = VERIFY / f"arena_{bg}.png"
            run_shot(exe, f"http://127.0.0.1:{PORT}/index.html?bg={bg}",
                     str(shot_path), mode="screenshot", wait="#render",
                     delay=2500, wait_ms=30000, timeout=120)
            print(f"[{bg}] 整页截图: {shot_path.name} ({shot_path.stat().st_size} bytes)")
    finally:
        server.shutdown()

    # 根目录下的独立交付文件（白底运行优先，与参考包一致）
    for name in ("flower.svg", "flower_geometry.json"):
        source = results["white"].get(name) or results["dark"].get(name)
        if not source:
            raise SystemExit(f"缺少 {name}")
        (ROOT / name).write_text(source[1], encoding="utf-8")
        print(f"写出 {name}: {(ROOT / name).stat().st_size} bytes")

    metrics_name = "metrics_white.txt" if "metrics_white.txt" in results["white"] else "metrics_dark.txt"
    metrics = results["white"].get(metrics_name) or results["dark"].get(metrics_name)
    if metrics:
        (VERIFY / "metrics.txt").write_text(metrics[1], encoding="utf-8")
        print("写出 verify/metrics.txt")

    image_targets = {
        "svg_render.png": "svg_render.png",
        "webgl_gl_dark.png": "webgl_gl_dark.png",
        "webgl_gl_white.png": "webgl_gl_white.png",
        "webgpu_gpu_dark.png": "webgpu_gpu_dark.png",
        "webgpu_gpu_white.png": "webgpu_gpu_white.png",
        "compare_dark.png": "compare_dark.png",
        "compare_white.png": "compare_white.png",
    }
    for bg in ("dark", "white"):
        for src_name, (cls, payload) in results[bg].items():
            if cls != "probe-png" or not src_name:
                continue
            target = image_targets.get(src_name)
            if target:
                (VERIFY / target).write_bytes(base64.b64decode(payload))
                print(f"写出 verify/{target}")

    compare = VERIFY / "compare_white.png"
    if not compare.exists():
        compare = VERIFY / "compare_dark.png"
    if compare.exists():
        shutil.copyfile(compare, ROOT / "compare.png")
        print(f"写出 compare.png: {(ROOT / 'compare.png').stat().st_size} bytes")

    statuses = {}
    for bg in ("dark", "white"):
        if "probe-status.json" in results[bg]:
            statuses[bg] = json.loads(results[bg]["probe-status.json"][1])
    (VERIFY / "probe-status.json").write_text(
        json.dumps(statuses, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print("验证完成。")


if __name__ == "__main__":
    sys.exit(main())
