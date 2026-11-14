# 花朵矢量化：AI 生成视频 vs WebGL 2 / WebGPU 渲染

以 `assets/flower-source.jpg`（1280×1280）为唯一输入，在浏览器内完成颜色分割、径向轮廓提取、RDP 简化与 Catmull-Rom 细分，输出 `flower.svg` 和三角化几何；再由 **WebGL 2** 与 **WebGPU** 两条独立管线渲染同一份顶点数据。同时用图生视频模型生成约 5 秒短片，作为「生成式栅格结果」的对照组。

## 打开方式

- **双击 `index.html` 即可**。样式、脚本、原图（data URI）和验证探针全部内联，不需要服务器、不需要联网、不需要安装任何依赖。实测 `file://` 下 WebGL 2 与 WebGPU 均可启动。
- 若浏览器禁用了 WebGPU，可在本目录执行 `python -m http.server 8000`，再打开 `http://127.0.0.1:8000/index.html`；WebGPU 不可用时左侧 WebGL 2 仍独立运行，右侧显示原因。
- 页面可暂停动画、调整旋转速度，切换白描边 / 花蕊 / 矢量网格 / 控制点，并下载 SVG 与矢量 JSON。
- 可选 URL 参数（默认不生效）：`?bg=white` 白底渲染、`?only=gl` / `?only=gpu` 只启动一条管线、`?probe` 打开验证探针。

## 文件

- `index.html`：自包含对比页（约 360 KB），含实验对象、矢量化管线、双 GPU 画布、实时统计和结论对比表。
- `flower.svg`：矢量结果，白底；三次贝塞尔轮廓路径 + 径向渐变 + 白描边 + 花瓣缝隙 + 花蕊 + 投影。
- `flower_geometry.json`：页面运行时导出的完整几何快照，含轮廓元数据与三角化顶点缓冲（Float32Array 的 base64），与 `index.html` 渲染所用的顶点完全一致。页面「下载 JSON」按钮导出的是其中的轮廓矢量数据（约 33 KB），即描述形状所需的可编辑部分。
- `compare.png`：原图、SVG、WebGL 2、WebGPU 四联对比，底部附量化指标。
- `verify/`：无头 Chrome 导出的渲染像素、白/深底页面截图、`metrics.txt` 与 `probe-status.json`。
- `tools/`：可复现的生成与验证脚本，顺序为 `build.py` → `verify.py`。
- `assets/`：输入原图 `flower-source.jpg` 与 AI 生成短片 `ai-flower.mp4`（5.2 s，约 688 KB）。

## 实现

1. **矢量化**（`tools/app.js`，浏览器 Canvas 2D，无第三方库）
   - 320×320 像素采样；颜色分割条件 `S > 0.18`、`R−B > 42`、`R > 145`，再做形态学闭运算。
   - 花朵对花心近似为星形域，因此沿 240 个径向角度寻找最外侧花色像素得到半径序列，经中值滤波与圆周平滑去噪。
   - RDP 自适应简化保留瓣尖与凹口，得到 **84 个控制点**；Catmull-Rom 细分为 **420 个轮廓点**。
   - 自动检测 5 处花瓣凹口，并把三根花蕊重建为矢量线段 + 圆头。
   - 控制点转成闭合三次贝塞尔路径，生成 `flower.svg`；橙黄渐变、白描边和投影作为独立矢量图层。
2. **GPU 几何**：以轮廓点构建径向扇形网格（7 层环）、白描边环、投影、花瓣缝隙、花蕊与控制点图元，共 **6,582 个三角形**；另有网格 / 控制点线表。每个顶点 10 个 float（位置 2、颜色 4、参数 4）。
3. **双管线**：同一 `Float32Array` 分别上传。
   - WebGL 2 / GLSL ES 3.00：VAO + `drawArrays`，SRC-ALPHA 混合。
   - WebGPU / WGSL：显式 bind group layout、uniform buffer、4× MSAA 多重采样与 resolve target。
   - 渐变、光晕、白描边、呼吸与摆动动画全部在着色器中计算；两条管线使用完全相同的 uniform 参数。
4. **AI 对照组**：原图作为首帧生成 5.2 秒 MP4，保留玻璃质感与高光；但结果不可编辑几何、分辨率固定、逐帧不确定。
5. **降级**：WebGPU 初始化有 6 秒超时回退；`navigator.gpu` 缺失或适配器不可用时，页面给出说明且 WebGL 2 照常渲染。

## 验证（无头 Chrome / SwiftShader，CDP 真实等待）

指标由 `tools/probe.js` 在页面内用 Canvas 2D 计算：以 512×512 白底原图为参照，PSNR、8×8 分块 SSIM、轮廓 IoU 与交集区域平均 ΔE76。

| 渲染 | PSNR | SSIM | 轮廓 IoU | 平均 ΔE |
|---|---|---|---|---|
| `flower.svg`（Chrome） | 11.59 dB | 0.672 | 0.499 | 13.4 |
| WebGL 2（SwiftShader） | 13.94 dB | 0.693 | 0.748 | 25.1 |
| WebGPU（SwiftShader） | 13.94 dB | 0.693 | 0.748 | 25.1 |

WebGL 2 与 WebGPU 输出的平均像素差为 **0.20/255**，差值 >30 的像素占 0.18%，说明两条管线渲染的是同一份几何。

- `tools/shot.mjs` 用 Node 22 内置的 CDP/WebSocket 真实等待探针完成，避免虚拟时间快进打断 WebGPU 初始化；不依赖 puppeteer。
- WebGL 用 `readPixels` 读回，WebGPU 用离屏纹理 + `copyTextureToBuffer` 读回（而非截取画布），因此两者都是真实的渲染像素。
- 白底与深底各跑一次，结果在 `verify/`；`probe-status.json` 记录两条管线的 API 状态与读回是否成功。

## 复现

```bash
python tools/build.py     # 生成自包含 index.html
python tools/verify.py    # 导出 flower.svg / flower_geometry.json / compare.png / verify/
```

`verify.py` 需要 Node 22 与 Chrome / Edge，不需要 numpy、OpenCV 或其他 Python 包。

## 局限

- 径向轮廓法保留的是「形状与配色逻辑」，没有逐像素复刻原图的玻璃质感、柔和阴影、白描边粗细变化和花瓣内部明暗，因此 PSNR 约 14 dB，低于多色区域追踪式的矢量化。
- 白描边、花瓣缝隙、花蕊按语义重建，不是从原图追踪得到的精确区域。
- 无头环境使用 SwiftShader 软件渲染，页面上的 FPS 只作参考；真实 GPU 上的性能与画面应在有显卡的 Chrome / Edge 中确认。
- AI 短片是生成式栅格结果，含随机性，几何不可编辑，也不能像矢量结果那样任意缩放与参数化。
