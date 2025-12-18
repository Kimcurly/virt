import * as THREE from "three";
import { XRButton } from "three/examples/jsm/webxr/XRButton.js";
import { XRControllerModelFactory } from "three/examples/jsm/webxr/XRControllerModelFactory.js";
import mqtt from "mqtt";
import { MQTT_CONFIG } from "./mqtt-config.js";

// ==========================================
// Worker 풀 (병렬 처리)
// ==========================================
const WORKER_POOL_SIZE = Math.max(1, (navigator.hardwareConcurrency || 4) - 1); // CPU 코어 - 1 (렌더/메인 스레드 여유 확보)
let workerPool = [];
let chunkProcessingState = {}; // 진행 중인 청크 처리 상태

function initWorkerPool() {
  try {
    for (let i = 0; i < WORKER_POOL_SIZE; i++) {
      const worker = new Worker("/elevation-processor-chunk.worker.js");
      worker.onmessage = handleChunkComplete;
      worker.onerror = (e) => {
        // e: ErrorEvent
        console.error(`❌ Worker ${i} onerror`, {
          message: e.message,
          filename: e.filename,
          lineno: e.lineno,
          colno: e.colno,
          error: e.error,
        });
      };

      worker.onmessageerror = (e) => {
        console.error(`❌ Worker ${i} onmessageerror`, e);
      };

      workerPool.push(worker);
    }
    console.log(`✅ ${WORKER_POOL_SIZE}개 Worker 풀 생성`);
  } catch (error) {
    logError("❌ Worker 풀 초기화 실패:", error.message);
    workerPool = [];
  }
}

function handleChunkComplete(event) {
  const { type, success, data, error } = event.data;

  if (type === "CHUNK_COMPLETE" && success) {
    const { positions, colors, chunkId, startIdx, endIdx } = data;
    chunkProcessingState[chunkId] = {
      positions: new Float32Array(positions),
      colors: new Float32Array(colors),
      startIdx,
      endIdx,
      complete: true,
    };

    checkAllChunksComplete();
  } else if (type === "CHUNK_ERROR") {
    logError(`❌ 청크 ${data.chunkId} 처리 오류:`, error);
  }
}

function checkAllChunksComplete() {
  const state = chunkProcessingState;
  if (!state._totalChunks) return;

  for (let i = 0; i < state._totalChunks; i++) {
    const c = state[`chunk_${i}`];
    if (!c || c.complete !== true) return;
  }

  mergeProcesedChunks();
}

function mergeProcesedChunks() {
  const state = chunkProcessingState;
  const { width, height, isRecreate } = state._meta;
  const totalVertices = width * height;

  const positions = new Float32Array(totalVertices * 3);
  const colors = new Float32Array(totalVertices * 3);

  for (let i = 0; i < state._totalChunks; i++) {
    const chunk = state[`chunk_${i}`];
    if (!chunk) continue;

    const { positions: chunkPos, colors: chunkCol, startIdx } = chunk;

    // 청크 데이터를 최종 배열에 복사 (TypedArray.set 사용)
    const offset = startIdx * 3;
    positions.set(chunkPos, offset);
    colors.set(chunkCol, offset);
  }

  onParallelProcessingComplete({
    positions: positions.buffer,
    colors: colors.buffer,
    width,
    height,
    isRecreate,
  });

  chunkProcessingState = {};
}

