import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { SimplifyModifier } from 'three/addons/modifiers/SimplifyModifier.js';
import GUI from 'three/addons/libs/lil-gui.module.min.js';

// === 1. 图表类 (已优化纵轴标签) ===
class PerfChart {
    constructor(name, color, suffix = '', precision = 0) {
        this.name = name;
        this.color = color;
        this.suffix = suffix;
        this.precision = precision;
        this.data = new Array(60).fill(0);

        let panel = document.getElementById('charts-panel');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'charts-panel';
            document.body.appendChild(panel);
        }

        this.dom = document.createElement('div');
        this.dom.className = 'chart-container';
        this.dom.innerHTML = `
            <div class="chart-title" style="color:${color}">${name}</div>
            <div class="chart-value">${(0).toFixed(precision)}${suffix}</div>
            <canvas class="chart-canvas" width="360" height="150"></canvas> 
        `;
        panel.appendChild(this.dom);

        this.valueDom = this.dom.querySelector('.chart-value');
        this.canvas = this.dom.querySelector('canvas');
        this.ctx = this.canvas.getContext('2d');
    }

    update(val) {
        this.data.shift();
        this.data.push(val);
        this.valueDom.innerText = val.toFixed(this.precision) + this.suffix;

        let min = Math.min(...this.data);
        let max = Math.max(...this.data);
        if (max === min) max = min + 0.001; // 防止除以零
        const range = max - min;

        const ctx = this.ctx;
        const w = this.canvas.width;
        const h = this.canvas.height;

        // 布局配置
        const paddingToTop = 15;    // 顶部留白
        const paddingToBottom = 10; //HK 底部留白
        const chartHeight = h - paddingToTop - paddingToBottom;
        const leftMargin = 45;      // 左侧留给文字的宽度
        const graphWidth = w - leftMargin;

        ctx.clearRect(0, 0, w, h);

        // --- 1. 绘制纵轴网格和标签 ---
        const steps = 4; // 将图表分为4个区间（5条线）
        ctx.font = '10px Consolas, monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';

        for (let i = 0; i <= steps; i++) {
            // 计算当前刻度的归一化位置 (0.0 ~ 1.0)
            const t = i / steps;

            // 计算对应的数值
            const value = min + (range * t);

            // 计算Y轴像素位置 (Canvas Y轴向下，所以要反转)
            const y = (h - paddingToBottom) - (t * chartHeight);

            // 绘制网格线 (深灰色)
            ctx.beginPath();
            ctx.strokeStyle = '#2a2a2a';
            ctx.lineWidth = 1;
            ctx.moveTo(leftMargin, y);
            ctx.lineTo(w, y);
            ctx.stroke();

            // 绘制文字标签
            ctx.fillStyle = '#666';
            ctx.fillText(value.toFixed(this.precision), leftMargin - 6, y);
        }

        // --- 2. 绘制折线图 ---
        ctx.beginPath();
        ctx.strokeStyle = this.color;
        ctx.lineWidth = 2;

        for (let i = 0; i < this.data.length; i++) {
            // X坐标：映射到 [leftMargin, w]
            const x = leftMargin + (i / (this.data.length - 1)) * graphWidth;

            // Y坐标：映射到 [padding, h-padding]
            const normalized = (this.data[i] - min) / range;
            const y = (h - paddingToBottom) - (normalized * chartHeight);

            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // --- 3. 填充下方区域 ---
        ctx.lineTo(w, h - paddingToBottom);
        ctx.lineTo(leftMargin, h - paddingToBottom);
        ctx.fillStyle = this.hexToRgba(this.color, 0.1);
        ctx.fill();

        // (可选) 绘制当前值的指示点
        // const lastX = w;
        // const lastNormalized = (this.data[this.data.length-1] - min) / range;
        // const lastY = (h - paddingToBottom) - (lastNormalized * chartHeight);
        // ctx.beginPath();
        // ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
        // ctx.fillStyle = '#fff';
        // ctx.fill();
    }

    hexToRgba(hex, alpha) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
}

// === GPU 计时器 ===
class GPUTimer {
    constructor(renderer) {
        this.renderer = renderer;
        this.gl = renderer.getContext();
        this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
        this.queries = [];
        this.available = !!this.ext;
        if (!this.available) console.warn("GPU Timer N/A");
    }

