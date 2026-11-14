"use strict";

const SAMPLE = 320;
const RADIAL_SAMPLES = 240;
const VERTEX_FLOATS = 10;
const VERTEX_STRIDE = VERTEX_FLOATS * 4;
const TAU = Math.PI * 2;
const QUERY = new URLSearchParams(location.search);
const PROBE = QUERY.has("probe");
const BG_WHITE = QUERY.get("bg") === "white";
const ONLY = QUERY.get("only");
const INLINE_SOURCE = window.__INLINE_SOURCE__ || "assets/flower-source.jpg";

const STAMENS = [
  { from: { x: -0.01, y: 0.01 }, to: { x: -0.09, y: 0.50 }, radius: 0.050 },
  { from: { x:  0.00, y: 0.00 }, to: { x:  0.31, y: 0.42 }, radius: 0.050 },
  { from: { x:  0.02, y: 0.00 }, to: { x:  0.39, y: 0.01 }, radius: 0.050 }
];

const $ = (id) => document.getElementById(id);

const state = {
  playing: true,
  speed: 1,
  showOutline: true,
  showDetails: true,
  showMesh: false,
  showPoints: false
};

let sourceImage = null;
let extraction = null;
let geometry = null;
let svgText = "";
let vectorData = null;
let vectorBytes = 0;
let sourceBytes = 0;
let videoBytes = 0;
let renderers = [];
let simTime = 0;
let lastNow = performance.now();

window.__FLOWER_PROBE__ = {
  ready: null,
  bgWhite: BG_WHITE,
  vectorData: () => vectorData,
  svgText: () => svgText,
  geometry: () => geometry,
  renderers: () => renderers,
  sourceImage: () => sourceImage,
  extraction: () => extraction
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindControls();
  if ($("sourceImg")) $("sourceImg").src = INLINE_SOURCE;
  if (PROBE) state.playing = false;
  try {
    sourceImage = await loadImage(INLINE_SOURCE);
  } catch (err) {
    $("statusLine").textContent = "原图加载失败：" + err.message;
  }

  extraction = vectorize();
  geometry = buildGeometry(extraction);
  svgText = buildSvg(extraction);
  vectorData = extraction.data;
  vectorBytes = new Blob([JSON.stringify(vectorData, null, 2)], { type: "application/json" }).size;

  renderSvgPreview();
  drawMaskPreview(extraction);
  updateStaticStats();
  await measureAssets();

  $("statusLine").textContent = extraction.fallback
    ? "已就绪（像素读取受限，使用参数化回退轮廓）"
    : "已就绪：轮廓提取与 SVG 重建完成，正在启动 GPU 管线";
  const rendererReady = initRenderers().catch((err) => {
    $("statusLine").textContent = "GPU 管线启动异常：" + err.message;
  });
  requestAnimationFrame(frame);
  window.__FLOWER_PROBE__.ready = rendererReady.then(
    () => new Promise((resolve) => setTimeout(resolve, 250))
  );
}

function bindControls() {
  $("playBtn").addEventListener("click", () => {
    state.playing = !state.playing;
    $("playBtn").textContent = state.playing ? "暂停动画" : "继续动画";
  });

  $("speed").addEventListener("input", (e) => {
    state.speed = Number(e.target.value);
    $("speedValue").textContent = state.speed.toFixed(1) + "×";
  });

  $("toggleOutline").addEventListener("change", (e) => { state.showOutline = e.target.checked; });
  $("toggleDetails").addEventListener("change", (e) => { state.showDetails = e.target.checked; });
  $("toggleMesh").addEventListener("change", (e) => { state.showMesh = e.target.checked; });
  $("togglePoints").addEventListener("change", (e) => { state.showPoints = e.target.checked; });

  $("downloadSvg").addEventListener("click", () => {
    if (!svgText) return;
    downloadBlob(new Blob([svgText], { type: "image/svg+xml" }), "flower-vectorized.svg");
  });

  $("downloadJson").addEventListener("click", () => {
    if (!vectorData) return;
    downloadBlob(new Blob([JSON.stringify(vectorData, null, 2)], { type: "application/json" }), "flower-vector-data.json");
  });

  $("reextract").addEventListener("click", () => location.reload());
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("无法加载 " + src));
    img.src = src;
  });
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

async function getBlobSize(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return 0;
    const blob = await res.blob();
    return blob.size;
  } catch (_) {
    return 0;
  }
}

function getVideoDuration(video) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    if (video.readyState >= 1 && Number.isFinite(video.duration)) return finish(video.duration);
    video.addEventListener("loadedmetadata", () => finish(video.duration), { once: true });
    video.addEventListener("error", () => finish(0), { once: true });
    setTimeout(() => finish(Number.isFinite(video.duration) ? video.duration : 0), 3500);
  });
}

async function measureAssets() {
  const known = window.__ASSET_SIZES__ || {};
  sourceBytes = (await getBlobSize("assets/flower-source.jpg")) || known.source || 0;
  videoBytes = (await getBlobSize("assets/ai-flower.mp4")) || known.video || 0;
  const duration = await getVideoDuration($("aiVideo"));

  const sourceText = formatBytes(sourceBytes);
  const videoText = formatBytes(videoBytes);
  const durationText = duration ? duration.toFixed(1) + " s" : "—";

  $("sourceSize").textContent = sourceText;
  $("videoSize").textContent = videoText;
  $("videoDuration").textContent = durationText;
  $("statSourceBytes").textContent = sourceText;
  $("statVideoBytes").textContent = videoText;
  $("statVideoDuration").textContent = durationText;
  $("cmpAiSize").textContent = videoText;
  $("cmpVectorSize").textContent = formatBytes(vectorBytes);
}

function updateStaticStats() {
  $("statExtractMs").textContent = extraction.extractMs.toFixed(1) + " ms";
  $("statControlPoints").textContent = extraction.simplified.length + " 点";
  $("statDensePoints").textContent = extraction.dense.length + " 点";
  $("statTriangles").textContent = geometry.triangleCount.toLocaleString("zh-CN");
  $("statSvgChars").textContent = svgText.length.toLocaleString("zh-CN");
  $("statVectorBytes").textContent = formatBytes(vectorBytes);
  $("statWebglTris").textContent = geometry.triangleCount.toLocaleString("zh-CN");
  $("statWebgpuTris").textContent = geometry.triangleCount.toLocaleString("zh-CN");
  $("statNotches").textContent = extraction.notches.length + " 个凹口";
  $("statCenter").textContent = "(" + extraction.cx.toFixed(1) + ", " + extraction.cy.toFixed(1) + ")";
  $("statThreshold").textContent = extraction.fallback ? "参数化回退" : "S>0.18 · R−B>42";
}

