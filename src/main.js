import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { XRButton } from "three/examples/jsm/webxr/XRButton.js";
import { XRControllerModelFactory } from "three/examples/jsm/webxr/XRControllerModelFactory.js";
import Stats from "stats.js";
import mqtt from "mqtt";
import { MQTT_CONFIG } from "./mqtt-config.js";

// ==========================================
// 설정
// ==========================================
const CONFIG = {
  terrain: {
    width: 257,
    height: 162,
    minElevation: 0,
    maxElevation: 500,
    heightScale: 50,
  },
  lerp: {
    enabled: true,
    factor: 0.12,  // 보간 속도 (0.1 = 부드럽게, 0.3 = 빠르게)
  },
};

// ==========================================
// 전역 상태
// ==========================================
let terrain = null;
let targetHeights = null;     // 목표 높이값 배열
let targetColors = null;      // 목표 색상 배열
let mqttClient = null;
let stats = null;
let controls = null;

// ==========================================
// Three.js 초기화
// ==========================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a2e);

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  1,
  2000
);
camera.position.set(0, 200, 300);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);

// ==========================================
// OrbitControls (마우스/터치 조작)
// ==========================================
controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.minDistance = 50;
controls.maxDistance = 800;
controls.maxPolarAngle = Math.PI / 2.1;
controls.target.set(0, 0, 0);

// ==========================================
// Stats.js (FPS 모니터)
// ==========================================
stats = new Stats();
stats.showPanel(0);
stats.dom.style.cssText = 'position:absolute;top:10px;right:10px;';
document.body.appendChild(stats.dom);

// ==========================================
// 조명
// ==========================================
const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
directionalLight.position.set(100, 200, 100);
scene.add(directionalLight);

// ==========================================
// 지형 생성
// ==========================================
function createTerrain() {
  const { width, height } = CONFIG.terrain;
  const geometry = new THREE.BufferGeometry();
  
  // 정점 배열 생성
  const vertices = new Float32Array(width * height * 3);
  const colors = new Float32Array(width * height * 3);
  
  for (let z = 0; z < height; z++) {
    for (let x = 0; x < width; x++) {
      const i = (z * width + x) * 3;
      vertices[i] = x - width / 2;
      vertices[i + 1] = 0;  // Y (높이)
      vertices[i + 2] = z - height / 2;
      
      // 초기 색상 (파란색)
      colors[i] = 0;
      colors[i + 1] = 0;
      colors[i + 2] = 1;
    }
  }
  
  // 인덱스 생성 (삼각형)
  const indices = new Uint32Array((width - 1) * (height - 1) * 6);
  let idx = 0;
  for (let z = 0; z < height - 1; z++) {
    for (let x = 0; x < width - 1; x++) {
      const a = z * width + x;
      const b = z * width + x + 1;
      const c = (z + 1) * width + x;
      const d = (z + 1) * width + x + 1;
      
      indices[idx++] = a;
      indices[idx++] = c;
      indices[idx++] = b;
      indices[idx++] = b;
      indices[idx++] = c;
      indices[idx++] = d;
    }
  }
  
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.attributes.position.usage = THREE.DynamicDrawUsage;
  geometry.attributes.color.usage = THREE.DynamicDrawUsage;
  geometry.computeVertexNormals();
  
  const material = new THREE.MeshPhongMaterial({
    vertexColors: true,
    flatShading: false,
    shininess: 30,
    side: THREE.DoubleSide,
  });
  
  terrain = new THREE.Mesh(geometry, material);
  scene.add(terrain);
  
  // 타겟 배열 초기화
  targetHeights = new Float32Array(width * height).fill(0);
  targetColors = new Float32Array(width * height * 3);
  for (let i = 0; i < targetColors.length; i += 3) {
    targetColors[i] = 0;
    targetColors[i + 1] = 0;
    targetColors[i + 2] = 1;
  }
  
  console.log(`✅ 지형 생성 완료: ${width}x${height} = ${width * height} 정점`);
}

// ==========================================
// 고도 데이터를 타겟으로 설정
// ==========================================
function setElevationTarget(data) {
  const { width, height, minElevation, maxElevation, heightScale } = CONFIG.terrain;
  const range = maxElevation - minElevation || 1;
  
  if (!data || data.length !== width * height) {
    console.warn(`⚠️ 데이터 크기 불일치: expected=${width * height}, got=${data?.length}`);
    return;
  }
  
  for (let i = 0; i < data.length; i++) {
    // 정규화 (0~1)
    let normalized = (data[i] - minElevation) / range;
    normalized = Math.max(0, Math.min(1, normalized));
    
    // 높이 설정
    targetHeights[i] = normalized * heightScale;
    
    // 색상 설정 (HSL: 파란색(240) → 빨간색(0))
    const hue = (1 - normalized) * 240 / 360;
    const color = new THREE.Color().setHSL(hue, 1, 0.5);
    const ci = i * 3;
    targetColors[ci] = color.r;
    targetColors[ci + 1] = color.g;
    targetColors[ci + 2] = color.b;
  }
}