function onParallelProcessingComplete(data) {
  const { positions, colors, width, height, isRecreate } = data;

  // ✅ 처리 완료 알림
  if (setupMQTTHandlers.markProcessingComplete) {
    setupMQTTHandlers.markProcessingComplete();
  }

  if (!terrain || !terrain.geometry) {
    logError("❌ 지형 메시 초기화 오류");
    return;
  }

  try {
    if (isRecreate) {
      const geometry = new THREE.BufferGeometry();
      const posArr = new Float32Array(positions);
      const colArr = new Float32Array(colors);

      const indicesArray = new Uint32Array((width - 1) * (height - 1) * 6);
      let indiceIdx = 0;

      for (let y = 0; y < height - 1; y++) {
        for (let x = 0; x < width - 1; x++) {
          const a = y * width + x;
          const b = y * width + (x + 1);
          const c = (y + 1) * width + x;
          const d = (y + 1) * width + (x + 1);

          indicesArray[indiceIdx++] = a;
          indicesArray[indiceIdx++] = c;
          indicesArray[indiceIdx++] = b;
          indicesArray[indiceIdx++] = b;
          indicesArray[indiceIdx++] = c;
          indicesArray[indiceIdx++] = d;
        }
      }

      const posAttr = new THREE.BufferAttribute(posArr, 3);
      const colAttr = new THREE.BufferAttribute(colArr, 3);
      posAttr.setUsage(THREE.DynamicDrawUsage);
      colAttr.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute("position", posAttr);
      geometry.setAttribute("color", colAttr);
      geometry.setIndex(new THREE.BufferAttribute(indicesArray, 1));
      maybeUpdateNormals(geometry);

      terrain.geometry.dispose();
      terrain.geometry = geometry;
    } else {
      const positionAttr = terrain.geometry.getAttribute("position");
      const colorAttr = terrain.geometry.getAttribute("color");

      if (positionAttr && colorAttr) {
        const posArr = new Float32Array(positions);
        const colArr = new Float32Array(colors);

        positionAttr.array.set(posArr);
        colorAttr.array.set(colArr);

        positionAttr.needsUpdate = true;
        colorAttr.needsUpdate = true;

        maybeUpdateNormals(terrain.geometry);
      }
    }
  } catch (error) {
    logError("❌ Geometry 적용 오류:", error.message);
  }
}

// ==========================================
// 기존 Single Worker (폴백용)
// ==========================================
let elevationWorker = null;

function initElevationWorker() {
  try {
    elevationWorker = new Worker("/elevation-processor.worker.js");

    elevationWorker.onmessage = function (event) {
      const { type, success, data, error } = event.data;

      if (type === "PROCESSING_COMPLETE" && success) {
        onElevationDataProcessed(data);
      } else if (type === "PROCESSING_ERROR") {
        logError("❌ Worker 처리 오류:", error);
      }
    };

    elevationWorker.onerror = function (error) {
      logError("❌ Worker 오류:", error.message);
    };
  } catch (error) {
    logError("❌ Worker 초기화 실패:", error.message);
    elevationWorker = null;
  }
}

// ==========================================
// 성능 최적화 설정
// ==========================================
const PERF_CONFIG = {
  enableDetailedLogging: false,
  useDirectPositionUpdate: true,
  disableStatusMonitoring: true,
  useParallelWorkers: true,
  useWorkerProcessing: false,
};

// ==========================================
// 고도 데이터 정규화 설정 (0~500+ → 0~1)
// ==========================================
const ELEVATION_CONFIG = {
  minElevation: 0,      // 최소 고도값
  maxElevation: 500,    // 최대 고도값 (이 이상은 클램핑)
  heightScale: 10,      // 3D 시각화 높이 스케일
};

function log(...args) {
  if (PERF_CONFIG.enableDetailedLogging) {
    console.log(...args);
  }
}

function logError(...args) {
  console.error(...args);
}

// ==========================================
// Geometry 업데이트 최적화 유틸
// ==========================================
let _normalUpdateCounter = 0;
function maybeUpdateNormals(geometry) {
  // 매 10회 업데이트마다 한 번만 노멀 재계산 (CPU 절약)
  if (_normalUpdateCounter++ % 10 === 0 && geometry) {
    geometry.computeVertexNormals();
  }
}