function vectorize() {
  const t0 = performance.now();
  const w = SAMPLE;
  const h = SAMPLE;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#f7f7f4";
  ctx.fillRect(0, 0, w, h);
  if (sourceImage) ctx.drawImage(sourceImage, 0, 0, w, h);

  let pixels;
  try {
    pixels = ctx.getImageData(0, 0, w, h).data;
  } catch (err) {
    const result = fallbackExtraction("浏览器阻止了本地像素读取：" + err.message);
    result.extractMs = performance.now() - t0;
    return result;
  }

  const center = findCenter(pixels, w, h);
  let mask = buildColorMask(pixels, w, h);
  mask = morphologicalClose(mask, w, h, 1);
  const radii = computeRadii(mask, w, h, center.x, center.y);
  const maxRadius = Math.max(...radii);
  const scale = 0.92 / Math.max(maxRadius, 1);
  const segCanvas = createSegCanvas(mask, w, h);

  const result = buildExtraction({
    w, h, cx: center.x, cy: center.y, radii, scale,
    sourceCanvas: canvas, segCanvas, fallback: false, reason: ""
  });
  result.extractMs = performance.now() - t0;
  return result;
}

function fallbackExtraction(reason) {
  const w = SAMPLE;
  const h = SAMPLE;
  const cx = w / 2;
  const cy = h / 2;
  const maxR = Math.min(cx, cy) - 8;
  const radii = new Float32Array(RADIAL_SAMPLES);

  for (let i = 0; i < RADIAL_SAMPLES; i++) {
    const a = TAU * i / RADIAL_SAMPLES;
    const lobe = Math.pow((1 + Math.cos(5 * (a - 0.32))) / 2, 0.72);
    radii[i] = maxR * (0.48 + 0.49 * lobe);
  }
  radii.set(smoothCircular(radii, 2));

  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = w;
  sourceCanvas.height = h;
  const sctx = sourceCanvas.getContext("2d");
  sctx.fillStyle = "#f7f7f4";
  sctx.fillRect(0, 0, w, h);
  if (sourceImage) sctx.drawImage(sourceImage, 0, 0, w, h);

  const segCanvas = document.createElement("canvas");
  segCanvas.width = w;
  segCanvas.height = h;
  const gctx = segCanvas.getContext("2d");
  gctx.fillStyle = "#ff7a1a";
  gctx.beginPath();
  for (let i = 0; i < RADIAL_SAMPLES; i++) {
    const a = TAU * i / RADIAL_SAMPLES;
    const x = cx + Math.cos(a) * radii[i];
    const y = cy - Math.sin(a) * radii[i];
    if (i === 0) gctx.moveTo(x, y); else gctx.lineTo(x, y);
  }
  gctx.closePath();
  gctx.fill();

  const scale = 0.92 / maxR;
  const result = buildExtraction({
    w, h, cx, cy, radii, scale, sourceCanvas, segCanvas,
    fallback: true, reason
  });
  return result;
}

function isFlowerPixel(r, g, b) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const sat = mx === 0 ? 0 : (mx - mn) / mx;
  return r > 145 && (r - b) > 42 && sat > 0.18 && g < 248;
}

function findCenter(pixels, w, h) {
  let sx = 0, sy = 0, sw = 0;
  const x0 = Math.floor(w * 0.30), x1 = Math.ceil(w * 0.70);
  const y0 = Math.floor(h * 0.30), y1 = Math.ceil(h * 0.70);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      if (r > 220 && g > 150 && b < 150 && (r - b) > 100) {
        const weight = Math.max(1, (r - 190) * (g - 110) / 8000);
        sx += x * weight;
        sy += y * weight;
        sw += weight;
      }
    }
  }
  if (sw === 0) return { x: w / 2, y: h / 2 };
  return {
    x: clamp(sx / sw, w * 0.44, w * 0.56),
    y: clamp(sy / sw, h * 0.44, h * 0.56)
  };
}

function buildColorMask(pixels, w, h) {
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      mask[y * w + x] = isFlowerPixel(pixels[i], pixels[i + 1], pixels[i + 2]) ? 1 : 0;
    }
  }
  return mask;
}

function dilate(mask, w, h) {
  const out = new Uint8Array(mask.length);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let hit = 0;
      for (let dy = -1; dy <= 1 && !hit; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (mask[(y + dy) * w + x + dx]) { hit = 1; break; }
        }
      }
      out[y * w + x] = hit;
    }
  }
  return out;
}

function erode(mask, w, h) {
  const out = new Uint8Array(mask.length);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let all = 1;
      for (let dy = -1; dy <= 1 && all; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!mask[(y + dy) * w + x + dx]) { all = 0; break; }
        }
      }
      out[y * w + x] = all;
    }
  }
  return out;
}

function morphologicalClose(mask, w, h, iterations) {
  let m = mask;
  for (let k = 0; k < iterations; k++) m = erode(dilate(m, w, h), w, h);
  return m;
}

function createSegCanvas(mask, w, h) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const j = i * 4;
    img.data[j] = 255;
    img.data[j + 1] = 122;
    img.data[j + 2] = 26;
    img.data[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function sampleMask(mask, w, h, x, y) {
  const xi = Math.round(x), yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= w || yi >= h) return 0;
  return mask[yi * w + xi];
}

function computeRadii(mask, w, h, cx, cy) {
  const n = RADIAL_SAMPLES;
  const raw = new Float32Array(n);
  const maxR = Math.min(cx, cy, w - cx, h - cy) - 2;

  for (let i = 0; i < n; i++) {
    const a = TAU * i / n;
    const ca = Math.cos(a), sa = Math.sin(a);
    let farthest = 0;
    for (let r = 0; r <= maxR; r += 0.6) {
      const x = cx + ca * r;
      const y = cy - sa * r;
      if (sampleMask(mask, w, h, x, y)) farthest = r;
    }
    raw[i] = farthest > maxR * 0.28 ? farthest : NaN;
  }

  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(raw[i])) {
      let sum = 0, count = 0;
      for (let k = 1; k <= n; k++) {
        const left = raw[(i - k + n) % n];
        const right = raw[(i + k) % n];
        if (Number.isFinite(left)) { sum += left; count++; break; }
        if (Number.isFinite(right)) { sum += right; count++; break; }
      }
      raw[i] = count ? sum / count : maxR * 0.7;
    }
  }

  const median = medianFilterCircular(raw, 5);
  const smoothed = smoothCircular(median, 2);
  for (let i = 0; i < n; i++) smoothed[i] = clamp(smoothed[i], maxR * 0.30, maxR);
  return smoothed;
}

