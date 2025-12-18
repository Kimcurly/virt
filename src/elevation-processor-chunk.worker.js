/**
 * Web Worker: 고도 데이터 청크 처리 (별도 스레드)
 * 큰 데이터를 작은 청크로 나누어 병렬 처리
 */

// 색상 캐시 (Worker 내부)
const colorCache = new Map();

// HSL을 RGB로 변환
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

// 청크 처리
self.onmessage = function (event) {
  const { type, data } = event.data;

  if (type === "PROCESS_CHUNK") {
    const {
      width,
      height,
      elevationData,
      startIdx,
      endIdx,
      chunkId,
      minV,
      maxV,
      heightScale,
    } = data;

    try {
      const chunkSize = endIdx - startIdx;
      const positions = new Float32Array(chunkSize * 3);
      const colors = new Float32Array(chunkSize * 3);
      const denom = maxV - minV || 1;

      // ✅ elevationData는 "slice된 청크" (0..chunkSize-1)
      for (let i = startIdx; i < endIdx; i++) {
        const localIdx = i - startIdx;
        const posIdx = localIdx * 3;

        const y = Math.floor(i / width);
        const x = i % width;

        if (localIdx >= elevationData.length) continue;

        let v = elevationData[localIdx];
        if (!Number.isFinite(v)) v = minV;
        // ✅ 0~1 정규화 (클램핑 포함)
        let v01 = (v - minV) / denom;
        v01 = v01 < 0 ? 0 : (v01 > 1 ? 1 : v01);
        const elevation = v01 * heightScale;

        positions[posIdx] = x - width / 2;
        positions[posIdx + 1] = elevation;
        positions[posIdx + 2] = y - height / 2;

        const hue = (1 - v01) * 240;
        const color = getColorFromHue(hue);
        colors[posIdx] = color.r;
        colors[posIdx + 1] = color.g;
        colors[posIdx + 2] = color.b;
      }

      self.postMessage(
        {
          type: "CHUNK_COMPLETE",
          success: true,
          data: {
            positions: positions.buffer,
            colors: colors.buffer,
            chunkId,
            startIdx,
            endIdx,
          },
        },
        [positions.buffer, colors.buffer]
      );
    } catch (error) {
      self.postMessage({
        type: "CHUNK_ERROR",
        success: false,
        chunkId,
        error: error.message,
      });
    }
  }
};