// ==========================================
// 전역 변수
// ==========================================
let mqttClient = null;
let currentTerrainData = null;
let terrain = null;
let colorCache = new Map();
let cameraControl = {
  isMouseDown: false,
  mouseX: 0,
  mouseY: 0,
  targetRotationX: 0,
  targetRotationY: 0,
  currentRotationX: 0,
  currentRotationY: 0,

  keys: {},
  moveSpeed: 0.5,
  rotationSpeed: 0.05,

  distance: 20,
  minDistance: 5,
  maxDistance: 100,
  zoomSpeed: 2,
};

// WebXR 지원 여부 확인
let isWebXRSupported = false;
let xrMode = null;

async function checkWebXRSupport() {
  if (!navigator.xr) {
    console.log("WebXR 미지원 - 기본 3D 모드로 실행");
    return false;
  }

  try {
    const vrSupported = await navigator.xr.isSessionSupported("immersive-vr");
    const arSupported = await navigator.xr.isSessionSupported("immersive-ar");

    if (vrSupported) {
      console.log("WebXR VR 모드 지원됨");
      xrMode = "vr";
      return true;
    } else if (arSupported) {
      console.log("WebXR AR 모드 지원됨");
      xrMode = "ar";
      return true;
    } else {
      console.log(
        "WebXR 세션은 지원되지만 VR/AR 모드는 미지원 - 기본 3D 모드로 실행"
      );
      return false;
    }
  } catch (error) {
    console.log("WebXR 지원 확인 중 오류:", error);
    console.log("기본 3D 모드로 실행");
    return false;
  }
}

checkWebXRSupport().then((supported) => {
  isWebXRSupported = supported;
});

let mockData = {
  width: 10,
  height: 8,
  data: [
    0.73, 0.65, 0.44, 0.12, 0.98, 0.31, 0.57, 0.82, 0.19, 0.94, 0.05, 0.28,
    0.77, 0.51, 0.09, 0.62, 0.35, 0.88, 0.17, 0.49, 0.91, 0.22, 0.55, 0.78,
    0.14, 0.39, 0.68, 0.03, 0.85, 0.41, 0.69, 0.11, 0.96, 0.33, 0.58, 0.76,
    0.08, 0.45, 0.16, 0.92, 0.29, 0.53, 0.81, 0.47, 0.71, 0.18, 0.95, 0.34,
    0.61, 0.84, 0.04, 0.27, 0.52, 0.79, 0.13, 0.37, 0.64, 0.01, 0.86, 0.42,
    0.74, 0.15, 0.99, 0.38, 0.63, 0.83, 0.1, 0.48, 0.2, 0.93, 0.06, 0.3, 0.54,
    0.75, 0.11, 0.32, 0.59, 0.8, 0.17, 0.4,
  ],
};

// three.js 기본 씬 생성
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x222222);

const camera = new THREE.PerspectiveCamera(
  75,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
);
camera.position.set(0, 5, 8);
camera.lookAt(0, 2, 0);

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  xrCompatible: true,
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.shadowMap.enabled = true;
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);

// WebXR 버튼 초기화 (비동기)
async function initXRButton() {
  const supported = await checkWebXRSupport();

  if (supported) {
    try {
      const buttonOptions = {
        optionalFeatures: ["dom-overlay", "dom-overlay-for-handheld-ar"],
        domOverlay: { root: document.body },
      };

      if (xrMode === "ar") {
        buttonOptions.optionalFeatures.push("hit-test");
      }

      const xrButton = XRButton.createButton(renderer, buttonOptions);
      document.body.appendChild(xrButton);
      console.log("XR 버튼 추가됨");
    } catch (error) {
      console.error("XR 버튼 생성 실패:", error);
      showXRNotSupportedMessage();
    }
  } else {
    showXRNotSupportedMessage();
  }
}

function showXRNotSupportedMessage() {
  const xrNotice = document.createElement("div");
  xrNotice.style.cssText = `
    position: fixed;
    top: 10px;
    right: 10px;
    background: rgba(0,0,0,0.8);
    color: white;
    padding: 10px;
    border-radius: 5px;
    font-family: Arial, sans-serif;
    font-size: 12px;
    z-index: 1000;
  `;
  xrNotice.textContent = "WebXR VR/AR 미지원 - 기본 3D 모드";
  document.body.appendChild(xrNotice);
}