// ==========================================
// 매 프레임 보간 (부드러운 전환)
// ==========================================
function lerpTerrain() {
  if (!terrain || !targetHeights || !CONFIG.lerp.enabled) return;
  
  const positions = terrain.geometry.attributes.position.array;
  const colors = terrain.geometry.attributes.color.array;
  const factor = CONFIG.lerp.factor;
  
  let posChanged = false;
  let colChanged = false;
  
  // 높이 보간 (Y좌표는 인덱스 1, 4, 7, 10...)
  for (let i = 0; i < targetHeights.length; i++) {
    const pi = i * 3 + 1;  // Y 인덱스
    const diff = targetHeights[i] - positions[pi];
    
    if (Math.abs(diff) > 0.01) {
      positions[pi] += diff * factor;
      posChanged = true;
    }
  }
  
  // 색상 보간
  for (let i = 0; i < targetColors.length; i++) {
    const diff = targetColors[i] - colors[i];
    if (Math.abs(diff) > 0.001) {
      colors[i] += diff * factor;
      colChanged = true;
    }
  }
  
  if (posChanged) {
    terrain.geometry.attributes.position.needsUpdate = true;
    // 노멀은 10프레임마다 업데이트 (성능)
    if (Math.random() < 0.1) {
      terrain.geometry.computeVertexNormals();
    }
  }
  
  if (colChanged) {
    terrain.geometry.attributes.color.needsUpdate = true;
  }
}

// ==========================================
// MQTT 연결
// ==========================================
function connectMQTT() {
  console.log(`🔌 MQTT 연결 시도: ${MQTT_CONFIG.broker}`);
  
  mqttClient = mqtt.connect(MQTT_CONFIG.broker, MQTT_CONFIG.options);
  
  mqttClient.on('connect', () => {
    console.log('✅ MQTT 연결 성공');
    mqttClient.subscribe(MQTT_CONFIG.topic, { qos: 0 }, (err) => {
      if (err) {
        console.error('❌ 구독 실패:', err);
      } else {
        console.log(`📡 구독 완료: ${MQTT_CONFIG.topic}`);
      }
    });
  });
  
  // 메시지 처리 (Latest-wins)
  let latestMessage = null;
  
  mqttClient.on('message', (topic, message) => {
    latestMessage = message;
  });
  
  // 매 프레임 최신 메시지만 처리 (렌더 루프에서 호출)
  window._processMQTTMessage = () => {
    if (!latestMessage) return;
    
    try {
      const text = new TextDecoder().decode(latestMessage);
      const parsed = JSON.parse(text);
      
      if (parsed.data && Array.isArray(parsed.data)) {
        setElevationTarget(parsed.data);
      }
    } catch (e) {
      console.error('❌ 메시지 파싱 오류:', e.message);
    }
    
    latestMessage = null;
  };
  
  mqttClient.on('error', (err) => console.error('❌ MQTT 오류:', err.message));
  mqttClient.on('reconnect', () => console.log('🔄 MQTT 재연결...'));
}

// ==========================================
// WebXR 설정
// ==========================================
async function setupWebXR() {
  if (!navigator.xr) {
    console.log('ℹ️ WebXR 미지원 - 데스크톱 모드');
    return;
  }
  
  try {
    const vrSupported = await navigator.xr.isSessionSupported('immersive-vr');
    
    if (vrSupported) {
      const xrButton = XRButton.createButton(renderer, {
        optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
      });
      document.body.appendChild(xrButton);
      
      // XR 컨트롤러
      const controllerModelFactory = new XRControllerModelFactory();
      
      const controller1 = renderer.xr.getController(0);
      scene.add(controller1);
      
      const controller2 = renderer.xr.getController(1);
      scene.add(controller2);
      
      const grip1 = renderer.xr.getControllerGrip(0);
      grip1.add(controllerModelFactory.createControllerModel(grip1));
      scene.add(grip1);
      
      const grip2 = renderer.xr.getControllerGrip(1);
      grip2.add(controllerModelFactory.createControllerModel(grip2));
      scene.add(grip2);
      
      console.log('✅ WebXR VR 모드 활성화');
    } else {
      console.log('ℹ️ VR 미지원 기기');
    }
  } catch (e) {
    console.error('❌ WebXR 설정 오류:', e);
  }
}

// ==========================================
// 창 크기 변경 대응
// ==========================================
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ==========================================
// 테스트 모드 (MQTT 없이 테스트)
// ==========================================
let testInterval = null;

function startTestMode() {
  if (testInterval) return;
  console.log('🧪 테스트 모드 시작');
  
  testInterval = setInterval(() => {
    const { width, height } = CONFIG.terrain;
    const data = new Array(width * height);
    const time = Date.now() * 0.001;
    
    for (let z = 0; z < height; z++) {
      for (let x = 0; x < width; x++) {
        const i = z * width + x;
        const nx = x / width;
        const nz = z / height;
        
        // 여러 사인파 조합
        let v = 0;
        v += Math.sin(nx * 4 + time) * 100;
        v += Math.sin(nz * 3 + time * 0.7) * 80;
        v += Math.sin((nx + nz) * 5 + time * 1.2) * 60;
        v += 250;  // 기본 높이
        
        data[i] = Math.max(0, Math.min(500, v));
      }
    }
    
    setElevationTarget(data);
  }, 500);
}

function stopTestMode() {
  if (testInterval) {
    clearInterval(testInterval);
    testInterval = null;
    console.log('🧪 테스트 모드 중지');
  }
}

// 전역 노출
window.startTestMode = startTestMode;
window.stopTestMode = stopTestMode;
window.CONFIG = CONFIG;

// ==========================================
// 렌더 루프
// ==========================================
function animate() {
  renderer.setAnimationLoop(() => {
    stats.begin();
    
    // MQTT 메시지 처리
    if (window._processMQTTMessage) {
      window._processMQTTMessage();
    }
    
    // 부드러운 보간
    lerpTerrain();
    
    // 컨트롤 업데이트
    controls.update();
    
    // 렌더링
    renderer.render(scene, camera);
    
    stats.end();
  });
}

// ==========================================
// 초기화
// ==========================================
function init() {
  createTerrain();
  setupWebXR();
  connectMQTT();
  animate();
  
  console.log('🚀 앱 시작');
  console.log('💡 테스트: startTestMode() / stopTestMode()');
}

init();
