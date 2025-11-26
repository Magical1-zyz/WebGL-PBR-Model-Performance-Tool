import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { SimplifyModifier } from 'three/addons/modifiers/SimplifyModifier.js';
import GUI from 'three/addons/libs/lil-gui.module.min.js';

// === 1. 图表类定义 (使用 uPlot) ===
class PerfChart {
    constructor(name, color, suffix = '') {
        this.name = name;
        this.color = color;
        this.suffix = suffix;
        
        this.xData = []; 
        this.yData = [];
        this.maxPoints = 60; 

        let panel = document.getElementById('charts-panel');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'charts-panel';
            document.body.appendChild(panel);
        }

        this.dom = document.createElement('div');
        this.dom.className = 'chart-container';
        
        this.dom.innerHTML = `
            <div class="chart-header">
                <span class="chart-title" style="color:${color}">${name}</span>
                <span class="chart-value">--</span>
            </div>
            <div class="uplot-mount"></div>
        `;
        panel.appendChild(this.dom);

        this.valueDom = this.dom.querySelector('.chart-value');
        const mount = this.dom.querySelector('.uplot-mount');

        // uPlot 配置 (尺寸更新以适配更大的容器)
        const opts = {
            width: 398,  // 适配 400px 的容器
            height: 206, // 适配剩余高度
            class: "uplot-chart",
            cursor: {
                show: true,
                points: { size: 6, fill: color }
            },
            legend: { show: false },
            select: { show: false },
            scales: { x: { time: false } },
            axes: [
                {
                    show: true,
                    stroke: "#555",
                    grid: { show: true, stroke: "#222", width: 1 },
                    ticks: { show: false }
                },
                {
                    show: true,
                    stroke: "#888",
                    grid: { show: true, stroke: "#222", width: 1 },
                    size: 50, // 标签宽度加大
                    values: (self, ticks) => ticks.map(v => this.formatAxis(v))
                }
            ],
            series: [
                {}, 
                {
                    stroke: color,
                    width: 2,
                    fill: this.hexToRgba(color, 0.1),
                    points: { show: false }
                }
            ]
        };

        this.uplot = new window.uPlot(opts, [[], []], mount);
    }

    update(val) {
        this.valueDom.innerText = val.toLocaleString() + this.suffix;

        const index = this.xData.length > 0 ? this.xData[this.xData.length - 1] + 1 : 0;
        this.xData.push(index);
        this.yData.push(val);

        if (this.xData.length > this.maxPoints) {
            this.xData.shift();
            this.yData.shift();
        }
        this.uplot.setData([this.xData, this.yData]);
    }

    formatAxis(v) {
        if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
        if (v >= 1000) return (v / 1000).toFixed(0) + 'k';
        if (v % 1 !== 0 && v < 10) return v.toFixed(1); // 小数显示一位
        return v.toFixed(0);
    }

    hexToRgba(hex, alpha) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
}

// === 2. 全局变量 ===
let camera, scene, renderer, controls;
let modelGroup, originalMeshes = [];
let charts = {}; 
let lastTime = performance.now();
let frameCount = 0;
let isLoopRunning = false;

// 新增计时累加器
let accCpuTime = 0;
let accGpuTime = 0;

const params = {
    unlockFPS: false,
    frustumCulling: false,
    exposure: 1.0,
    blur: 0.0,
    rotation: 0,
    resetCam: () => {
        controls.reset();
        if(modelGroup) centerModel(modelGroup);
    }
};

// === 3. 主逻辑函数 ===
function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a1a);

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

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    const ambient = new THREE.AmbientLight(0xffffff, 0.5); 
    scene.add(ambient);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1);
    dirLight.position.set(5, 10, 7);
    dirLight.castShadow = true;
    scene.add(dirLight);

    initGUI();
    initFileHandlers();
    
    // 初始化图表 (新增 CPU 和 GPU)
    try {
        charts = {
            fps: new PerfChart('FPS', '#00ff9d'),          
            // ms: new PerfChart('Frame Time', '#00ccff', ' ms'), // 可以选择隐藏总帧时间，或者保留
            cpu: new PerfChart('CPU (Logic)', '#ff00ff', ' ms'), // 新增
            gpu: new PerfChart('GPU (Render)', '#00ccff', ' ms'), // 新增
            calls: new PerfChart('Draw Calls', '#ffcc00'),     
            tris: new PerfChart('Triangles', '#ff5555')        
        };
    } catch(e) {
        console.error("Chart Init Failed:", e);
    }
    
    const debugBtn = document.getElementById('btn-debug');
    if(debugBtn) debugBtn.addEventListener('click', generateTestCube);

    window.addEventListener('resize', onWindowResize);
    log("System Initializing... Ready.");
}

function initGUI() {
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
       .onChange(v => {
           log(v ? "FPS Unlocked (High CPU Usage)" : "FPS Locked (VSync)");
       });

    gui.add(params, 'frustumCulling').name('Frustum Culling')
       .onChange(updateCullingSettings);
       
    gui.add(params, 'exposure', 0.1, 5.0).name('Exposure').onChange(v => renderer.toneMappingExposure = v);
    gui.add(params, 'blur', 0, 1).name('BG Blur').onChange(v => scene.backgroundBlurriness = v);
    gui.add(params, 'rotation', 0, 360).name('Auto Rotation').onChange(v => {
        if(modelGroup) modelGroup.rotation.y = THREE.MathUtils.degToRad(v);
    });
    gui.add(params, 'resetCam').name('Reset Camera');
}