initXRButton();

// ==========================================
// Web Worker 초기화
// ==========================================
initWorkerPool();
initElevationWorker();

// 조명 설정
const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
directionalLight.position.set(10, 15, 10);
directionalLight.castShadow = true;
directionalLight.shadow.mapSize.width = 2048;
directionalLight.shadow.mapSize.height = 2048;
directionalLight.shadow.camera.near = 0.5;
directionalLight.shadow.camera.far = 50;
directionalLight.shadow.camera.left = -15;
directionalLight.shadow.camera.right = 15;
directionalLight.shadow.camera.top = 15;
directionalLight.shadow.camera.bottom = -15;
scene.add(directionalLight);

const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
scene.add(ambientLight);

// ==========================================
// 초기 지형 생성 (mockData 사용)
// ==========================================
const terrainGeometry = createTerrainGeometry(mockData);
const terrainMaterial = new THREE.MeshPhongMaterial({
  vertexColors: true,
  wireframe: false,
  flatShading: false,
  shininess: 10,
});
terrain = new THREE.Mesh(terrainGeometry, terrainMaterial);
terrain.receiveShadow = true;
terrain.castShadow = true;
scene.add(terrain);
console.log("✅ 초기 지형 생성 완료 (mockData 사용)");

// ==========================================
// XR 컨트롤러 설정
let controllerModelFactory,
  controller0,
  controller1,
  controllerGrip0,
  controllerGrip1;

async function initXRControllers() {
  const supported = await checkWebXRSupport();

  if (supported) {
    try {
      controllerModelFactory = new XRControllerModelFactory();
      controller0 = renderer.xr.getController(0);
      controller1 = renderer.xr.getController(1);
      scene.add(controller0);
      scene.add(controller1);

      controllerGrip0 = renderer.xr.getControllerGrip(0);
      controllerGrip1 = renderer.xr.getControllerGrip(1);
      controllerGrip0.add(
        controllerModelFactory.createControllerModel(controllerGrip0)
      );
      controllerGrip1.add(
        controllerModelFactory.createControllerModel(controllerGrip1)
      );
      scene.add(controllerGrip0);
      scene.add(controllerGrip1);
      console.log("XR 컨트롤러 초기화됨");
    } catch (error) {
      console.error("XR 컨트롤러 초기화 실패:", error);
    }
  }
}

initXRControllers();

// 지형 업데이트 타이머 (즉시 업데이트 모드)
function startTerrainUpdateTimer() {
  log("✅ 즉시 업데이트 모드 활성화");
}

function stopTerrainUpdateTimer() {
  log("🛑 타이머 중지");
}