function medianFilterCircular(values, radius) {
  const n = values.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const window = [];
    for (let k = -radius; k <= radius; k++) window.push(values[(i + k + n) % n]);
    window.sort((a, b) => a - b);
    out[i] = window[Math.floor(window.length / 2)];
  }
  return out;
}

function smoothCircular(values, passes) {
  const n = values.length;
  let current = Float32Array.from(values);
  for (let p = 0; p < passes; p++) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      out[i] =
        current[(i - 2 + n) % n] * 0.08 +
        current[(i - 1 + n) % n] * 0.20 +
        current[i] * 0.44 +
        current[(i + 1) % n] * 0.20 +
        current[(i + 2) % n] * 0.08;
    }
    current = out;
  }
  return current;
}

function buildExtraction(cfg) {
  const n = cfg.radii.length;
  const contourPx = [];
  for (let i = 0; i < n; i++) {
    const a = TAU * i / n;
    const r = cfg.radii[i];
    contourPx.push({ x: Math.cos(a) * r, y: Math.sin(a) * r, angle: a, radius: r });
  }

  const simplifiedPx = simplifyClosedAdaptive(contourPx);
  const simplified = simplifiedPx.map((p) => ({ x: p.x * cfg.scale, y: p.y * cfg.scale }));
  const dense = subdivideClosed(simplified, 5);
  const notches = findNotches(cfg.radii, cfg.scale);

  const data = {
    meta: {
      title: "Flower vectorization experiment",
      source: "assets/flower-source.jpg",
      method: cfg.fallback ? "Parametric fallback contour" : "Pixel segmentation + radial contour + RDP + Catmull-Rom",
      sampleResolution: SAMPLE,
      radialSamples: RADIAL_SAMPLES,
      threshold: cfg.fallback ? null : { saturationMin: 0.18, redMinusBlueMin: 42, redMin: 145 },
      center: { x: Number(cfg.cx.toFixed(2)), y: Number(cfg.cy.toFixed(2)) },
      scale: Number(cfg.scale.toFixed(6)),
      fallbackReason: cfg.reason || null
    },
    radii: Array.from(cfg.radii, (v) => Number(v.toFixed(2))),
    simplifiedControlPoints: simplified.map((p) => ({ x: Number(p.x.toFixed(5)), y: Number(p.y.toFixed(5)) })),
    denseContour: dense.map((p) => ({ x: Number(p.x.toFixed(5)), y: Number(p.y.toFixed(5)) })),
    notchAngles: notches.map((nItem) => Number(nItem.angle.toFixed(5))),
    stamens: STAMENS,
    svgPath: "",
    stats: {
      controlPoints: simplified.length,
      densePoints: dense.length,
      radialSamples: RADIAL_SAMPLES
    }
  };

  return {
    w: cfg.w, h: cfg.h, cx: cfg.cx, cy: cfg.cy, scale: cfg.scale,
    radii: cfg.radii, contourPx, simplified, dense, notches,
    sourceCanvas: cfg.sourceCanvas, segCanvas: cfg.segCanvas,
    fallback: cfg.fallback, reason: cfg.reason, data,
    extractMs: 0
  };
}

function simplifyClosedAdaptive(points) {
  const tolerances = [0.7, 1.0, 1.4, 1.9, 2.6, 3.5, 4.8];
  let best = null;
  let usedTolerance = tolerances[tolerances.length - 1];
  for (const eps of tolerances) {
    const simplified = simplifyClosed(points, eps);
    best = simplified;
    usedTolerance = eps;
    if (simplified.length <= 92) break;
  }
  if (!best || best.length < 12) best = simplifyClosed(points, 0.5);
  best.tolerance = usedTolerance;
  return best;
}

function simplifyClosed(points, epsilon) {
  const n = points.length;
  if (n < 8) return points.slice();
  let start = 0;
  for (let i = 1; i < n; i++) if (points[i].radius < points[start].radius) start = i;

  let farOffset = Math.floor(n / 2);
  let farDistance = -1;
  for (let k = 1; k < n; k++) {
    const p = points[(start + k) % n];
    const d = distance(p, points[start]);
    if (d > farDistance) { farDistance = d; farOffset = k; }
  }

  const ordered = [];
  for (let k = 0; k <= n; k++) ordered.push(points[(start + k) % n]);
  const chainA = ordered.slice(0, farOffset + 1);
  const chainB = ordered.slice(farOffset);
  const partA = rdp(chainA, epsilon);
  const partB = rdp(chainB, epsilon);
  return partA.concat(partB.slice(1, -1));
}

function rdp(points, epsilon) {
  if (points.length <= 2) return points.slice();
  const first = points[0];
  const last = points[points.length - 1];
  let maxDist = -1;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], first, last);
    if (d > maxDist) { maxDist = d; index = i; }
  }
  if (maxDist <= epsilon) return [first, last];
  const left = rdp(points.slice(0, index + 1), epsilon);
  const right = rdp(points.slice(index), epsilon);
  return left.slice(0, -1).concat(right);
}

function perpendicularDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return distance(p, a);
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / Math.hypot(dx, dy);
}

function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return {
    x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)
  };
}

function subdivideClosed(points, subdivisions) {
  const n = points.length;
  if (n < 4) return points.slice();
  const out = [];
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    for (let s = 0; s < subdivisions; s++) out.push(catmullRom(p0, p1, p2, p3, s / subdivisions));
  }
  return out;
}

function findNotches(radii, scale) {
  const n = radii.length;
  const mean = radii.reduce((a, b) => a + b, 0) / n;
  const candidates = [];
  for (let i = 0; i < n; i++) {
    let isMin = true;
    for (let k = 1; k <= 6; k++) {
      if (radii[i] > radii[(i + k) % n] || radii[i] > radii[(i - k + n) % n]) { isMin = false; break; }
    }
    if (isMin && radii[i] < mean * 0.96) candidates.push({ i, r: radii[i], angle: TAU * i / n });
  }
  candidates.sort((a, b) => a.r - b.r);
  const chosen = [];
  for (const c of candidates) {
    if (chosen.every((d) => angularDistance(c.angle, d.angle) > 0.55)) {
      chosen.push({ angle: c.angle, r: c.r * scale });
      if (chosen.length === 5) break;
    }
  }
  while (chosen.length < 5) {
    const angle = TAU * chosen.length / 5;
    chosen.push({ angle, r: mean * scale * 0.72 });
  }
  return chosen.sort((a, b) => a.angle - b.angle);
}

