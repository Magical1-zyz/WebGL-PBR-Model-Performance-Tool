import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { SimplifyModifier } from 'three/addons/modifiers/SimplifyModifier.js';
import GUI from 'three/addons/libs/lil-gui.module.min.js';

// === 1. 图表类 ===
class PerfChart {
    constructor(name, color, suffix = '') {
        this.name = name;
        this.color = color; 
        this.suffix = suffix;
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
            <div class="chart-value">${0}</div>
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
        this.valueDom.innerText = val.toLocaleString() + this.suffix;
        
        let min = Math.min(...this.data);
        let max = Math.max(...this.data);
        if (max === min) max = min + 1;
        const range = max - min;
        
        const ctx = this.ctx;
        const w = this.canvas.width;
        const h = this.canvas.height;
        const padding = 8;
        
        ctx.clearRect(0, 0, w, h);
        
        ctx.beginPath();
        ctx.strokeStyle = this.color;
        ctx.lineWidth = 2;
        
        for (let i = 0; i < this.data.length; i++) {
            const x = (i / (this.data.length - 1)) * w;
            const normalized = (this.data[i] - min) / range;
            const y = h - (normalized * (h - padding * 2) + padding);
            
            if (i === 0) ctx.moveTo(x, y); 
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.lineTo(w, h);
        ctx.lineTo(0, h);
        ctx.fillStyle = this.hexToRgba(this.color, 0.1); 
        ctx.fill();
    }

    hexToRgba(hex, alpha) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
}

// === GPU 计时器辅助类 (使用 WebGL2 扩展) ===
class GPUTimer {
    constructor(renderer) {
        this.renderer = renderer;
        this.gl = renderer.getContext();
        this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
        this.queries = [];
        this.available = !!this.ext;
        if (!this.available) {
            console.warn("GPU Timer: EXT_disjoint_timer_query_webgl2 not supported. GPU time will be N/A.");
        }
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

    // 获取上一帧或更早的查询结果 (非阻塞)
    poll() {
        if (!this.available || this.queries.length === 0) return null;

        // 检查最早的查询是否完成
        const query = this.queries[0];
        const available = this.gl.getQueryParameter(query, this.gl.QUERY_RESULT_AVAILABLE);
        
        if (available && !this.gl.getParameter(this.ext.GPU_DISJOINT_EXT)) {
            const timeNs = this.gl.getQueryParameter(query, this.gl.QUERY_RESULT);
            this.gl.deleteQuery(query);
            this.queries.shift();
            return timeNs / 1000000; // ns -> ms
        } else if (available) {
            // 查询失效 (Disjoint)，清理
            this.gl.deleteQuery(query);
            this.queries.shift();
            return null;
        }
        return null; // 还没准备好
    }
}

// === 2. 全局变量 ===
let camera, scene, renderer, controls, transformControl;
let mainGroup; 
let loadedModels = []; 
let originalMeshes = [];
let charts = {}; 
let lastTime = performance.now();
let frameCount = 0;
let isLoopRunning = false;
let selectedModelIndex = -1; 
let gpuTimer; // GPU 计时器实例

const params = {
    unlockFPS: false,
    frustumCulling: false,
    doubleSided: true,
    exposure: 1.0,
    blur: 0.0,
    rotation: 0,
    resetCam: () => {
        controls.reset();
        if(mainGroup) fitCameraToSelection(mainGroup);
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

    // 初始化 GPU 计时器
    gpuTimer = new GPUTimer(renderer);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    // Gizmo
    transformControl = new TransformControls(camera, renderer.domElement);
    transformControl.setSize(0.4); 
    transformControl.addEventListener('dragging-changed', function (event) {
        controls.enabled = !event.value;
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

    window.addEventListener('keydown', onKeyDown);

    initGUI();
    initFileHandlers();
    
    // 初始化所有图表，包括新增的 CPU 和 GPU
    try {
        charts = {
            fps: new PerfChart('FPS', '#00ff9d'),          
            ms: new PerfChart('Frame Time', '#00ccff', ' ms'), 
            cpu: new PerfChart('CPU Time', '#ffa500', ' ms'),  // 橙色
            gpu: new PerfChart('GPU Time', '#d600ff', ' ms'),  // 紫色
            calls: new PerfChart('Draw Calls', '#ffcc00'),     
            tris: new PerfChart('Triangles', '#ff5555')        
        };
    } catch(e) { console.error(e); }
    
    const debugBtn = document.getElementById('btn-debug');
    if(debugBtn) debugBtn.addEventListener('click', generateTestCube);

    window.addEventListener('resize', onWindowResize);
    log("System Initializing... Ready.");
    
    updateModelSelectUI();
}

function onKeyDown(event) {
    if (event.key === 'Delete' || event.key === 'Backspace') {
        if (document.activeElement.tagName !== 'INPUT') {
            deleteSelectedModel();
        }
    }
}

function deleteSelectedModel() {
    if (selectedModelIndex === -1 || !loadedModels[selectedModelIndex]) return;

    const modelToRemove = loadedModels[selectedModelIndex].object;
    const modelName = loadedModels[selectedModelIndex].name;

    mainGroup.remove(modelToRemove);
    transformControl.detach();

    const meshesToRemove = new Set();
    modelToRemove.traverse(child => {
        if(child.isMesh) meshesToRemove.add(child);
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
            selectedModelIndex = index;
            
            if (index === -1) {
                transformControl.detach();
                if(tfPanel) tfPanel.style.display = 'none';
            } else if (loadedModels[index]) {
                const model = loadedModels[index].object;
                transformControl.attach(model);
                if(tfPanel) tfPanel.style.display = 'block';
                updateTransformUI(model);
            }
        });
    }

    const modes = document.getElementsByName('tf-mode');
    modes.forEach(btn => {
        btn.addEventListener('change', (e) => {
            if(transformControl) transformControl.setMode(e.target.value);
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
    
    // 这里不再包含 "Simulate Low GPU" 的功能，因为您说不需要
    gui.add(params, 'unlockFPS').name('Unlock FPS Limit')
       .onChange(v => log(v ? "FPS Unlocked" : "FPS Locked"));

    gui.add(params, 'frustumCulling').name('Frustum Culling').onChange(updateCullingSettings);
    gui.add(params, 'doubleSided').name('Double Sided').onChange(updateMaterialSide);
    gui.add(params, 'exposure', 0.1, 5.0).name('Exposure').onChange(v => renderer.toneMappingExposure = v);
    gui.add(params, 'blur', 0, 1).name('BG Blur').onChange(v => scene.backgroundBlurriness = v);
    gui.add(params, 'rotation', 0, 360).name('Auto Rotation').onChange(v => {
        if(mainGroup) mainGroup.rotation.y = THREE.MathUtils.degToRad(v);
    });
    gui.add(params, 'resetCam').name('Reset Camera');
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
    const tfPanel = document.getElementById('transform-panel');
    
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
        if (loadedModels[selectedModelIndex]) {
            transformControl.attach(loadedModels[selectedModelIndex].object);
            if(tfPanel) {
                tfPanel.style.display = 'block';
                updateTransformUI(loadedModels[selectedModelIndex].object);
            }
        }
    } else {
        select.value = -1;
        selectedModelIndex = -1;
        transformControl.detach();
        if(tfPanel) tfPanel.style.display = 'none';
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

    if(inputFolder) inputFolder.addEventListener('change', (e) => handleFiles(e.target.files));
    if(inputFiles) inputFiles.addEventListener('change', (e) => handleFiles(e.target.files));

    if(inputHdr) inputHdr.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if(!file) return;
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
        if(transformControl) transformControl.detach();
        
        const slider = document.getElementById('simp-slider');
        if(slider) slider.value = 0;
        const sliderVal = document.getElementById('simp-val');
        if(sliderVal) sliderVal.innerText = "0% (Original)";
    } else {
        log("Multi Mode: Appending...");
    }

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

            if(child.geometry) {
                const attr = child.geometry.attributes;
                for(let name in attr) {
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
    
    log(`Scheduling Simplification: Reduce ${(reduceRatio * 100).toFixed(0)}%...`);
    
    simplifyTimeout = setTimeout(() => {
        const startTime = performance.now();
        let totalTrianglesAfter = 0;

        originalMeshes.forEach(data => {
            const { mesh, geometry } = data;
            
            if (reduceRatio <= 0.005) {
                if(mesh.geometry !== geometry) mesh.geometry = geometry;
                totalTrianglesAfter += geometry.index ? geometry.index.count/3 : geometry.attributes.position.count/3;
            } else {
                const totalVertices = geometry.attributes.position.count;
                const countToRemove = Math.floor(totalVertices * reduceRatio);
                
                if (countToRemove >= totalVertices) return; 
                if (countToRemove <= 0) return;

                try {
                    const simplified = modifier.modify(geometry, countToRemove);
                    mesh.geometry = simplified;
                    totalTrianglesAfter += simplified.index ? simplified.index.count/3 : simplified.attributes.position.count / 3;
                } catch (e) { 
                    if(mesh.geometry !== geometry) mesh.geometry = geometry;
                }
            }
        });
        
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
    if(el) {
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
    
    // Gizmo 动态缩放
    if (transformControl && transformControl.object) {
        const dist = camera.position.distanceTo(transformControl.object.position);
        transformControl.size = 0.4 * (dist / 10); 
    }

    controls.update();

    // 1. CPU 时间开始
    const cpuStart = performance.now();

    // 2. GPU 计时开始
    gpuTimer.start();

    // 3. 渲染场景
    renderer.render(scene, camera);

    // 4. GPU 计时结束
    gpuTimer.end();

    // 5. CPU 时间结束
    const cpuEnd = performance.now();
    const cpuTime = cpuEnd - cpuStart;

    // 6. 统计数据
    if (now - lastTime >= 500) {
        const timeDiff = now - lastTime;
        const fps = Math.round((frameCount * 1000) / timeDiff);
        const frameTime = (timeDiff / frameCount).toFixed(2);
        
        // 获取 GPU 时间（可能为 null）
        const gpuTimeRaw = gpuTimer.poll();
        const gpuTimeStr = gpuTimeRaw !== null ? gpuTimeRaw.toFixed(2) : "N/A";
        
        const calls = renderer.info.render.calls;
        const tris = renderer.info.render.triangles;
        
        // 更新 UI
        const elFps = document.getElementById('val-fps');
        if(elFps) {
            document.getElementById('val-fps').innerText = fps;
            document.getElementById('val-frametime').innerText = frameTime + " ms";
            document.getElementById('val-cpu').innerText = cpuTime.toFixed(2) + " ms"; // CPU
            document.getElementById('val-gpu').innerText = gpuTimeStr + " ms"; // GPU
            document.getElementById('val-drawcalls').innerText = calls;
            document.getElementById('val-tris').innerText = tris;
        }

        // 更新图表
        if (charts.fps) {
            charts.fps.update(fps);
            charts.ms.update(parseFloat(frameTime));
            charts.cpu.update(cpuTime); // CPU Chart
            if (gpuTimeRaw !== null) charts.gpu.update(gpuTimeRaw); // GPU Chart
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