// ==========================================
// Worker 처리 완료 핸들러 (Single worker 폴백)
// ==========================================
function onElevationDataProcessed(data) {
  const { positions, colors, width, height, isRecreate } = data;

  if (!terrain || !terrain.geometry) {
    logError("❌ 지형 메시가 초기화되지 않음");
    return;
  }

  try {
    if (isRecreate) {
      const geometry = new THREE.BufferGeometry();
      const posArr = new Float32Array(positions);
      const colArr = new Float32Array(colors);

      const indicesArray = new Uint32Array((width - 1) * (height - 1) * 6);
      let indiceIdx = 0;

      for (let y = 0; y < height - 1; y++) {
        for (let x = 0; x < width - 1; x++) {
          const a = y * width + x;
          const b = y * width + (x + 1);
          const c = (y + 1) * width + x;
          const d = (y + 1) * width + (x + 1);

          indicesArray[indiceIdx++] = a;
          indicesArray[indiceIdx++] = c;
          indicesArray[indiceIdx++] = b;
          indicesArray[indiceIdx++] = b;
          indicesArray[indiceIdx++] = c;
          indicesArray[indiceIdx++] = d;
        }
      }

      const posAttr = new THREE.BufferAttribute(posArr, 3);
      const colAttr = new THREE.BufferAttribute(colArr, 3);
      posAttr.setUsage(THREE.DynamicDrawUsage);
      colAttr.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute("position", posAttr);
      geometry.setAttribute("color", colAttr);
      geometry.setIndex(new THREE.BufferAttribute(indicesArray, 1));
      maybeUpdateNormals(geometry);

      terrain.geometry.dispose();
      terrain.geometry = geometry;
    } else {
      const positionAttr = terrain.geometry.getAttribute("position");
      const colorAttr = terrain.geometry.getAttribute("color");

      if (positionAttr && colorAttr) {
        const posArr = new Float32Array(positions);
        const colArr = new Float32Array(colors);

        positionAttr.array.set(posArr);
        colorAttr.array.set(colArr);

        positionAttr.needsUpdate = true;
        colorAttr.needsUpdate = true;

        maybeUpdateNormals(terrain.geometry);
      }
    }
  } catch (error) {
    logError("❌ Elevation 데이터 적용 오류:", error.message);
  }
}

function getColorFromHue(hue) {
  if (!colorCache.has(hue)) {
    const color = new THREE.Color();
    color.setHSL(hue / 360, 1, 0.5);
    colorCache.set(hue, { r: color.r, g: color.g, b: color.b });
  }
  return colorCache.get(hue);
}

function createTerrainGeometry(terrainData) {
  const { width, height, data } = terrainData;
  const geometry = new THREE.BufferGeometry();

  const positions = new Float32Array(width * height * 3);
  const colors = new Float32Array(width * height * 3);
  const indicesArray = new Uint32Array((width - 1) * (height - 1) * 6);
  let indiceIdx = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const posIdx = idx * 3;
      const dataValue = data[idx];

      const elevation = dataValue * 3;
      positions[posIdx] = x - width / 2;
      positions[posIdx + 1] = elevation;
      positions[posIdx + 2] = y - height / 2;

      const hue = (1 - dataValue) * 240;
      const color = getColorFromHue(hue);
      colors[posIdx] = color.r;
      colors[posIdx + 1] = color.g;
      colors[posIdx + 2] = color.b;
    }
  }

  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const a = y * width + x;
      const b = y * width + x + 1;
      const c = (y + 1) * width + x;
      const d = (y + 1) * width + x + 1;

      indicesArray[indiceIdx++] = a;
      indicesArray[indiceIdx++] = c;
      indicesArray[indiceIdx++] = b;
      indicesArray[indiceIdx++] = b;
      indicesArray[indiceIdx++] = c;
      indicesArray[indiceIdx++] = d;
    }
  }

  const posAttr = new THREE.BufferAttribute(positions, 3);
  const colAttr = new THREE.BufferAttribute(colors, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  colAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", posAttr);
  geometry.setAttribute("color", colAttr);
  geometry.setIndex(new THREE.BufferAttribute(indicesArray, 1));
  maybeUpdateNormals(geometry);

  return geometry;
}