function updateCullingSettings(enabled) {
    if (!modelGroup) return;
    let count = 0;
    modelGroup.traverse((child) => {
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
        Array.from(files).forEach(file => {
            blobURLs[file.name] = URL.createObjectURL(file);
            if (file.name.match(/\.(gltf|glb)$/i)) rootFile = file.name;
        });

        if (!rootFile) {
            log("Error: No .gltf or .glb found.");
            return;
        }

        log(`Loading Main File: ${rootFile}`);
        const loader = new GLTFLoader(manager);
        loader.load(rootFile, (gltf) => {
            onModelLoaded(gltf.scene, startTime);
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

function onModelLoaded(object, startTime) {
    if (modelGroup) scene.remove(modelGroup);
    modelGroup = object;
    scene.add(modelGroup);

    originalMeshes = [];
    let vramSize = 0;

    modelGroup.traverse(child => {
        if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
            child.frustumCulled = params.frustumCulling;

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
    document.getElementById('val-vram').innerText = `~${(vramSize / 1024 / 1024).toFixed(1)} MB (Geo)`;
    
    log(`Model Loaded in ${loadTime}ms`);
    centerModel(modelGroup);
}

function centerModel(object) {
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    
    object.position.x += (object.position.x - center.x);
    object.position.y += (object.position.y - center.y);
    object.position.z += (object.position.z - center.z);
    
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = camera.fov * (Math.PI / 180);
    let cameraDist = Math.abs(maxDim / 2 / Math.tan(fov / 2));
    cameraDist *= 1.5; 

    const direction = new THREE.Vector3(1, 1, 1).normalize();
    const newPos = direction.multiplyScalar(cameraDist);
    camera.position.copy(newPos);
    camera.lookAt(0, 0, 0);

    camera.near = maxDim / 1000; 
    camera.far = maxDim * 100;
    camera.updateProjectionMatrix();

    controls.maxDistance = maxDim * 10;
    controls.target.set(0, 0, 0);
    controls.update();
}

const modifier = new SimplifyModifier();
let simplifyTimeout;

function applySimplification(reduceRatio) {
    if (!modelGroup || originalMeshes.length === 0) return;
    if (simplifyTimeout) clearTimeout(simplifyTimeout);
    
    log(`Scheduling Simplification: Reduce ${(reduceRatio * 100).toFixed(0)}% vertices...`);
    
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
        
        const time = (performance.now() - startTime).toFixed(0);
        log(`Simp done in ${time}ms. Tris: ${totalTrianglesAfter.toFixed(0)}`);
    }, 150); 
}

function generateTestCube() {
    log("Generating Cube...");
    const geometry = new THREE.BoxGeometry(2, 2, 2);
    const material = new THREE.MeshStandardMaterial({ color: 0xffa500, roughness: 0.2, metalness: 0.8 });
    const mesh = new THREE.Mesh(geometry, material);
    onModelLoaded(mesh, performance.now());
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

// === 核心：带计时的渲染循环 ===
function animate() {
    if (params.unlockFPS) {
        setTimeout(animate, 0);
    } else {
        requestAnimationFrame(animate);
    }

    const t0 = performance.now(); // 帧开始

    // 1. CPU Logic Phase (Controls, Physics, Updates)
    controls.update();
    if(modelGroup && params.rotation > 0) {
        // 自动旋转逻辑也算在 CPU 里
    }
    const t1 = performance.now(); // Logic 结束
    
    // 2. GPU/Render Phase (Command Submission)
    renderer.render(scene, camera);
    const t2 = performance.now(); // Render 结束

    // 计算耗时
    const cpuDuration = t1 - t0;
    const gpuDuration = t2 - t1; // 注意：这是 renderer.render 的 CPU 耗时，但在 WebGL 性能分析中常作为 "Draw Overhead"

    frameCount++;
    accCpuTime += cpuDuration;
    accGpuTime += gpuDuration;

    const now = performance.now();
    
    // 更新统计数据 (每 500ms)
    if (now - lastTime >= 500) {
        const timeDiff = now - lastTime;
        const fps = Math.round((frameCount * 1000) / timeDiff);
        const avgFrameTime = (timeDiff / frameCount).toFixed(2);
        
        // 计算平均 CPU/GPU 耗时
        const avgCpu = (accCpuTime / frameCount).toFixed(2);
        const avgGpu = (accGpuTime / frameCount).toFixed(2);

        const calls = renderer.info.render.calls;
        const tris = renderer.info.render.triangles;
        
        const fpsEl = document.getElementById('val-fps');
        if(fpsEl) {
            document.getElementById('val-fps').innerText = fps;
            document.getElementById('val-frametime').innerText = avgFrameTime + " ms";
            // 新增数据的 DOM 更新
            document.getElementById('val-cpu').innerText = avgCpu + " ms";
            document.getElementById('val-gpu').innerText = avgGpu + " ms";

            document.getElementById('val-drawcalls').innerText = calls;
            document.getElementById('val-tris').innerText = tris;
        }

        if (charts.fps) {
            charts.fps.update(fps);
            // charts.ms.update(parseFloat(avgFrameTime)); // 可选
            charts.cpu.update(parseFloat(avgCpu));
            charts.gpu.update(parseFloat(avgGpu));
            charts.calls.update(calls);
            charts.tris.update(tris);
        }
        
        // 重置计数器
        frameCount = 0;
        accCpuTime = 0;
        accGpuTime = 0;
        lastTime = now;
    }
}

if (!isLoopRunning) {
    isLoopRunning = true;
    init();
    animate();
}