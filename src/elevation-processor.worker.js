/**
 * Web Worker: 고도 데이터 처리 (별도 스레드)
 * MQTT 데이터를 geometry 배열로 변환하는 무거운 작업을 오프로드
 */

// 색상 캐시 (Worker 내부)
const colorCache = new Map();

// HSL을 RGB로 변환 (Worker 내부 구현)
function hslToRgb(h, s, l) {
  h = h / 360;
  s = s / 100;
  l = l / 100;

  let r, g, b;

  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }

  return {
    r: Math.round(r * 255) / 255,
    g: Math.round(g * 255) / 255,
    b: Math.round(b * 255) / 255,
  };
}

// 색상 캐시에서 가져오기
function getColorFromHue(hue) {
  const key = Math.round(hue);
  if (!colorCache.has(key)) {
    const rgb = hslToRgb(key, 100, 50);
    colorCache.set(key, rgb);
  }
  return colorCache.get(key);
}

// Worker 메시지 수신
self.onmessage = function (event) {
  const { type, data } = event.data;

  if (type === "PROCESS_ELEVATION") {
    const startTime = performance.now();
    const { width, height, elevationData, isRecreate } = data;

    try {
      const positions = new Float32Array(width * height * 3);
      const colors = new Float32Array(width * height * 3);

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = y * width + x;
          const posIdx = idx * 3;

          if (posIdx + 2 >= positions.length || idx >= elevationData.length) {
            continue;
          }

          const elevation = elevationData[idx] * 3;
          positions[posIdx] = x - width / 2;
          positions[posIdx + 1] = elevation;
          positions[posIdx + 2] = y - height / 2;

          const hue = (1 - elevationData[idx]) * 240;
          const color = getColorFromHue(hue);
          colors[posIdx] = color.r;
          colors[posIdx + 1] = color.g;
          colors[posIdx + 2] = color.b;
        }
      }

      const endTime = performance.now();
      const processingTime = endTime - startTime;

      self.postMessage(
        {
          type: "PROCESSING_COMPLETE",
          success: true,
          data: {
            positions: positions.buffer,
            colors: colors.buffer,
            width,
            height,
            processingTime,
            isRecreate,
          },
        },
        [positions.buffer, colors.buffer]
      );
    } catch (error) {
      self.postMessage({
        type: "PROCESSING_ERROR",
        success: false,
        error: error.message,
      });
    }
  }
};