    start() {
        if (!this.available) return;
        const query = this.gl.createQuery();
        this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
        this.queries.push(query);
    }

    end() {
        if (!this.available) return;
        this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    }

    poll() {
        if (!this.available || this.queries.length === 0) return null;
        const query = this.queries[0];
        const available = this.gl.getQueryParameter(query, this.gl.QUERY_RESULT_AVAILABLE);

        if (available && !this.gl.getParameter(this.ext.GPU_DISJOINT_EXT)) {
            const timeNs = this.gl.getQueryParameter(query, this.gl.QUERY_RESULT);
            this.gl.deleteQuery(query);
            this.queries.shift();
            return timeNs / 1000000;
        } else if (available) {
            this.gl.deleteQuery(query);
            this.queries.shift();
            return null;
        }
        return null;
    }
}

// === 2. 全局变量 ===
let camera, scene, renderer, controls, transformControl;
let raycaster; // 射线投射器
let pointer = new THREE.Vector2(); // 鼠标位置
let mainGroup;
let loadedModels = [];
let originalMeshes = [];
let charts = {};
let lastTime = performance.now();
let frameCount = 0;
let isLoopRunning = false;
let selectedModelIndex = -1;
let gpuTimer;
let selectedModelRadius = 1.0; // 当前选中模型的半径，用于计算 Gizmo 大小
let isAltDown = false; // Alt 键状态

const params = {
    unlockFPS: false,
    frustumCulling: false,
    doubleSided: true,
    exposure: 1.0,
    blur: 0.0,
    rotation: 0,
    resetCam: () => {
        controls.reset();
        if (mainGroup) fitCameraToSelection(mainGroup);
    }
};

// === 3. 主逻辑 ===
function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a1a);

    mainGroup = new THREE.Group();
    scene.add(mainGroup);

    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 10000);
    camera.position.set(4, 3, 4);

    renderer = new THREE.WebGLRenderer({
        canvas: document.getElementById('webgl-canvas'),
        antialias: true,
        alpha: false,
        powerPreference: "high-performance"
    });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    gpuTimer = new GPUTimer(renderer);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    // Raycaster
    raycaster = new THREE.Raycaster();

    // Gizmo
    transformControl = new TransformControls(camera, renderer.domElement);
    // 初始大小设为 0.4，但在 animate 中会动态覆盖
    transformControl.setSize(0.4);
    transformControl.addEventListener('dragging-changed', function (event) {
        controls.enabled = !event.value;

        // 当开始拖动 (event.value === true) 且 Alt 键按下时
        if (event.value && isAltDown && selectedModelIndex !== -1) {
            duplicateSelectedModel();
        }
    });
    transformControl.addEventListener('change', function () {
        if (selectedModelIndex !== -1 && loadedModels[selectedModelIndex]) {
            updateTransformUI(loadedModels[selectedModelIndex].object);
        }
    });
    scene.add(transformControl);

    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambient);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1);
    dirLight.position.set(5, 10, 7);
    dirLight.castShadow = true;
    scene.add(dirLight);

    // 事件监听
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('pointerdown', onPointerDown); // 鼠标点击选择

    initGUI();
    initFileHandlers();

    try {
        charts = {
            fps: new PerfChart('FPS', '#00ff9d', '', 0),
            ms: new PerfChart('Frame Time', '#00ccff', ' ms', 2),
            cpu: new PerfChart('CPU Time', '#ffa500', ' ms', 3),
            gpu: new PerfChart('GPU Time', '#d600ff', ' ms', 3),
            calls: new PerfChart('Draw Calls', '#ffcc00', '', 0),
            tris: new PerfChart('Triangles', '#ff5555', '', 0)
        };
    } catch (e) { console.error(e); }

    const debugBtn = document.getElementById('btn-debug');
    if (debugBtn) debugBtn.addEventListener('click', generateTestCube);

    window.addEventListener('resize', onWindowResize);
    log("System Initializing... Ready.");

    updateModelSelectUI();
}

function onKeyUp(event) {
    if (event.key === 'Alt') isAltDown = false;
}

function onKeyDown(event) {
    if (event.key === 'Delete' || event.key === 'Backspace') {
        if (document.activeElement.tagName !== 'INPUT') {
            deleteSelectedModel();
        }
    }
}