function angularDistance(a, b) {
  let d = Math.abs(a - b) % TAU;
  if (d > Math.PI) d = TAU - d;
  return d;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function lerpPoint(p, t) { return { x: p.x * t, y: p.y * t }; }
function addPoints(a, b) { return { x: a.x + b.x, y: a.y + b.y }; }
function angleOf(p) { return Math.atan2(p.y, p.x); }

function pushVertex(arr, p, color, t, angle, kind) {
  arr.push(
    p.x, p.y,
    color[0], color[1], color[2], color[3],
    t, angle, kind, 0
  );
}

function addTri(arr, a, b, c, color, t, angle, kind) {
  pushVertex(arr, a, color, t, angle, kind);
  pushVertex(arr, b, color, t, angle, kind);
  pushVertex(arr, c, color, t, angle, kind);
}

function addQuad(arr, a, b, c, d, color, t, angle, kind) {
  addTri(arr, a, b, c, color, t, angle, kind);
  addTri(arr, a, c, d, color, t, angle, kind);
}

function addQuadT(arr, a, b, c, d, color, t0, t1, angle, kind) {
  pushVertex(arr, a, color, t0, angle, kind);
  pushVertex(arr, b, color, t0, angle, kind);
  pushVertex(arr, c, color, t1, angle, kind);
  pushVertex(arr, a, color, t0, angle, kind);
  pushVertex(arr, c, color, t1, angle, kind);
  pushVertex(arr, d, color, t1, angle, kind);
}

function addDisc(arr, center, radius, color, t, angle, kind, segments = 28) {
  for (let i = 0; i < segments; i++) {
    const a0 = TAU * i / segments;
    const a1 = TAU * (i + 1) / segments;
    const p0 = { x: center.x + Math.cos(a0) * radius, y: center.y + Math.sin(a0) * radius };
    const p1 = { x: center.x + Math.cos(a1) * radius, y: center.y + Math.sin(a1) * radius };
    addTri(arr, center, p0, p1, color, t, angle, kind);
  }
}

function addTaperedLine(arr, from, to, width0, width1, color, kind, offset = { x: 0, y: 0 }) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const len = Math.max(Math.hypot(dx, dy), 0.0001);
  const ux = dx / len, uy = dy / len;
  const px = -uy, py = ux;
  const f = addPoints(from, offset);
  const t = addPoints(to, offset);
  const p0 = { x: f.x + px * width0 / 2, y: f.y + py * width0 / 2 };
  const p1 = { x: f.x - px * width0 / 2, y: f.y - py * width0 / 2 };
  const p2 = { x: t.x - px * width1 / 2, y: t.y - py * width1 / 2 };
  const p3 = { x: t.x + px * width1 / 2, y: t.y + py * width1 / 2 };
  addQuad(arr, p0, p1, p2, p3, color, 1, angleOf(to), kind);
}

function addLine(arr, a, b, color, t, angle, kind) {
  pushVertex(arr, a, color, t, angle, kind);
  pushVertex(arr, b, color, t, angle, kind);
}

function buildGeometry(ex) {
  const dense = ex.dense;
  const simplified = ex.simplified;
  const tris = [];
  const lines = [];
  const white = [1.0, 0.985, 0.95, 1.0];
  const fill = [1.0, 0.52, 0.04, 1.0];
  const meshColor = [0.32, 0.88, 1.0, 0.30];
  const controlColor = [0.65, 1.0, 1.0, 0.85];

  // 0: procedural background
  addQuad(
    tris,
    { x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 },
    [0, 0, 0, 1], 0, 0, 0
  );

  // 1: soft shadow silhouette
  const shadowOffset = { x: 0.025, y: -0.030 };
  const shadowColor = [0, 0, 0, 0.24];
  for (let i = 0; i < dense.length; i++) {
    const j = (i + 1) % dense.length;
    const a = addPoints(lerpPoint(dense[i], 1.025), shadowOffset);
    const b = addPoints(lerpPoint(dense[j], 1.025), shadowOffset);
    addTri(tris, shadowOffset, a, b, shadowColor, 1, angleOf(dense[i]), 1);
  }

  // 2: white outline ring, generated as an offset of the vector contour
  for (let i = 0; i < dense.length; i++) {
    const j = (i + 1) % dense.length;
    const innerA = dense[i];
    const innerB = dense[j];
    const outerA = lerpPoint(dense[i], 1.045);
    const outerB = lerpPoint(dense[j], 1.045);
    addQuad(tris, innerA, outerA, outerB, innerB, white, 1, angleOf(dense[i]), 2);
  }

  // 3: radial fill mesh; the fragment shader reconstructs the orange/yellow gradient
  const rings = [0, 0.16, 0.34, 0.54, 0.74, 0.90, 1.0];
  for (let i = 0; i < dense.length; i++) {
    const j = (i + 1) % dense.length;
    const angle = angleOf(dense[i]);
    for (let r = 0; r < rings.length - 1; r++) {
      const t0 = rings[r], t1 = rings[r + 1];
      const a = lerpPoint(dense[i], t0);
      const b = lerpPoint(dense[j], t0);
      const c = lerpPoint(dense[j], t1);
      const d = lerpPoint(dense[i], t1);
      addQuadT(tris, a, b, c, d, fill, t0, t1, angle, 3);
    }
  }

  // 4: white petal seams at the five detected notches
  for (const notch of ex.notches) {
    const dir = { x: Math.cos(notch.angle), y: Math.sin(notch.angle) };
    const from = lerpPoint(dir, 0.10);
    const to = lerpPoint(dir, Math.min(notch.r * 0.96, 0.90));
    addTaperedLine(tris, from, to, 0.010, 0.020, white, 4);
  }

  // 4: three stamens, reconstructed from the source image as vector lines + circles
  for (const stamen of STAMENS) {
    addTaperedLine(tris, stamen.from, stamen.to, 0.026, 0.026, white, 4);
    addDisc(tris, stamen.to, stamen.radius, white, 1, angleOf(stamen.to), 4, 32);
  }

  // 6: RDP control points as small diamond glyphs
  for (const p of simplified) {
    const s = 0.0075;
    addQuad(
      tris,
      { x: p.x, y: p.y + s }, { x: p.x + s, y: p.y },
      { x: p.x, y: p.y - s }, { x: p.x - s, y: p.y },
      [0.45, 1.0, 1.0, 0.95], 1, angleOf(p), 6
    );
  }

  // 5: vector mesh overlay (line list)
  for (let i = 0; i < dense.length; i += 6) {
    addLine(lines, { x: 0, y: 0 }, dense[i], meshColor, 1, angleOf(dense[i]), 5);
  }
  for (const t of [0.25, 0.5, 0.75, 1.0]) {
    for (let i = 0; i < dense.length; i++) {
      const j = (i + 1) % dense.length;
      addLine(lines, lerpPoint(dense[i], t), lerpPoint(dense[j], t), [1.0, 0.62, 0.20, 0.20], 1, angleOf(dense[i]), 5);
    }
  }
  for (let i = 0; i < simplified.length; i++) {
    const j = (i + 1) % simplified.length;
    addLine(lines, simplified[i], simplified[j], controlColor, 1, angleOf(simplified[i]), 5);
  }

  const triangleData = new Float32Array(tris);
  const lineData = new Float32Array(lines);
  return {
    triangleData,
    lineData,
    triangleCount: tris.length / VERTEX_FLOATS / 3,
    lineVertexCount: lines.length / VERTEX_FLOATS
  };
}