// 최적화된 지형 업데이트 함수 - 병렬 Worker 풀 사용
function updateTerrainOptimized(newData) {
  const { width, height, data } = newData;

  if (!terrain || !terrain.geometry) {
    logError("❌ 지형 메시 초기화 오류");
    return;
  }

  // ✅ data 배열을 Float32Array로 변환 (성능 + Transferable)
  const elevationData = data instanceof Float32Array 
    ? data 
    : new Float32Array(data);

  if (PERF_CONFIG.useParallelWorkers && workerPool.length > 0) {
    try {
      const expectedVertexCount = width * height;
      const chunkSize = Math.ceil(expectedVertexCount / WORKER_POOL_SIZE);

      const actualChunks = Math.min(
        WORKER_POOL_SIZE,
        Math.ceil(expectedVertexCount / chunkSize)
      );

      // ✅ 고정 정규화 범위 사용 (동적 min/max 계산 제거)
      const { minElevation, maxElevation, heightScale } = ELEVATION_CONFIG;

      // 현재 지오메트리 크기와 비교하여 재생성 여부 결정
      const currentVertexCount = terrain.geometry.getAttribute('position')?.count || 0;
      const isRecreate = currentVertexCount !== expectedVertexCount;

      chunkProcessingState = {
        _totalChunks: actualChunks,
        _meta: { width, height, isRecreate },
      };

      for (let i = 0; i < actualChunks; i++) {
        const startIdx = i * chunkSize;
        const endIdx = Math.min((i + 1) * chunkSize, expectedVertexCount);

        if (startIdx >= endIdx) {
          chunkProcessingState[`chunk_${i}`] = {
            complete: true,
            startIdx,
            endIdx,
            positions: new Float32Array(0),
            colors: new Float32Array(0),
          };
          continue;
        }

        // ✅ 원본 배열에서 슬라이스 (복사본 생성)
        const chunkElev = elevationData.slice(startIdx, endIdx);

        workerPool[i].postMessage(
          {
            type: "PROCESS_CHUNK",
            data: {
              width,
              height,
              elevationData: chunkElev,
              startIdx,
              endIdx,
              chunkId: `chunk_${i}`,
              minV: minElevation,      // ✅ 고정값 사용
              maxV: maxElevation,      // ✅ 고정값 사용
              heightScale,             // ✅ 설정에서 가져옴
            },
          },
          [chunkElev.buffer]  // Transferable로 전송
        );

        chunkProcessingState[`chunk_${i}`] = { complete: false };
      }
    } catch (error) {
      logError("❌ 병렬 처리 오류:", error.message);
      fallbackUpdateTerrainOptimized(newData);
      return;
    }

    return;
  }

  fallbackUpdateTerrainOptimized(newData);
}

// 폴백 함수: Worker 미사용 시
function fallbackUpdateTerrainOptimized(newData) {
  const startTime = performance.now();

  if (!terrain || !terrain.geometry) {
    logError("❌ 지형 메시가 초기화되지 않음");
    return;
  }

  const { width, height, data } = newData;
  const positionAttr = terrain.geometry.getAttribute("position");
  const colorAttr = terrain.geometry.getAttribute("color");

  if (!positionAttr || !colorAttr) {
    logError("❌ 위치/색상 속성이 없음");
    return;
  }

  const positions = positionAttr.array;
  const colors = colorAttr.array;

  const expectedVertexCount = width * height;
  if (positions.length / 3 !== expectedVertexCount) {
    console.log(
      `📐 데이터 크기 변경: ${
        positions.length / 3
      } → ${expectedVertexCount} 정점`
    );
    console.log(`   기존 geometry 재생성 필요`);

    const newGeometry = createTerrainGeometry(newData);
    terrain.geometry.dispose();
    terrain.geometry = newGeometry;

    const endTime = performance.now();
    console.log(
      `⚡ 지형 업데이트 (재생성 - 폴백) - ${(endTime - startTime).toFixed(2)}ms`
    );
    return;
  }

  // ✅ 고정 정규화 범위 사용
  const { minElevation, maxElevation, heightScale } = ELEVATION_CONFIG;
  const range = maxElevation - minElevation || 1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const posIdx = idx * 3;

      if (posIdx + 2 >= positions.length || idx >= data.length) {
        console.warn(`⚠️ 배열 범위 초과: posIdx=${posIdx}, idx=${idx}`);
        continue;
      }

      // ✅ 0~1 정규화 (클램핑 포함)
      const rawValue = data[idx];
      let normalized = (rawValue - minElevation) / range;
      normalized = Math.max(0, Math.min(1, normalized)); // 0~1 클램핑
      
      const elevation = normalized * heightScale;
      positions[posIdx] = x - width / 2;
      positions[posIdx + 1] = elevation;
      positions[posIdx + 2] = y - height / 2;

      const hue = (1 - normalized) * 240;
      const color = getColorFromHue(hue);
      colors[posIdx] = color.r;
      colors[posIdx + 1] = color.g;
      colors[posIdx + 2] = color.b;
    }
  }

  positionAttr.needsUpdate = true;
  colorAttr.needsUpdate = true;

  maybeUpdateNormals(terrain.geometry);

  const endTime = performance.now();
  console.log(
    `⚡ 지형 업데이트 (최적화 - 폴백) - ${(endTime - startTime).toFixed(
      2
    )}ms | ${width}x${height}`
  );
}

