"""生成可直接双击打开的自包含 index.html。

把样式、渲染脚本、验证探针和原图（data URI）全部内联，
因此解压后无需安装任何依赖、无需启动服务器即可查看实验页面。

用法： python tools/build.py
"""
import base64
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / "tools"

source_bytes = (ROOT / "assets" / "flower-source.jpg").read_bytes()
video_bytes = (ROOT / "assets" / "ai-flower.mp4").stat().st_size
source_uri = "data:image/jpeg;base64," + base64.b64encode(source_bytes).decode("ascii")

config = (
    "window.__INLINE_SOURCE__ = " + json.dumps(source_uri) + ";\n"
    "window.__ASSET_SIZES__ = " + json.dumps(
        {"source": len(source_bytes), "video": video_bytes}
    ) + ";"
)

template = (TOOLS / "page_template.html").read_text(encoding="utf-8")
css = (TOOLS / "styles.css").read_text(encoding="utf-8")
app = (TOOLS / "app.js").read_text(encoding="utf-8")
probe = (TOOLS / "probe.js").read_text(encoding="utf-8")

for name, text in (("app.js", app), ("probe.js", probe), ("styles.css", css)):
    if "</script" in text.lower():
        raise SystemExit(f"{name} 含有 </script，不能直接内联")

page = (
    template
    .replace("__CSS__", css)
    .replace("__CONFIG__", config)
    .replace("__APP_JS__", app)
    .replace("__PROBE_JS__", probe)
    .replace("__SOURCE__", source_uri)
)
if "__APP_JS__" in page or "__CONFIG__" in page or "__CSS__" in page or "__PROBE_JS__" in page:
    raise SystemExit("模板占位符未全部替换")

(ROOT / "index.html").write_text(page, encoding="utf-8")
print(f"index.html: {len(page.encode('utf-8'))} bytes (自包含)")