function onPointerDown(event) {
    // 只有当点击不在 UI 面板上时才进行选择检测
    if (event.target.closest('#gui-container') || event.target.closest('#stats-panel')) return;

    pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
    pointer.y = - (event.clientY / window.innerHeight) * 2 + 1;

    raycaster.setFromCamera(pointer, camera);

    // 检测与 mainGroup 的子对象的交叉
    const intersects = raycaster.intersectObjects(mainGroup.children, true);

    if (intersects.length > 0) {
        // 找到最近的交叉物体
        let hitObj = intersects[0].object;

        // 向上遍历直到找到属于 loadedModels 的根对象
        let rootModel = null;
        let rootIndex = -1;

        // 暴力匹配：看这个 mesh 属于哪个 loadedModel
        for (let i = 0; i < loadedModels.length; i++) {
            let modelRoot = loadedModels[i].object;
            let found = false;
            // 检查 hitObj 是否是 modelRoot 或其子节点
            if (hitObj === modelRoot) found = true;
            else {
                hitObj.traverseAncestors((ancestor) => {
                    if (ancestor === modelRoot) found = true;
                });
            }

            if (found) {
                rootModel = modelRoot;
                rootIndex = i;
                break;
            }
        }

        if (rootIndex !== -1 && rootIndex !== selectedModelIndex) {
            selectModelByIndex(rootIndex);
            log(`Selected: ${loadedModels[rootIndex].name}`);
        }
    }
}

// 复制模型
function duplicateSelectedModel() {
    const originalEntry = loadedModels[selectedModelIndex];
    if (!originalEntry) return;

    const originalObj = originalEntry.object;

    // 1. 克隆对象 (Clone)
    // Three.js 的 clone() 默认是浅拷贝几何体(shared geometry)
    const cloneObj = originalObj.clone();

    // 2. 保持克隆体在原地 (模拟 UE：留下一份在原地，当前拖拽的是“新”的，
    //    但逻辑上我们让克隆体留在原地作为“旧”的，拖拽体作为“新”的更容易实现)
    //    或者：让克隆体留在原地，拖拽体继续被拖拽。
    //    在这里我们采用：生成一个克隆体，放在 originalObj 当前的位置，然后添加到场景中。
    //    originalObj 已经被 TransformControls 绑定并跟随鼠标移动。

    // 注意：cloneObj 的 position/rotation/scale 已经从 originalObj 复制过来了
    mainGroup.add(cloneObj);

    // 3. 生成唯一名称
    const newName = getUniqueName(originalEntry.name);

    // 4. 注册到 loadedModels
    // 我们把留在原地的 cloneObj 注册为“新模型”，而 originalObj 继续作为当前选中的模型被拖走
    // 这样用户感觉像是“拖出来了一个副本”
    const newEntry = {
        name: newName,
        object: cloneObj
    };
    loadedModels.push(newEntry);

    // 5. 关键：同步 originalMeshes 以支持简化
    // 因为 cloneObj 共享了 originalObj 的几何体（可能是已经简化的），
    // 我们需要确保 cloneObj 的 mesh 也能找到其对应的“原始高模几何体”。
    // 方法：遍历 cloneObj 和 originalObj，建立映射。

    const originalMeshesMap = new Map(); // mesh.uuid -> geometry
    originalMeshes.forEach(item => {
        originalMeshesMap.set(item.mesh.uuid, item.geometry);
    });

    // 辅助函数：同步层级遍历
    function traverseTwo(rootA, rootB, callback) {
        callback(rootA, rootB);
        const childrenA = rootA.children;
        const childrenB = rootB.children;
        if (childrenA.length === childrenB.length) {
            for (let i = 0; i < childrenA.length; i++) {
                traverseTwo(childrenA[i], childrenB[i], callback);
            }
        }
    }

    traverseTwo(originalObj, cloneObj, (nodeA, nodeB) => {
        if (nodeA.isMesh && nodeB.isMesh) {
            // 如果 A 有原始几何体记录，则 B 也应该指向同一个原始几何体
            if (originalMeshesMap.has(nodeA.uuid)) {
                const originalGeo = originalMeshesMap.get(nodeA.uuid);
                originalMeshes.push({
                    mesh: nodeB,
                    geometry: originalGeo // 共享原始几何体引用
                });

                // 确保 B 开启了阴影和视锥剔除设置
                nodeB.castShadow = true;
                nodeB.receiveShadow = true;
                nodeB.frustumCulled = params.frustumCulling;
                if (nodeB.material) {
                    nodeB.material.side = params.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
                }
            }
        }
    });

    updateModelSelectUI();
    updateVRAMEst();
    log(`Duplicated: ${originalEntry.name} -> ${newName}`);
}