function toSvgPoint(p) { return { x: 320 + p.x * 280, y: 320 - p.y * 280 }; }
function n2(v) { return Number(v).toFixed(2); }

function svgPathFromPoints(points) {
  const n = points.length;
  const start = toSvgPoint(points[0]);
  let d = "M " + n2(start.x) + " " + n2(start.y);
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    const cp1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const cp2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    const c1 = toSvgPoint(cp1), c2 = toSvgPoint(cp2), end = toSvgPoint(p2);
    d += " C " + n2(c1.x) + " " + n2(c1.y) + " " + n2(c2.x) + " " + n2(c2.y) + " " + n2(end.x) + " " + n2(end.y);
  }
  return d + " Z";
}

function buildSvg(ex) {
  const d = svgPathFromPoints(ex.simplified);
  ex.data.svgPath = d;

  const seams = ex.notches.map((nItem) => {
    const a = nItem.angle;
    const r1 = Math.min(nItem.r * 0.96, 0.90);
    const p0 = toSvgPoint({ x: Math.cos(a) * 0.10, y: Math.sin(a) * 0.10 });
    const p1 = toSvgPoint({ x: Math.cos(a) * r1, y: Math.sin(a) * r1 });
    return `<line x1="${n2(p0.x)}" y1="${n2(p0.y)}" x2="${n2(p1.x)}" y2="${n2(p1.y)}" stroke="#fffaf0" stroke-width="7" stroke-linecap="round" opacity=".94"/>`;
  }).join("");

  const stamenLines = STAMENS.map((s) => {
    const a = toSvgPoint(s.from), b = toSvgPoint(s.to);
    return `<line x1="${n2(a.x)}" y1="${n2(a.y)}" x2="${n2(b.x)}" y2="${n2(b.y)}" stroke="#fffaf0" stroke-width="15" stroke-linecap="round"/>`;
  }).join("");

  const stamenCircles = STAMENS.map((s) => {
    const c = toSvgPoint(s.to);
    return `<circle cx="${n2(c.x)}" cy="${n2(c.y)}" r="${n2(s.radius * 280)}" fill="#fffaf0"/>`;
  }).join("");

  svgText = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640" role="img" aria-label="矢量化花朵 SVG">
  <defs>
    <radialGradient id="petalGrad" cx="50%" cy="50%" r="58%">
      <stop offset="0%" stop-color="#fff05a"/>
      <stop offset="34%" stop-color="#ffc21f"/>
      <stop offset="70%" stop-color="#ff7a12"/>
      <stop offset="100%" stop-color="#ef3b06"/>
    </radialGradient>
    <radialGradient id="coreGlow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#fffbd0" stop-opacity=".95"/>
      <stop offset="100%" stop-color="#ffd21a" stop-opacity="0"/>
    </radialGradient>
    <filter id="softBlur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="11"/></filter>
  </defs>
  <rect width="640" height="640" fill="#ffffff"/>
  <path d="${d}" fill="#000" opacity=".28" transform="translate(9 12)" filter="url(#softBlur)"/>
  <path d="${d}" fill="url(#petalGrad)" stroke="#fff8ec" stroke-width="15" stroke-linejoin="round"/>
  <circle cx="320" cy="320" r="112" fill="url(#coreGlow)" opacity=".82"/>
  <g>${seams}</g>
  <g>${stamenLines}${stamenCircles}</g>
</svg>`;
  return svgText;
}

function renderSvgPreview() {
  $("svgPreview").innerHTML = svgText;
}

function drawMaskPreview(ex) {
  const canvas = $("maskCanvas");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, SAMPLE, SAMPLE);
  ctx.drawImage(ex.sourceCanvas, 0, 0, SAMPLE, SAMPLE);
  ctx.globalAlpha = 0.42;
  ctx.drawImage(ex.segCanvas, 0, 0, SAMPLE, SAMPLE);
  ctx.globalAlpha = 1;

  ctx.beginPath();
  for (let i = 0; i < ex.dense.length; i++) {
    const p = ex.dense[i];
    const x = ex.cx + p.x / ex.scale;
    const y = ex.cy - p.y / ex.scale;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.strokeStyle = "rgba(77, 208, 225, 0.96)";
  ctx.lineWidth = 1.3;
  ctx.stroke();

  for (const p of ex.simplified) {
    const x = ex.cx + p.x / ex.scale;
    const y = ex.cy - p.y / ex.scale;
    ctx.beginPath();
    ctx.arc(x, y, 2.0, 0, TAU);
    ctx.fillStyle = "#f4f7fb";
    ctx.fill();
  }

  ctx.beginPath();
  ctx.moveTo(ex.cx - 6, ex.cy);
  ctx.lineTo(ex.cx + 6, ex.cy);
  ctx.moveTo(ex.cx, ex.cy - 6);
  ctx.lineTo(ex.cx, ex.cy + 6);
  ctx.strokeStyle = "rgba(255, 209, 102, 0.95)";
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
}

const GLSL_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec4 a_color;
layout(location = 2) in vec4 a_meta;

uniform vec4 u_data0;
uniform vec4 u_data1;

out vec4 v_color;
out vec4 v_meta;
out vec2 v_local;

void main() {
  vec2 p = a_pos;
  float kind = a_meta.z;
  if (kind > 0.5) {
    float breathe = 1.0 + 0.018 * sin(u_data0.x * 1.35);
    float ang = atan(p.y, p.x);
    float sway = 0.010 * sin(u_data0.x * 0.9 + ang * 2.0);
    p *= breathe;
    float c = cos(u_data0.y + sway);
    float s = sin(u_data0.y + sway);
    p = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
    p.x /= max(u_data1.z, 0.001);
  }
  gl_Position = vec4(p, 0.0, 1.0);
  v_color = a_color;
  v_meta = a_meta;
  v_local = a_pos;
}
`;

const GLSL_FS = `#version 300 es
precision highp float;
in vec4 v_color;
in vec4 v_meta;
in vec2 v_local;

uniform vec4 u_data0;
uniform vec4 u_data1;

out vec4 outColor;

void main() {
  float kind = v_meta.z;
  float t = clamp(v_meta.x, 0.0, 1.0);
  float ang = v_meta.y;

  if (kind < 0.5) {
    if (u_data1.w > 0.5) { outColor = vec4(1.0, 1.0, 1.0, 1.0); return; }
    float r = length(v_local);
    float w = smoothstep(0.2, 1.25, r);
    vec3 base = vec3(0.055, 0.065, 0.085) * (1.0 - w) + vec3(0.018, 0.022, 0.032) * w;
    vec2 g = abs(fract(v_local * 8.0) - vec2(0.5));
    float grid = 1.0 - smoothstep(0.0, 0.018, min(g.x, g.y));
    base += vec3(grid * 0.025);
    base += vec3(0.10, 0.045, 0.015) * exp(-3.0 * r * r);
    outColor = vec4(base, 1.0);
    return;
  }

  if (kind < 1.5) {
    float a = v_color.a * (1.0 - 0.35 * t) * smoothstep(0.0, 0.12, t);
    outColor = vec4(vec3(0.0), a);
    return;
  }

  if (kind < 2.5) {
    if (u_data1.y < 0.5) { outColor = vec4(0.0); return; }
    vec3 white = vec3(0.98, 0.965, 0.92) + vec3(0.04 * sin(ang * 5.0 + u_data0.x * 0.6));
    outColor = vec4(white, v_color.a);
    return;
  }

  if (kind < 3.5) {
    vec3 yellow = vec3(1.0, 0.90, 0.12);
    vec3 orange = vec3(1.0, 0.48, 0.03);
    vec3 red = vec3(0.95, 0.19, 0.015);
    float w1 = smoothstep(0.0, 0.58, t);
    float w2 = smoothstep(0.68, 1.0, t);
    vec3 col = yellow * (1.0 - w1) + orange * w1;
    col = col * (1.0 - w2) + red * w2;
    col += vec3(0.22, 0.16, 0.0) * exp(-14.0 * t * t);
    float sheen = pow(max(0.0, sin(ang * 2.5 + u_data0.x * 0.55)), 10.0);
    col += vec3(0.16, 0.10, 0.02) * sheen * (1.0 - t);
    col += vec3(0.18, 0.05, 0.0) * smoothstep(0.82, 1.0, t);
    float veins = 0.5 + 0.5 * sin(ang * 5.0 + t * 9.0);
    col *= 0.96 + 0.04 * veins;
    outColor = vec4(col, 1.0);
    return;
  }

  if (kind < 4.5) {
    if (u_data1.x < 0.5) { outColor = vec4(0.0); return; }
    outColor = vec4(vec3(0.99, 0.985, 0.95) - vec3(0.06 * t), v_color.a);
    return;
  }

  if (kind < 5.5) {
    if (u_data0.z < 0.5) { outColor = vec4(0.0); return; }
    outColor = vec4(v_color.rgb, v_color.a * u_data0.z);
    return;
  }

  if (u_data0.w < 0.5) { outColor = vec4(0.0); return; }
  outColor = vec4(v_color.rgb, v_color.a * u_data0.w);
}
`;

const WGSL = `
struct Uniforms {
  data0: vec4<f32>,
  data1: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSIn {
  @location(0) pos: vec2<f32>,
  @location(1) color: vec4<f32>,
  @location(2) info: vec4<f32>,
};

struct VSOut {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) info: vec4<f32>,
  @location(2) local: vec2<f32>,
};

@vertex
fn vs_main(input: VSIn) -> VSOut {
  var out: VSOut;
  var p = input.pos;
  let kind = input.info.z;
  if (kind > 0.5) {
    let breathe = 1.0 + 0.018 * sin(u.data0.x * 1.35);
    let ang = atan2(p.y, p.x);
    let sway = 0.010 * sin(u.data0.x * 0.9 + ang * 2.0);
    p = p * breathe;
    let c = cos(u.data0.y + sway);
    let s = sin(u.data0.y + sway);
    p = vec2<f32>(c * p.x - s * p.y, s * p.x + c * p.y);
    p.x = p.x / max(u.data1.z, 0.001);
  }
  out.position = vec4<f32>(p, 0.0, 1.0);
  out.color = input.color;
  out.info = input.info;
  out.local = input.pos;
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  let kind = in.info.z;
  let t = clamp(in.info.x, 0.0, 1.0);
  let ang = in.info.y;

  if (kind < 0.5) {
    if (u.data1.w > 0.5) { return vec4<f32>(1.0, 1.0, 1.0, 1.0); }
    let r = length(in.local);
    let w = smoothstep(0.2, 1.25, r);
    var base = vec3<f32>(0.055, 0.065, 0.085) * (1.0 - w) + vec3<f32>(0.018, 0.022, 0.032) * w;
    let g = abs(fract(in.local * 8.0) - vec2<f32>(0.5));
    let grid = 1.0 - smoothstep(0.0, 0.018, min(g.x, g.y));
    base = base + vec3<f32>(grid * 0.025);
    base = base + vec3<f32>(0.10, 0.045, 0.015) * exp(-3.0 * r * r);
    return vec4<f32>(base, 1.0);
  }

  if (kind < 1.5) {
    let a = in.color.a * (1.0 - 0.35 * t) * smoothstep(0.0, 0.12, t);
    return vec4<f32>(vec3<f32>(0.0), a);
  }

  if (kind < 2.5) {
    if (u.data1.y < 0.5) { return vec4<f32>(0.0); }
    let white = vec3<f32>(0.98, 0.965, 0.92) + vec3<f32>(0.04 * sin(ang * 5.0 + u.data0.x * 0.6));
    return vec4<f32>(white, in.color.a);
  }

  if (kind < 3.5) {
    let yellow = vec3<f32>(1.0, 0.90, 0.12);
    let orange = vec3<f32>(1.0, 0.48, 0.03);
    let red = vec3<f32>(0.95, 0.19, 0.015);
    let w1 = smoothstep(0.0, 0.58, t);
    let w2 = smoothstep(0.68, 1.0, t);
    var col = yellow * (1.0 - w1) + orange * w1;
    col = col * (1.0 - w2) + red * w2;
    col = col + vec3<f32>(0.22, 0.16, 0.0) * exp(-14.0 * t * t);
    let sheen = pow(max(0.0, sin(ang * 2.5 + u.data0.x * 0.55)), 10.0);
    col = col + vec3<f32>(0.16, 0.10, 0.02) * sheen * (1.0 - t);
    col = col + vec3<f32>(0.18, 0.05, 0.0) * smoothstep(0.82, 1.0, t);
    let veins = 0.5 + 0.5 * sin(ang * 5.0 + t * 9.0);
    col = col * (0.96 + 0.04 * veins);
    return vec4<f32>(col, 1.0);
  }

  if (kind < 4.5) {
    if (u.data1.x < 0.5) { return vec4<f32>(0.0); }
    return vec4<f32>(vec3<f32>(0.99, 0.985, 0.95) - vec3<f32>(0.06 * t), in.color.a);
  }

  if (kind < 5.5) {
    if (u.data0.z < 0.5) { return vec4<f32>(0.0); }
    return vec4<f32>(in.color.rgb, in.color.a * u.data0.z);
  }

  if (u.data0.w < 0.5) { return vec4<f32>(0.0); }
  return vec4<f32>(in.color.rgb, in.color.a * u.data0.w);
}
`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || "着色器编译失败");
  }
  return shader;
}

