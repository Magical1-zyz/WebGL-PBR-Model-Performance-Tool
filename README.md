# WebGL PBR Model Performance Tool

![License](https://img.shields.io/badge/license-MIT-blue.svg) ![Three.js](https://img.shields.io/badge/Three.js-r160-black) ![Status](https://img.shields.io/badge/Status-Active-green)

这是一个基于 **Three.js** 和原生 ES Modules 构建的高性能 WebGL 3D 渲染器与性能测试工具。

该项目专为评估 PBR 模型在 Web 环境下的渲染性能而设计，特别集成了 **QEM (Quadric Error Metrics)** 网格简化算法，支持在浏览器端实时进行模型减面并监测性能指标。本项目旨在辅助硕士论文的实验验证，特别是针对材质烘焙（Baking）前后的性能开销对比。

## ✨ 核心功能

### 1. 深度性能分析 (Performance Metrics)
* **实时仪表盘**：左侧面板实时显示 FPS、帧生成时间 (Frame Time)、加载耗时、预估显存占用 (VRAM)。
* **渲染指令统计**：精确记录 Draw Calls 和三角形总数 (Triangles)，辅助分析渲染瓶颈。
* **可视化趋势图**：底部集成 FPS、FrameTime、DrawCalls 的**实时折线图 (Sparklines)**，直观记录操作过程中的性能波动。

### 2. 实时 QEM 网格简化
* **浏览器端计算**：内置 `SimplifyModifier`，无需依赖后端即可对 GLTF 模型进行几何简化。
* **动态交互**：提供 0% (原始) 到 98% (极简) 的连续滑动控制，支持“所见即所得”的减面效果观察。
* **非线性评估**：用于测试不同 LOD (Level of Detail) 级别下的帧率响应。

### 3. 专业 PBR 渲染管线
* **基于物理的渲染 (PBR)**：支持 Standard Material，真实还原材质质感。
* **基于图像的照明 (IBL)**：支持加载 `.hdr` (Radiance RGBE) 环境贴图，提供逼真的光照反射。
* **渲染设置**：集成 ACES Filmic 色调映射、动态曝光控制、背景模糊度调节及自动旋转展示。

### 4. 强大的模型加载器
* **文件夹加载模式 (推荐)**：解决土木工程模型常见的 `.gltf` + `.bin` + `textures/` 多文件依赖问题，支持一键加载整个文件夹。
* **智能自动对齐**：针对 GIS 坐标系下模型“尺寸巨大”或“原点偏移”的问题，内置自动归心与相机聚焦算法 (Auto-Centering & Framing)，确保模型加载即居中。

## 🛠️ 技术栈

* **Core Engine**: [Three.js (r160)](https://threejs.org/)
* **UI Framework**: HTML5 / CSS3 (Custom Dark Geek Style) / Lil-GUI
* **Formats**: GLTF / GLB / HDR
* **Build System**: No-Build (Native ES Modules via Import Maps)

## 🚀 快速开始

由于项目使用了 ES Modules 和本地文件系统 API，**不能直接双击 `index.html` 打开**，必须运行在本地服务器上。

### 方法 A：使用 VS Code (推荐)
1.  安装 VS Code 插件：**Live Server**。
2.  右键点击项目根目录的 `index.html`。
3.  选择 **"Open with Live Server"**。

### 方法 B：使用 Python
如果你安装了 Python 3.x，在项目根目录下打开终端运行：
```bash
python -m http.server 8000
然后访问 http://localhost:8000。
```

###方法 C：使用 Node.js
```Bash
npx http-server .
```
## 📖 操作指南
### 1. 加载模型
- 点击右侧面板的 "Select Folder"，选择包含 .gltf 文件的整个目录。
  - 或者使用 "Select Files" 选择单体 .glb 文件。
  - 工具会自动计算包围盒并将相机聚焦到模型中心。
### 2.设置环境 (IBL)
- 点击 "Select HDR" 加载 .hdr 环境贴图。
- 调整 Render Settings 中的 Exposure (曝光) 和 BG Blur (背景模糊) 以获得最佳观测效果。

### 3.执行简化 (QEM)

- 拖动 "3. Simplification" 下的滑块。

- 滑块在最左侧 (0%)：显示原始模型。

- 向右滑动：逐步执行减面操作（Reduce Ratio 增大）。

- 观察底部红色的 Triangles 图表呈阶梯状下降，同时观察 FPS 的变化。

### 4. 故障排查
如果画面全黑，点击 "Generate Test Cube"。如果出现橙色方块，说明 WebGL 环境正常，可能是模型本身数据问题（如材质丢失或坐标过远）。

## 📂 目录结构
```Plaintext

webgl-pbr-model-perf-tool/
│
├── index.html          # 入口文件 (包含 UI 结构、Import Maps 和 Canvas)
│
├── src/
│   ├── main.js         # 核心逻辑
│   │                   # - Three.js 场景初始化
│   │                   # - QEM 简化算法实现
│   │                   # - PerfChart 图表类
│   │                   # - 文件加载与相机控制
│   │
│   └── style.css       # 样式文件
│                       # - 暗黑极客风格 (Dark Geek Style)
│                       # - 响应式布局
│                       # - 自定义 Range Slider 样式
│
└── README.md           # 项目说明文档
```
## 📸 项目展示 (Project Showcase)
以下截图展示了本工具在实际模型测试中的效果。
![alt text](image.png)

Created for Master's Thesis Research. 2025.