// 辅助：生成唯一名称
function getUniqueName(baseName) {
    let name = baseName;
    // 如果 baseName 已经是 xxx_1 格式，尝试提取前缀
    // 简单的正则匹配 _数字 结尾
    const match = baseName.match(/^(.*)_(\d+)(\.[^.]*)?$/);
    let prefix = baseName;
    let suffix = "";
    let ext = "";

    if (match) {
        prefix = match[1];
        // 我们不直接用原来的数字，而是重新计算
        if (match[3]) ext = match[3];
    } else {
        // 分离扩展名
        const dotIndex = baseName.lastIndexOf('.');
        if (dotIndex !== -1) {
            prefix = baseName.substring(0, dotIndex);
            ext = baseName.substring(dotIndex);
        }
    }

    let counter = 1;
    let uniqueName = `${prefix}_${counter}${ext}`;

    const isTaken = (n) => loadedModels.some(m => m.name === n);

    while (isTaken(uniqueName)) {
        counter++;
        uniqueName = `${prefix}_${counter}${ext}`;
    }
    return uniqueName;
}

function deleteSelectedModel() {
    if (selectedModelIndex === -1 || !loadedModels[selectedModelIndex]) return;

    const modelToRemove = loadedModels[selectedModelIndex].object;
    const modelName = loadedModels[selectedModelIndex].name;

    mainGroup.remove(modelToRemove);
    transformControl.detach();

    const meshesToRemove = new Set();
    modelToRemove.traverse(child => {
        if (child.isMesh) meshesToRemove.add(child);
    });
    originalMeshes = originalMeshes.filter(item => !meshesToRemove.has(item.mesh));

    modelToRemove.traverse(child => {
        if (child.isMesh) {
            if (child.geometry) child.geometry.dispose();
            if (child.material) {
                if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
                else child.material.dispose();
            }
        }
    });

    loadedModels.splice(selectedModelIndex, 1);
    selectedModelIndex = -1;
    selectedModelRadius = 1.0; // 重置
    updateModelSelectUI();
    updateVRAMEst();

    log(`Deleted Model: ${modelName}`);
}

function initGUI() {
    const modelSelect = document.getElementById('model-select');
    const tfPanel = document.getElementById('transform-panel');

    if (modelSelect) {
        modelSelect.addEventListener('change', (e) => {
            const index = parseInt(e.target.value);
            // 切换选中
            selectModelByIndex(index);
        });
    }

    const modes = document.getElementsByName('tf-mode');
    modes.forEach(btn => {
        btn.addEventListener('change', (e) => {
            if (transformControl) transformControl.setMode(e.target.value);
        });
    });

    // 新增：简化范围监听
    const scopeRadios = document.getElementsByName('simp-scope');
    scopeRadios.forEach(r => {
        r.addEventListener('change', () => {
            // 切换范围时，重新应用当前的滑块值
            const val = parseInt(document.getElementById('simp-slider').value);
            applySimplification(val / 100);
        });
    });

    const tfInputs = document.querySelectorAll('.tf-field input');
    tfInputs.forEach(input => {
        input.addEventListener('input', () => {
            if (selectedModelIndex !== -1) {
                updateModelFromUI(loadedModels[selectedModelIndex].object);
            }
        });
    });

    const slider = document.getElementById('simp-slider');
    const sliderVal = document.getElementById('simp-val');
    if (slider) {
        slider.value = 0;
        sliderVal.innerText = "0% (Original)";
        slider.addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            if (val === 0) sliderVal.innerText = "0% (Original)";
            else sliderVal.innerText = val + "% (Reduced)";
            applySimplification(val / 100);
        });
    }

    const gui = new GUI({ container: document.getElementById('lil-gui-mount'), width: '100%' });

    gui.add(params, 'unlockFPS').name('Unlock FPS Limit')
        .onChange(v => log(v ? "FPS Unlocked" : "FPS Locked"));

    gui.add(params, 'frustumCulling').name('Frustum Culling').onChange(updateCullingSettings);
    gui.add(params, 'doubleSided').name('Double Sided').onChange(updateMaterialSide);
    gui.add(params, 'exposure', 0.1, 5.0).name('Exposure').onChange(v => renderer.toneMappingExposure = v);
    gui.add(params, 'blur', 0, 1).name('BG Blur').onChange(v => scene.backgroundBlurriness = v);
    gui.add(params, 'rotation', 0, 360).name('Auto Rotation').onChange(v => {
        if (mainGroup) mainGroup.rotation.y = THREE.MathUtils.degToRad(v);
    });
    gui.add(params, 'resetCam').name('Reset Camera');
}