function createGlProgram(gl) {
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, GLSL_VS));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, GLSL_FS));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || "着色器链接失败");
  }
  return program;
}

function createGlVao(gl, data) {
  const vao = gl.createVertexArray();
  const buffer = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, VERTEX_STRIDE, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, VERTEX_STRIDE, 8);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 4, gl.FLOAT, false, VERTEX_STRIDE, 24);
  gl.bindVertexArray(null);
  return vao;
}

let lastUniforms = null;
let probeCaptureResolve = null;

function requestProbeCapture() {
  return new Promise((resolve) => { probeCaptureResolve = resolve; });
}
window.__FLOWER_PROBE__.capture = requestProbeCapture;

function fitToSquare(srcCanvas, size) {
  const out = document.createElement("canvas");
  out.width = size;
  out.height = size;
  const ctx = out.getContext("2d");
  ctx.fillStyle = BG_WHITE ? "#ffffff" : "#050609";
  ctx.fillRect(0, 0, size, size);
  const scale = Math.min(size / srcCanvas.width, size / srcCanvas.height);
  const w = srcCanvas.width * scale;
  const h = srcCanvas.height * scale;
  ctx.drawImage(srcCanvas, (size - w) / 2, (size - h) / 2, w, h);
  return out.toDataURL("image/png");
}

