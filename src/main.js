import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { SimplifyModifier } from 'three/addons/modifiers/SimplifyModifier.js';
import GUI from 'three/addons/libs/lil-gui.module.min.js';

// === 1. 图表类定义 ===
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

// === 2. 全局变量 ===
let camera, scene, renderer, controls;
let modelGroup, originalMeshes = [];
let charts = {}; 
let lastTime = performance.now();
let frameCount = 0;

const params = {
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

    renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('webgl-canvas'), antialias: true, alpha: false });
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
    
    try {
        charts = {
            fps: new PerfChart('FPS', '#00ff9d'),          
            ms: new PerfChart('Frame Time', '#00ccff', ' ms'), 
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
    // 1. 绑定原生 HTML 滑动条 (3. Simplification)
    const slider = document.getElementById('simp-slider');
    const sliderVal = document.getElementById('simp-val');
    
    if (slider) {
        // 初始化状态：强制归零
        slider.value = 0;
        sliderVal.innerText = "0% (Original)";
        
        slider.addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            
            // 更新文字显示
            if (val === 0) {
                sliderVal.innerText = "0% (Original)";
            } else {
                sliderVal.innerText = val + "% (Reduced)";
            }

            // 传入比率：0 (不减) -> 0.98 (减掉98%)
            applySimplification(val / 100);
        });
    }

    // 2. 配置 Lil-GUI (4. Render Settings)
    const gui = new GUI({ container: document.getElementById('lil-gui-mount'), width: '100%' });
    
    gui.add(params, 'exposure', 0.1, 5.0).name('Exposure').onChange(v => renderer.toneMappingExposure = v);
    gui.add(params, 'blur', 0, 1).name('BG Blur').onChange(v => scene.backgroundBlurriness = v);
    gui.add(params, 'rotation', 0, 360).name('Auto Rotation').onChange(v => {
        if(modelGroup) modelGroup.rotation.y = THREE.MathUtils.degToRad(v);
    });
    gui.add(params, 'resetCam').name('Reset Camera');
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
    const loadTimeEl = document.getElementById('val-loadtime');
    const vramEl = document.getElementById('val-vram');
    if(loadTimeEl) loadTimeEl.innerText = `${loadTime} ms`;
    if(vramEl) vramEl.innerText = `~${(vramSize / 1024 / 1024).toFixed(1)} MB (Geo)`;
    
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

    log(`Centered. Size: ${size.x.toFixed(2)}`);
}

const modifier = new SimplifyModifier();
let simplifyTimeout;

function applySimplification(reduceRatio) {
    if (!modelGroup || originalMeshes.length === 0) return;
    if (simplifyTimeout) clearTimeout(simplifyTimeout);
    
    // UI 显示的是 "Reduce Ratio" (0% - 98%)
    log(`Scheduling Simplification: Reduce ${(reduceRatio * 100).toFixed(0)}% vertices...`);
    
    simplifyTimeout = setTimeout(() => {
        const startTime = performance.now();
        let totalTrianglesAfter = 0;

        originalMeshes.forEach(data => {
            const { mesh, geometry } = data;
            
            // 1. 如果比率接近 0，说明不需要移除任何点 -> 恢复原始模型
            if (reduceRatio <= 0.005) { // 0.5% 以下忽略
                if(mesh.geometry !== geometry) mesh.geometry = geometry;
                totalTrianglesAfter += geometry.index ? geometry.index.count/3 : geometry.attributes.position.count/3;
            } else {
                // 2. 计算需要【移除】的顶点数量
                // 官方文档：count is the number of vertices to REMOVE.
                const totalVertices = geometry.attributes.position.count;
                const countToRemove = Math.floor(totalVertices * reduceRatio);
                
                // 至少保留几个点，防止 countToRemove >= totalVertices
                if (countToRemove >= totalVertices) return; 
                if (countToRemove <= 0) return;

                try {
                    // 执行移除
                    const simplified = modifier.modify(geometry, countToRemove);
                    mesh.geometry = simplified;
                    totalTrianglesAfter += simplified.index ? simplified.index.count/3 : simplified.attributes.position.count / 3;
                } catch (e) { 
                    console.warn("Simplification error:", e); 
                    // 出错时保持原样
                    if(mesh.geometry !== geometry) mesh.geometry = geometry;
                }
            }
        });
        
        const time = (performance.now() - startTime).toFixed(0);
        log(`Simp done in ${time}ms. Tris: ${totalTrianglesAfter.toFixed(0)}`);
    }, 150); // 稍微增加一点延迟，防止滑动过快卡顿
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

function animate() {
    requestAnimationFrame(animate);
    
    const now = performance.now();
    frameCount++;
    
    if (now - lastTime >= 500) {
        const timeDiff = now - lastTime;
        const fps = Math.round((frameCount * 1000) / timeDiff);
        const frameTime = (timeDiff / frameCount).toFixed(1);
        const calls = renderer.info.render.calls;
        const tris = renderer.info.render.triangles;
        
        const fpsEl = document.getElementById('val-fps');
        if(fpsEl) {
            document.getElementById('val-fps').innerText = fps;
            document.getElementById('val-frametime').innerText = frameTime + " ms";
            document.getElementById('val-drawcalls').innerText = calls;
            document.getElementById('val-tris').innerText = tris;
        }

        if (charts.fps) {
            charts.fps.update(fps);
            charts.ms.update(parseFloat(frameTime));
            charts.calls.update(calls);
            charts.tris.update(tris);
        }
        
        frameCount = 0;
        lastTime = now;
    }

    controls.update();
    renderer.render(scene, camera);
}

// === 4. 启动程序 ===
init();
animate();