// 기존 업데이트 함수 (하위 호환성)
function updateTerrain(newData) {
  if (PERF_CONFIG.useDirectPositionUpdate) {
    updateTerrainOptimized(newData);
  } else {
    const startTime = performance.now();
    const newGeometry = createTerrainGeometry(newData);

    if (terrain && terrain.geometry) {
      terrain.geometry.dispose();
      terrain.geometry = newGeometry;
    }

    const endTime = performance.now();
    console.log(
      `⚡ 지형 업데이트 (재생성) - ${(endTime - startTime).toFixed(2)}ms`
    );
  }
}

// ==========================================
// MQTT 핸들러 (Latest-wins + 쓰로틀링)
// ==========================================
function setupMQTTHandlers(client) {
  // MQTT 메시지 수신 시간 추적
  let lastMessageTime = null;
  let messageCount = 0;
  const messageTimestamps = [];

  // Latest-wins: 메시지 폭주 시 마지막 1개만 적용
  const decoder = new TextDecoder();
  let latestMessageText = null;
  let applyScheduled = false;
  
  // ✅ 처리 중 플래그 (Worker 완료 전 새 작업 방지)
  let isProcessing = false;
  let lastProcessTime = 0;
  const MIN_PROCESS_INTERVAL = 100; // 최소 100ms 간격 (최대 10fps)

  const scheduleApply = () => {
    if (applyScheduled) return;
    applyScheduled = true;

    requestAnimationFrame(() => {
      applyScheduled = false;
      if (!latestMessageText) return;
      
      // ✅ 쓰로틀링: 이전 처리 완료 전 또는 최소 간격 미달 시 스킵
      const now = performance.now();
      if (isProcessing || (now - lastProcessTime) < MIN_PROCESS_INTERVAL) {
        // 다음 프레임에 다시 시도
        if (latestMessageText) {
          applyScheduled = false;
          requestAnimationFrame(() => scheduleApply());
        }
        return;
      }

      const text = latestMessageText;
      latestMessageText = null;
      isProcessing = true;
      lastProcessTime = now;

      try {
        const raw = JSON.parse(text);

        // 데이터 형태 맞추기
        const terrainData =
          raw && Array.isArray(raw.data) && typeof raw.width === "number"
            ? raw
            : raw;

        if (!validateElevationData(terrainData)) {
          logError("❌ 고도 데이터 검증 실패");
          isProcessing = false;
          return;
        }

        updateTerrain(terrainData);
        
        // ✅ Worker 사용 시 비동기 완료, 아니면 즉시 완료
        if (!PERF_CONFIG.useParallelWorkers || workerPool.length === 0) {
          isProcessing = false;
        }
        // Worker 사용 시 onParallelProcessingComplete에서 isProcessing = false 처리
      } catch (e) {
        logError("❌ MQTT 메시지 파싱 오류:", e.message);
        isProcessing = false;
      }
    });
  };
  
  // ✅ 외부에서 처리 완료 알림 받을 수 있도록 노출
  setupMQTTHandlers.markProcessingComplete = () => {
    isProcessing = false;
  };

  client.on("message", (topic, message) => {
    const currentTime = Date.now();
    messageCount++;

    messageTimestamps.push(currentTime);
    if (messageTimestamps.length > 100) messageTimestamps.shift();

    if (lastMessageTime !== null) {
      const interval = currentTime - lastMessageTime;
      if (interval > 0) {
        const freq = (1000 / interval).toFixed(1);
        log(`📨 MQTT 수신: ${interval}ms 간격 (~${freq} msg/s)`);
      }
    }
    lastMessageTime = currentTime;

    latestMessageText = decoder.decode(message);
    scheduleApply();

    if (messageCount % 10 === 0) {
      const recent = messageTimestamps.length;
      if (recent >= 2) {
        const span = messageTimestamps[recent - 1] - messageTimestamps[0];
        const avg = span / (recent - 1);
        log(`📊 최근 ${recent}개 평균 간격: ${avg.toFixed(1)}ms`);
      }
    }
  });

  client.on("reconnect", () => log("🔄 MQTT 재연결 시도"));
  client.on("error", (err) => logError("❌ MQTT 오류:", err.message));
  client.on("close", () => log("🔌 MQTT 연결 종료"));

  setupMQTTHandlers.messageCount = () => messageCount;
  setupMQTTHandlers.messageTimestamps = messageTimestamps;
}

