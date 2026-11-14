/* 验证探针：仅在 URL 带 ?probe 时运行。
   导出渲染像素、几何 JSON、量化指标和四联对比图，由 tools/verify.py 从 DOM 中提取。 */
"use strict";

(function () {
  if (!new URLSearchParams(location.search).has("probe")) return;

  const SIZE = 512;
  const BG = new URLSearchParams(location.search).get("bg") === "white" ? "white" : "dark";

  function mark(step) {
    let el = document.querySelector("pre.probe-step");
    if (!el) {
      el = document.createElement("pre");
      el.className = "probe-step";
      el.style.display = "none";
      document.body.appendChild(el);
    }
    el.textContent = step;
  }

  function emit(name, text, kind, done) {
    const pre = document.createElement("pre");
    pre.className = done ? "probe-done" : "probe-" + kind;
    pre.dataset.name = name;
    pre.style.display = "none";
    pre.textContent = text;
    document.body.appendChild(pre);
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("图像加载失败: " + src.slice(0, 60)));
      img.src = src;
    });
  }

  async function imageData(src) {
    const img = await loadImage(src);
    const c = document.createElement("canvas");
    c.width = SIZE;
    c.height = SIZE;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.drawImage(img, 0, 0, SIZE, SIZE);
    return ctx.getImageData(0, 0, SIZE, SIZE).data;
  }

  function dataToUrl(data) {
    const c = document.createElement("canvas");
    c.width = SIZE;
    c.height = SIZE;
    c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(data), SIZE, SIZE), 0, 0);
    return c.toDataURL("image/png");
  }

  function rgbAt(d, i) { return [d[i], d[i + 1], d[i + 2]]; }

  function lab(rgb) {
    let [r, g, b] = rgb.map((v) => {
      v /= 255;
      return v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92;
    });
    let x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
    let y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    let z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
    const f = (t) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    x = f(x); y = f(y); z = f(z);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  }

  function maskAt(d, i) { return (255 - Math.min(d[i], d[i + 1], d[i + 2])) > 40; }

  function ssim(a, b) {
    const C1 = (0.01 * 255) ** 2;
    const C2 = (0.03 * 255) ** 2;
    const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    let total = 0;
    let blocks = 0;
    for (let by = 0; by + 8 <= SIZE; by += 8) {
      for (let bx = 0; bx + 8 <= SIZE; bx += 8) {
        let ma = 0, mb = 0;
        for (let y = by; y < by + 8; y++) {
          for (let x = bx; x < bx + 8; x++) {
            const i = (y * SIZE + x) * 4;
            ma += lum(a, i); mb += lum(b, i);
          }
        }
        ma /= 64; mb /= 64;
        let va = 0, vb = 0, cab = 0;
        for (let y = by; y < by + 8; y++) {
          for (let x = bx; x < bx + 8; x++) {
            const i = (y * SIZE + x) * 4;
            const la = lum(a, i) - ma, lb = lum(b, i) - mb;
            va += la * la; vb += lb * lb; cab += la * lb;
          }
        }
        va /= 63; vb /= 63; cab /= 63;
        total += ((2 * ma * mb + C1) * (2 * cab + C2)) /
                 ((ma * ma + mb * mb + C1) * (va + vb + C2));
        blocks++;
      }
    }
    return total / blocks;
  }

  function metrics(a, b) {
    let mse = 0, inter = 0, union = 0, de = 0, deCount = 0;
    for (let i = 0; i < a.length; i += 4) {
      const ca = rgbAt(a, i), cb = rgbAt(b, i);
      for (let k = 0; k < 3; k++) mse += (ca[k] - cb[k]) ** 2;
      const ma = maskAt(a, i), mb = maskAt(b, i);
      if (ma && mb) {
        inter++; union++;
        const la = lab(ca), lb = lab(cb);
        de += Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
        deCount++;
      } else if (ma || mb) union++;
    }
    mse /= (SIZE * SIZE * 3);
    return {
      psnr: 10 * Math.log10(255 ** 2 / mse),
      ssim: ssim(a, b),
      iou: union ? inter / union : 0,
      deltaE: deCount ? de / deCount : 0
    };
  }

  function diff(a, b) {
    let sum = 0, big = 0, n = SIZE * SIZE;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.max(
        Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])
      );
      sum += d;
      if (d > 30) big++;
    }
    return { mean: sum / n, big: (big / n) * 100 };
  }

  function float32Base64(arr) {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  function geometryJson(probe) {
    const g = probe.geometry();
    return JSON.stringify({
      meta: {
        title: "Flower vectorization - triangulated geometry snapshot",
        format: "Float32Array, base64 (little-endian)",
        vertexFloats: 10,
        layout: ["pos.xy", "color.rgba", "t", "angle", "kind", "unused"],
        background: BG,
        note: "由页面运行时导出，与 index.html 渲染所用的顶点缓冲完全一致"
      },
      vector: probe.vectorData(),
      geometry: {
        triangleCount: g.triangleCount,
        lineVertexCount: g.lineVertexCount,
        trianglesBase64: float32Base64(g.triangleData),
        linesBase64: float32Base64(g.lineData)
      }
    }, null, 2);
  }

  function compareImage(images, lines) {
    const c = document.createElement("canvas");
    c.width = SIZE * 4 + 50;
    c.height = SIZE + 70 + 34 * lines.length + 20;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.font = "bold 22px 'Microsoft YaHei', sans-serif";
    ctx.fillStyle = "#111111";
    images.forEach((item, i) => {
      ctx.drawImage(item.canvas, 10 + i * (SIZE + 10), 45);
      ctx.fillText(item.label, 10 + i * (SIZE + 10), 30);
    });
    ctx.font = "19px Consolas, 'Microsoft YaHei', monospace";
    lines.forEach((line, j) => ctx.fillText(line, 12, SIZE + 78 + j * 34));
    return c.toDataURL("image/png");
  }

  async function canvasFrom(src) {
    const img = await loadImage(src);
    const c = document.createElement("canvas");
    c.width = SIZE;
    c.height = SIZE;
    c.getContext("2d").drawImage(img, 0, 0, SIZE, SIZE);
    return c;
  }

  async function run() {
    const probe = window.__FLOWER_PROBE__;
    const waited = Date.now();
    while (!probe || !probe.ready) {
      if (Date.now() - waited > 20000) throw new Error("实验页面初始化超时");
      await new Promise((r) => setTimeout(r, 100));
    }
    mark("ready");
    await probe.ready;
    mark("renderers-ready");

    const status = {
      webgl: document.getElementById("statWebglApi").textContent,
      webgpu: document.getElementById("statWebgpuApi").textContent,
      statusLine: document.getElementById("statusLine").textContent,
      background: BG,
      fps: {
        gl: document.getElementById("glFps").textContent,
        gpu: document.getElementById("gpuFps").textContent
      }
    };

    const sourceData = await (async () => {
      const c = document.createElement("canvas");
      c.width = SIZE; c.height = SIZE;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, SIZE, SIZE);
      const img = probe.sourceImage();
      if (img) ctx.drawImage(img, 0, 0, SIZE, SIZE);
      return ctx.getImageData(0, 0, SIZE, SIZE);
    })();

    const sourceUrl = (() => {
      const c = document.createElement("canvas");
      c.width = SIZE; c.height = SIZE;
      const ctx = c.getContext("2d");
      ctx.putImageData(sourceData, 0, 0);
      return c.toDataURL("image/png");
    })();

    const svgBlob = new Blob([probe.svgText()], { type: "image/svg+xml;charset=utf-8" });
    emit("flower.svg", probe.svgText(), "text");
    const svgUrl = URL.createObjectURL(svgBlob);
    const svgData = await imageData(svgUrl);
    emit("svg_render.png", dataToUrl(svgData).split(",")[1], "png");

    mark("capture");
    const captured = {};
    const uniforms = new Float32Array([0, 0, 0, 0, 1, 1, 1, BG === "white" ? 1 : 0]);
    for (const renderer of probe.renderers()) {
      try {
        renderer.render(uniforms);
        captured[renderer.api] = await renderer.capture();
      } catch (err) {
        captured[renderer.api] = { error: err.message };
      }
    }
    mark("captured");
    const glUrl = captured.WebGL2 && typeof captured.WebGL2 === "string" ? captured.WebGL2 : null;
    const gpuUrl = captured.WebGPU && typeof captured.WebGPU === "string" ? captured.WebGPU : null;
    if (glUrl) emit("webgl_gl_" + BG + ".png", glUrl.split(",")[1], "png");
    if (gpuUrl) emit("webgpu_gpu_" + BG + ".png", gpuUrl.split(",")[1], "png");

    const glData = glUrl ? await imageData(glUrl) : null;
    const gpuData = gpuUrl ? await imageData(gpuUrl) : null;

    const lines = [];
    const add = (label, data) => {
      if (!data) { lines.push(label + ": 不可用（本次运行未取得读回像素）"); return; }
      const m = metrics(sourceData.data, data);
      lines.push(`${label}: PSNR ${m.psnr.toFixed(2)} dB  SSIM ${m.ssim.toFixed(3)}  轮廓IoU ${m.iou.toFixed(3)}  平均ΔE ${m.deltaE.toFixed(1)}`);
    };
    add("flower.svg (Chrome)", svgData);
    add("WebGL 2 (SwiftShader)", glData);
    add("WebGPU (SwiftShader)", gpuData);
    if (glData && gpuData) {
      const d = diff(glData, gpuData);
      lines.push(`WebGL vs WebGPU: 平均像素差 ${d.mean.toFixed(2)}/255, 差>30 的像素占 ${d.big.toFixed(2)}%`);
    }
    lines.push(`运行状态: WebGL=${status.webgl} | WebGPU=${status.webgpu} | 背景=${BG}`);

    const compareItems = [
      { label: "原图 JPEG", canvas: await canvasFrom(sourceUrl) },
      { label: "flower.svg (Chrome)", canvas: await canvasFrom(svgUrl) }
    ];
    if (glUrl) compareItems.push({ label: "WebGL 2", canvas: await canvasFrom(glUrl) });
    if (gpuUrl) compareItems.push({ label: "WebGPU", canvas: await canvasFrom(gpuUrl) });
    emit("compare_" + BG + ".png", compareImage(compareItems, lines).split(",")[1], "png");

    emit("flower_geometry.json", geometryJson(probe), "text");
    emit("metrics_" + BG + ".txt", lines.join("\n") + "\n", "text");
    emit("probe-status.json", JSON.stringify({
      ...status,
      glCaptured: Boolean(glUrl),
      gpuCaptured: Boolean(gpuUrl),
      captureErrors: Object.fromEntries(
        Object.entries(captured).filter(([, v]) => !v || typeof v !== "string")
      )
    }, null, 2), "text");
    emit("", "1", "", true);
  }

  const start = () => {
    mark("start");
    run().catch((err) => {
      mark("error: " + err.message);
      emit("probe-error.txt", "探针失败: " + err.stack, "text");
      emit("", "1", "", true);
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