// 辅助函数：根据索引选中模型，并计算其半径
function selectModelByIndex(index) {
    selectedModelIndex = index;
    const tfPanel = document.getElementById('transform-panel');
    const select = document.getElementById('model-select');

    // 同步 UI 下拉框
    if (select) select.value = index;


    if (index === -1 || !loadedModels[index]) {
        transformControl.detach();
        if (tfPanel) tfPanel.style.display = 'none';
        selectedModelRadius = 1.0;
    } else {
        const model = loadedModels[index].object;
        transformControl.attach(model);
        if (tfPanel) tfPanel.style.display = 'block';
        updateTransformUI(model);

        // 计算包围盒半径，用于动态调整 Gizmo 大小
        const box = new THREE.Box3().setFromObject(model);
        const size = new THREE.Vector3();
        box.getSize(size);
        // 取最大边的一半作为参考半径
        selectedModelRadius = Math.max(size.x, size.y, size.z) * 0.5;
        // 防止太小
        if (selectedModelRadius < 0.1) selectedModelRadius = 0.1;
    }
}

function updateVRAMEst() {
    let bytes = 0;
    let geoCount = 0;
    let texCount = 0;
    const geometries = new Set();
    const textures = new Set();

    mainGroup.traverse(c => {
        if (c.isMesh) {
            if (c.geometry) geometries.add(c.geometry);
            if (c.material) {
                const mats = Array.isArray(c.material) ? c.material : [c.material];
                mats.forEach(m => {
                    for (const key in m) {
                        if (m[key] && m[key].isTexture) textures.add(m[key]);
                    }
                });
            }
        }
    });

    geometries.forEach(g => {
        geoCount++;
        for (const name in g.attributes) bytes += g.attributes[name].array.byteLength;
        if (g.index) bytes += g.index.array.byteLength;
    });

    textures.forEach(t => {
        texCount++;
        if (t.image) {
            const w = t.image.width || 1024;
            const h = t.image.height || 1024;
            bytes += w * h * 4 * 1.33;
        }
    });

    const mb = (bytes / 1024 / 1024).toFixed(2);
    document.getElementById('val-vram').innerText = `${mb} MB (${geoCount} Geo, ${texCount} Tex)`;
}

function updateMaterialSide(isDouble) {
    if (!mainGroup) return;
    let count = 0;
    mainGroup.traverse((child) => {
        if (child.isMesh && child.material) {
            child.material.side = isDouble ? THREE.DoubleSide : THREE.FrontSide;
            child.material.needsUpdate = true;
            count++;
        }
    });
    log(`Materials Updated: ${isDouble ? "Double Sided" : "Front Side Only"} (${count} meshes)`);
}

function updateTransformUI(model) {
    document.getElementById('pos-x').value = parseFloat(model.position.x.toFixed(2));
    document.getElementById('pos-y').value = parseFloat(model.position.y.toFixed(2));
    document.getElementById('pos-z').value = parseFloat(model.position.z.toFixed(2));

    document.getElementById('rot-x').value = parseFloat(THREE.MathUtils.radToDeg(model.rotation.x).toFixed(1));
    document.getElementById('rot-y').value = parseFloat(THREE.MathUtils.radToDeg(model.rotation.y).toFixed(1));
    document.getElementById('rot-z').value = parseFloat(THREE.MathUtils.radToDeg(model.rotation.z).toFixed(1));

    document.getElementById('scl-x').value = parseFloat(model.scale.x.toFixed(2));
    document.getElementById('scl-y').value = parseFloat(model.scale.y.toFixed(2));
    document.getElementById('scl-z').value = parseFloat(model.scale.z.toFixed(2));
}