function pixelsToDataUrl(buf, w, h, flipY, bgra) {
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  const ctx = tmp.getContext("2d");
  const image = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const row = flipY ? h - 1 - y : y;
    for (let x = 0; x < w; x++) {
      const s = row * w * 4 + x * 4;
      const d = (y * w + x) * 4;
      image.data[d] = bgra ? buf[s + 2] : buf[s];
      image.data[d + 1] = buf[s + 1];
      image.data[d + 2] = bgra ? buf[s] : buf[s + 2];
      image.data[d + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return fitToSquare(tmp, 512);
}

function resizeCanvasToDisplaySize(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    return true;
  }
  return false;
}

function createWebGLRenderer(canvas) {
  const gl = canvas.getContext("webgl2", {
    antialias: true,
    alpha: false,
    depth: false,
    stencil: false,
    powerPreference: "high-performance"
  });
  if (!gl) throw new Error("WebGL2 上下文不可用");

  const program = createGlProgram(gl);
  const triVao = createGlVao(gl, geometry.triangleData);
  const lineVao = createGlVao(gl, geometry.lineData);
  const u0 = gl.getUniformLocation(program, "u_data0");
  const u1 = gl.getUniformLocation(program, "u_data1");

  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(BG_WHITE ? 1 : 0.02, BG_WHITE ? 1 : 0.025, BG_WHITE ? 1 : 0.035, 1);

  let frames = 0;
  let fpsLast = performance.now();

  return {
    api: "WebGL2",
    render(uniforms) {
      resizeCanvasToDisplaySize(canvas);
      gl.viewport(0, 0, canvas.width, canvas.height);
      const u = Float32Array.from(uniforms);
      u[6] = canvas.width / canvas.height;
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      gl.uniform4f(u0, u[0], u[1], u[2], u[3]);
      gl.uniform4f(u1, u[4], u[5], u[6], u[7]);
      gl.bindVertexArray(triVao);
      gl.drawArrays(gl.TRIANGLES, 0, geometry.triangleData.length / VERTEX_FLOATS);
      gl.bindVertexArray(lineVao);
      gl.drawArrays(gl.LINES, 0, geometry.lineData.length / VERTEX_FLOATS);
      gl.bindVertexArray(null);

      frames++;
      const now = performance.now();
      if (now - fpsLast >= 1000) {
        $("glFps").textContent = Math.round(frames * 1000 / (now - fpsLast));
        frames = 0;
        fpsLast = now;
      }
    },
    capture() {
      const w = canvas.width;
      const h = canvas.height;
      const buf = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return pixelsToDataUrl(buf, w, h, true, false);
    }
  };
}

async function createWebGPURenderer(canvas) {
  if (!navigator.gpu) throw new Error("当前浏览器未暴露 navigator.gpu");
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("未找到可用的 WebGPU 适配器");
  const device = await adapter.requestDevice();
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("无法创建 WebGPU 画布上下文");

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format,
    alphaMode: "opaque",
    usage: GPUTextureUsage.RENDER_ATTACHMENT
  });

  const module = device.createShaderModule({ code: WGSL });
  if (typeof module.getCompilationInfo === "function") {
    const info = await module.getCompilationInfo();
    const error = info.messages.find((m) => m.type === "error");
    if (error) throw new Error("WGSL 编译错误：" + error.message);
  }

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [{
      binding: 0,
      visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform" }
    }]
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
  const uniformBuffer = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });
  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }]
  });

  const vertexLayout = {
    arrayStride: VERTEX_STRIDE,
    stepMode: "vertex",
    attributes: [
      { shaderLocation: 0, offset: 0, format: "float32x2" },
      { shaderLocation: 1, offset: 8, format: "float32x4" },
      { shaderLocation: 2, offset: 24, format: "float32x4" }
    ]
  };

  const blend = {
    color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }
  };
  const sampleCount = 4;

  const makePipeline = (topology) => device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: { module, entryPoint: "vs_main", buffers: [vertexLayout] },
    fragment: { module, entryPoint: "fs_main", targets: [{ format, blend }] },
    primitive: { topology, cullMode: "none" },
    multisample: { count: sampleCount }
  });

  const trianglePipeline = makePipeline("triangle-list");
  const linePipeline = makePipeline("line-list");

  const triangleBuffer = device.createBuffer({
    size: geometry.triangleData.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
  });
  const lineBuffer = device.createBuffer({
    size: geometry.lineData.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
  });
  device.queue.writeBuffer(triangleBuffer, 0, geometry.triangleData);
  device.queue.writeBuffer(lineBuffer, 0, geometry.lineData);

  let msaaTexture = null;
  let lastW = 0, lastH = 0;
  let frames = 0;
  let fpsLast = performance.now();

  function ensureTargets() {
    resizeCanvasToDisplaySize(canvas);
    if (canvas.width === lastW && canvas.height === lastH && msaaTexture) return;
    if (msaaTexture) msaaTexture.destroy();
    lastW = canvas.width;
    lastH = canvas.height;
    msaaTexture = device.createTexture({
      size: [canvas.width, canvas.height],
      sampleCount,
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT
    });
  }

  function encodeScene(encoder, view, resolveView, u) {
    device.queue.writeBuffer(uniformBuffer, 0, u);
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view,
        resolveTarget: resolveView,
        clearValue: BG_WHITE
          ? { r: 1, g: 1, b: 1, a: 1 }
          : { r: 0.02, g: 0.025, b: 0.035, a: 1 },
        loadOp: "clear",
        storeOp: "store"
      }]
    });
    pass.setBindGroup(0, bindGroup);
    pass.setPipeline(trianglePipeline);
    pass.setVertexBuffer(0, triangleBuffer);
    pass.draw(geometry.triangleData.length / VERTEX_FLOATS);
    pass.setPipeline(linePipeline);
    pass.setVertexBuffer(0, lineBuffer);
    pass.draw(geometry.lineData.length / VERTEX_FLOATS);
    pass.end();
  }

  device.lost.then((info) => {
    showCanvasMessage(canvas, "WebGPU 设备已丢失：" + info.message);
    $("statWebgpuApi").textContent = "设备丢失";
  });

  return {
    api: "WebGPU",
    render(uniforms) {
      ensureTargets();
      const u = Float32Array.from(uniforms);
      u[6] = canvas.width / canvas.height;
      device.queue.writeBuffer(uniformBuffer, 0, u);

      const encoder = device.createCommandEncoder();
      encodeScene(encoder, msaaTexture.createView(), context.getCurrentTexture().createView(), u);
      device.queue.submit([encoder.finish()]);

      frames++;
      const now = performance.now();
      if (now - fpsLast >= 1000) {
        $("gpuFps").textContent = Math.round(frames * 1000 / (now - fpsLast));
        frames = 0;
        fpsLast = now;
      }
    },
    async capture() {
      ensureTargets();
      const w = canvas.width;
      const h = canvas.height;
      const u = Float32Array.from(lastUniforms || [0, 0, 0, 0, 1, 1, 1, 0]);
      u[6] = w / h;
      u[7] = BG_WHITE ? 1 : 0;
      const bytesPerRow = Math.ceil((w * 4) / 256) * 256;
      const readBuffer = device.createBuffer({
        size: bytesPerRow * h,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
      const colorTexture = device.createTexture({
        size: [w, h], format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
      });
      const msaaOffscreen = device.createTexture({
        size: [w, h], sampleCount, format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT
      });
      const encoder = device.createCommandEncoder();
      encodeScene(encoder, msaaOffscreen.createView(), colorTexture.createView(), u);
      encoder.copyTextureToBuffer(
        { texture: colorTexture },
        { buffer: readBuffer, bytesPerRow },
        [w, h, 1]
      );
      device.queue.submit([encoder.finish()]);
      await readBuffer.mapAsync(GPUMapMode.READ);
      const mapped = new Uint8Array(readBuffer.getMappedRange());
      const buf = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) {
        buf.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + w * 4), y * w * 4);
      }
      const dataUrl = pixelsToDataUrl(buf, w, h, false, format.startsWith("bgra"));
      readBuffer.unmap();
      readBuffer.destroy();
      colorTexture.destroy();
      msaaOffscreen.destroy();
      return dataUrl;
    }
  };
}