// MQTT 연결 함수
function connectMQTT() {
  // HTTPS/ngrok 환경 감지
  if (window.location.protocol === "https:") {
    if (window.location.hostname.includes("ngrok")) {
      console.log("🌐 ngrok 감지 - localStorage 설정 필요");
    }
  }

  mqttClient = mqtt.connect(MQTT_CONFIG.broker, MQTT_CONFIG.options);

  setupMQTTHandlers(mqttClient);

  mqttClient.on("connect", () => {
    console.log("✅ MQTT 연결");

    // ✅ 핵심 수정: connect 시 1회 subscribe (100ms 폴링 제거)
    mqttClient.subscribe(MQTT_CONFIG.topic, { qos: 0 }, (err) => {
      if (err) {
        logError("❌ 구독 실패:", err.message);
      } else {
        console.log("📡 구독 완료:", MQTT_CONFIG.topic);
      }
    });
  });
}

// 간소화된 고도 데이터 검증 함수
function validateElevationData(data) {
  if (!data || !data.width || !data.height || !Array.isArray(data.data))
    return false;

  const expectedLength = data.width * data.height;
  if (data.data.length !== expectedLength) return false;

  // 숫자 여부만 빠르게 확인 (샘플링)
  const arr = data.data;
  const step = Math.max(1, Math.floor(arr.length / 64));
  for (let i = 0; i < arr.length; i += step) {
    const v = arr[i];
    if (typeof v !== "number" || Number.isNaN(v)) return false;
  }

  return true;
}

// MQTT 연결 해제 함수
function disconnectMQTT() {
  if (mqttClient) {
    console.log("🔌 MQTT 연결 수동 해제 시도...");
    stopTerrainUpdateTimer();
    mqttClient.end(true, () => {
      console.log("✅ MQTT 연결 해제 완료");
    });
  }
}

// MQTT 연결 상태 확인 및 재연결 함수
function checkMQTTConnection() {
  if (!mqttClient) {
    console.log("❌ MQTT 클라이언트가 없음 - 재연결 시도");
    connectMQTT();
    return;
  }

  if (!mqttClient.connected) {
    console.log("❌ MQTT 연결 끊어짐 - 재연결 시도");
    if (!mqttClient.reconnecting) {
      mqttClient.reconnect();
    }
  } else {
    console.log("✅ MQTT 연결 정상");
  }
}

// 주기적 연결 상태 확인
setInterval(() => {
  checkMQTTConnection();
}, 60000);

// 페이지 로드 시 MQTT 연결
window.addEventListener("load", () => {
  connectMQTT();
});

// ==========================================
// 렌더 루프
// ==========================================
function animate() {
  renderer.setAnimationLoop(() => {
    renderer.render(scene, camera);
  });
}
animate();