function updateModelFromUI(model) {
    const px = parseFloat(document.getElementById('pos-x').value) || 0;
    const py = parseFloat(document.getElementById('pos-y').value) || 0;
    const pz = parseFloat(document.getElementById('pos-z').value) || 0;
    model.position.set(px, py, pz);

    const rx = parseFloat(document.getElementById('rot-x').value) || 0;
    const ry = parseFloat(document.getElementById('rot-y').value) || 0;
    const rz = parseFloat(document.getElementById('rot-z').value) || 0;
    model.rotation.set(
        THREE.MathUtils.degToRad(rx),
        THREE.MathUtils.degToRad(ry),
        THREE.MathUtils.degToRad(rz)
    );

    const sx = parseFloat(document.getElementById('scl-x').value) || 1;
    const sy = parseFloat(document.getElementById('scl-y').value) || 1;
    const sz = parseFloat(document.getElementById('scl-z').value) || 1;
    model.scale.set(sx, sy, sz);
}

function updateModelSelectUI() {
    const select = document.getElementById('model-select');

    if (!select) return;

    select.innerHTML = '<option value="-1">None</option>';

    loadedModels.forEach((item, index) => {
        const option = document.createElement('option');
        option.value = index;
        option.text = `[${index + 1}] ${item.name}`;
        select.appendChild(option);
    });

    if (loadedModels.length > 0) {
        if (selectedModelIndex < 0 || selectedModelIndex >= loadedModels.length) {
            selectedModelIndex = loadedModels.length - 1;
        }
        select.value = selectedModelIndex;
        // 调用封装好的选中逻辑
        selectModelByIndex(selectedModelIndex);
    } else {
        select.value = -1;
        selectModelByIndex(-1);
    }
}

function updateCullingSettings(enabled) {
    if (!mainGroup) return;
    let count = 0;
    mainGroup.traverse((child) => {
        if (child.isMesh) {
            child.frustumCulled = enabled;
            count++;
        }
    });
    log(`Frustum Culling set to: ${enabled} (${count} meshes)`);
}

function initFileHandlers() {
    const manager = new THREE.LoadingManager();
    const blobURLs = {};

    manager.setURLModifier((url) => {
        const fileName = url.split('/').pop();
        if (blobURLs[fileName]) return blobURLs[fileName];
        return url;
    });

    const handleFiles = (files) => {
        if (files.length === 0) return;
        const startTime = performance.now();
        log("Processing files...");

        let rootFile = null;
        let rootName = "Unknown Model";

        Array.from(files).forEach(file => {
            blobURLs[file.name] = URL.createObjectURL(file);
            if (file.name.match(/\.(gltf|glb)$/i)) {
                rootFile = file.name;
                rootName = file.name;
            }
        });

        if (!rootFile) {
            log("Error: No .gltf or .glb found.");
            return;
        }

        log(`Loading: ${rootFile}`);
        const loader = new GLTFLoader(manager);
        loader.load(rootFile, (gltf) => {
            onModelLoaded(gltf.scene, startTime, rootName);
        }, undefined, (err) => {
            log(`Error: ${err.message}`);
        });
    };

    const inputFolder = document.getElementById('file-input-folder');
    const inputFiles = document.getElementById('file-input-files');
    const inputHdr = document.getElementById('file-input-hdr');

    if (inputFolder) {
        inputFolder.addEventListener('change', (e) => {
            handleFiles(e.target.files);
            e.target.value = ''; // <--- 新增：清空值，允许重复选择同一文件夹
        });
    }

    if (inputFiles) {
        inputFiles.addEventListener('change', (e) => {
            handleFiles(e.target.files);
            e.target.value = ''; // <--- 新增：清空值，允许重复选择同一文件
        });
    }

    if (inputHdr) inputHdr.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const url = URL.createObjectURL(file);
        new RGBELoader().load(url, (texture) => {
            texture.mapping = THREE.EquirectangularReflectionMapping;
            scene.background = texture;
            scene.environment = texture;
            scene.backgroundBlurriness = params.blur;
            log(`HDR Set: ${file.name}`);
        });
    });
}