function showCanvasMessage(canvas, message) {
  const wrap = canvas.parentElement;
  let box = wrap.querySelector(".canvas-fallback");
  if (!box) {
    box = document.createElement("div");
    box.className = "canvas-fallback";
    wrap.appendChild(box);
  }
  box.hidden = false;
  box.textContent = message;
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

async function initRenderers() {
  renderers = [];
  const glCanvas = $("glCanvas");
  const gpuCanvas = $("gpuCanvas");

  if (ONLY !== "gpu") {
    try {
      const glRenderer = createWebGLRenderer(glCanvas);
      renderers.push(glRenderer);
      $("statWebglApi").textContent = "WebGL2 / GLSL ES 3.00";
    } catch (err) {
      $("statWebglApi").textContent = "不可用";
      $("glFps").textContent = "—";
      showCanvasMessage(glCanvas, "WebGL2 初始化失败：" + err.message);
    }
  }

  if (ONLY !== "gl") {
    try {
      const gpuPromise = createWebGPURenderer(gpuCanvas);
      const gpuRenderer = await (PROBE ? gpuPromise : withTimeout(gpuPromise, 6000, "WebGPU 初始化超时"));
      renderers.push(gpuRenderer);
      $("statWebgpuApi").textContent = "WebGPU / WGSL";
      $("statusLine").textContent = "已就绪：WebGL2 与 WebGPU 双管线实时运行中";
    } catch (err) {
      $("statWebgpuApi").textContent = "不可用";
      $("gpuFps").textContent = "—";
      const secureHint = window.isSecureContext ? "" : " 当前页面不是安全上下文，请通过 localhost 或 HTTPS 打开。";
      $("gpuFallback").hidden = false;
      $("gpuFallback").textContent = "WebGPU 管线未启动：" + err.message + secureHint + " WebGL2 管线仍可独立运行。";
      $("statusLine").textContent = "已就绪：WebGL2 运行中；WebGPU 未启用";
    }
  }
}

function frame(now) {
  const dt = Math.min((now - lastNow) / 1000, 0.05);
  lastNow = now;
  if (state.playing) simTime += dt;

  const uniforms = new Float32Array([
    simTime,
    simTime * 0.12 * state.speed,
    state.showMesh ? 1 : 0,
    state.showPoints ? 1 : 0,
    state.showDetails ? 1 : 0,
    state.showOutline ? 1 : 0,
    1,
    BG_WHITE ? 1 : 0
  ]);

  lastUniforms = uniforms;
  for (const renderer of renderers) {
    try {
      renderer.render(uniforms);
    } catch (err) {
      renderer.failed = true;
    }
  }
  renderers = renderers.filter((r) => !r.failed);

  if (probeCaptureResolve) {
    const resolve = probeCaptureResolve;
    probeCaptureResolve = null;
    const pending = {};
    for (const renderer of renderers) {
      try {
        pending[renderer.api] = renderer.capture();
      } catch (err) {
        pending[renderer.api] = { error: err.message };
      }
    }
    Promise.all(Object.entries(pending).map(async ([api, value]) => {
      try { return [api, await value]; } catch (err) { return [api, { error: err.message }]; }
    })).then((pairs) => resolve(Object.fromEntries(pairs)));
  }
  requestAnimationFrame(frame);
}