function onModelLoaded(object, startTime, modelName) {
    const appendModeEl = document.getElementById('chk-append');
    const appendMode = appendModeEl ? appendModeEl.checked : false;

    if (!appendMode) {
        log("Single Mode: Clearing previous...");
        mainGroup.clear();
        originalMeshes = [];
        loadedModels = [];
        if (transformControl) transformControl.detach();

        const slider = document.getElementById('simp-slider');
        if (slider) slider.value = 0;
        const sliderVal = document.getElementById('simp-val');
        if (sliderVal) sliderVal.innerText = "0% (Original)";
    } else {
        log("Multi Mode: Appending...");
    }

    // 使用辅助函数生成唯一名称
    const uniqueName = getUniqueName(modelName);

    const box = new THREE.Box3().setFromObject(object);
    const center = box.getCenter(new THREE.Vector3());
    object.position.sub(center);

    mainGroup.add(object);

    loadedModels.push({
        name: modelName,
        object: object
    });

    selectedModelIndex = loadedModels.length - 1;
    updateModelSelectUI();

    let vramSize = 0;
    object.traverse(child => {
        if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
            child.frustumCulled = params.frustumCulling;

            if (child.material) {
                child.material.side = params.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
            }

            if (child.geometry) {
                const attr = child.geometry.attributes;
                for (let name in attr) {
                    vramSize += attr[name].array.byteLength;
                }
            }
            originalMeshes.push({
                mesh: child,
                geometry: child.geometry.clone()
            });
        }
    });

    const loadTime = (performance.now() - startTime).toFixed(0);
    document.getElementById('val-loadtime').innerText = `${loadTime} ms`;

    updateVRAMEst();

    log(`Model Added. Double Sided: ${params.doubleSided}`);

    if (loadedModels.length === 1) {
        fitCameraToSelection(mainGroup);
    }
}

function fitCameraToSelection(object) {
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = camera.fov * (Math.PI / 180);
    let cameraDist = Math.abs(maxDim / 2 / Math.tan(fov / 2));
    cameraDist *= 1.5;

    const direction = new THREE.Vector3(1, 1, 1).normalize();
    const newPos = center.clone().add(direction.multiplyScalar(cameraDist));

    camera.position.copy(newPos);
    camera.lookAt(center);

    camera.near = maxDim / 1000;
    camera.far = maxDim * 100;
    camera.updateProjectionMatrix();

    controls.target.copy(center);
    controls.maxDistance = maxDim * 10;
    controls.update();
}

const modifier = new SimplifyModifier();
let simplifyTimeout;

function applySimplification(reduceRatio) {
    if (originalMeshes.length === 0) return;
    if (simplifyTimeout) clearTimeout(simplifyTimeout);

    // 获取当前范围：current 还是 all
    const scopeEl = document.querySelector('input[name="simp-scope"]:checked');
    const scope = scopeEl ? scopeEl.value : 'all';

    // 确定目标 meshes
    let targetMeshes = [];

    if (scope === 'all') {
        targetMeshes = originalMeshes;
    } else {
        // 只有当前选中的模型
        if (selectedModelIndex === -1 || !loadedModels[selectedModelIndex]) return;
        const currentModel = loadedModels[selectedModelIndex].object;

        // 筛选属于当前模型的 originalMeshes
        // 由于 originalMeshes 中的 mesh 是场景中的对象，我们可以通过 traverseAncestors 检查
        const currentModelMeshes = new Set();
        currentModel.traverse(child => {
            if (child.isMesh) currentModelMeshes.add(child);
        });

        targetMeshes = originalMeshes.filter(item => currentModelMeshes.has(item.mesh));
    }

    log(`Scheduling Simplification: Reduce ${(reduceRatio * 100).toFixed(0)}%...`);

    simplifyTimeout = setTimeout(() => {
        const startTime = performance.now();
        let totalTrianglesAfter = 0;

        originalMeshes.forEach(data => {
            const { mesh, geometry } = data;

            if (reduceRatio <= 0.005) {
                if (mesh.geometry !== geometry) mesh.geometry = geometry;
                totalTrianglesAfter += geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3;
            } else {
                const totalVertices = geometry.attributes.position.count;
                const countToRemove = Math.floor(totalVertices * reduceRatio);

                if (countToRemove >= totalVertices) return;
                if (countToRemove <= 0) return;

                try {
                    const simplified = modifier.modify(geometry, countToRemove);
                    mesh.geometry = simplified;
                    totalTrianglesAfter += simplified.index ? simplified.index.count / 3 : simplified.attributes.position.count / 3;
                } catch (e) {
                    if (mesh.geometry !== geometry) mesh.geometry = geometry;
                }
            }
        });

        // 注意：这里的统计可能不准，因为它只加上了正在被简化的模型的三角形
        // 如果我们只简化了一个模型，其他模型的三角形数应该也要加回来显示
        // 简单起见，重新统计整个场景
        const allTris = renderer.info.render.triangles;

        updateVRAMEst();

        const time = (performance.now() - startTime).toFixed(0);
        log(`Simp done in ${time}ms. Tris: ${totalTrianglesAfter.toFixed(0)}`);
    }, 150);
}

function generateTestCube() {
    log("Generating Cube...");
    const geometry = new THREE.BoxGeometry(2, 2, 2);
    const material = new THREE.MeshStandardMaterial({ color: 0xffa500, roughness: 0.2, metalness: 0.8 });
    const mesh = new THREE.Mesh(geometry, material);
    onModelLoaded(mesh, performance.now(), "Test Cube");
}

function log(msg) {
    const el = document.getElementById('console-output');
    if (el) {
        el.innerHTML += `<div>> ${msg}</div>`;
        el.scrollTop = el.scrollHeight;
    }
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// === 核心渲染循环 ===
function animate() {
    if (params.unlockFPS) {
        setTimeout(animate, 0);
    } else {
        requestAnimationFrame(animate);
    }

    const now = performance.now();
    frameCount++;

    controls.update();

    // === 核心修复：Gizmo 大小动态调整 ===
    // 逻辑：(模型半径 / 相机距离) * 系数
    // 这样当相机拉远 (distance变大) 时，size 变小，从而看起来像是"附着"在模型上，而不是占据整个屏幕
    if (transformControl && transformControl.object) {
        const dist = camera.position.distanceTo(transformControl.object.position);
        if (dist > 0 && selectedModelRadius > 0) {
            // 2.0 是一个视觉系数，你可以根据需要调整
            transformControl.size = (selectedModelRadius / dist) * 2.0;
        } else {
            transformControl.size = 0.5; // 兜底
        }
    }

    // 1. 计时开始
    const cpuStart = performance.now();
    gpuTimer.start();

    // 2. 渲染
    renderer.render(scene, camera);

    // 3. 计时结束
    gpuTimer.end();
    const cpuEnd = performance.now();
    const cpuTime = cpuEnd - cpuStart;

    if (now - lastTime >= 500) {
        const timeDiff = now - lastTime;
        const fps = Math.round((frameCount * 1000) / timeDiff);
        const frameTime = (timeDiff / frameCount).toFixed(2);

        const gpuTimeRaw = gpuTimer.poll();
        const gpuTimeStr = gpuTimeRaw !== null ? gpuTimeRaw.toFixed(3) : "N/A";

        const calls = renderer.info.render.calls;
        const tris = renderer.info.render.triangles;

        const fpsEl = document.getElementById('val-fps');
        if (fpsEl) {
            document.getElementById('val-fps').innerText = fps;
            document.getElementById('val-frametime').innerText = frameTime + " ms";
            document.getElementById('val-cpu').innerText = cpuTime.toFixed(3) + " ms";
            document.getElementById('val-gpu').innerText = gpuTimeStr + " ms";
            document.getElementById('val-drawcalls').innerText = calls;
            document.getElementById('val-tris').innerText = tris;
        }

        if (charts.fps) {
            charts.fps.update(fps);
            charts.ms.update(parseFloat(frameTime));
            charts.cpu.update(cpuTime);
            if (gpuTimeRaw !== null) charts.gpu.update(gpuTimeRaw);
            charts.calls.update(calls);
            charts.tris.update(tris);
        }

        frameCount = 0;
        lastTime = now;
    }
}

if (!isLoopRunning) {
    isLoopRunning = true;
    init();
    animate();
}