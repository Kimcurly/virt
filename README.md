# WebXR 프로젝트

이 프로젝트는 WebXR API와 three.js를 활용한 XR(AR/VR) 웹앱 예제입니다. MQTT를 통해 실시간 고도 데이터를 받아 3D 지형을 렌더링합니다.

## 주요 기술

- [Three.js](https://threejs.org/)
- [WebXR Device API](https://developer.mozilla.org/ko/docs/Web/API/WebXR_Device_API)
- [webxr-polyfill](https://github.com/immersive-web/webxr-polyfill)
- [MQTT.js](https://github.com/mqttjs/MQTT.js) - 실시간 데이터 통신

## 시작하기

1. 의존성 설치: `npm install`
2. MQTT 브로커 설정 (아래 참조)
3. 개발 서버 실행: `npm run dev`
4. 브라우저에서 `http://localhost:8080` 접속

## MQTT 설정

### 1. MQTT 브로커 준비

로컬 MQTT 브로커를 사용하려면 [Mosquitto](https://mosquitto.org/)를 설치하세요:

```bash
# macOS (Homebrew)
brew install mosquitto

# Ubuntu/Debian
sudo apt-get install mosquitto

# Windows는 공식 사이트에서 다운로드
```

Mosquitto 실행:

```bash
mosquitto -c /usr/local/etc/mosquitto/mosquitto.conf
```

### 2. MQTT 설정 파일 수정

`src/mqtt-config.js` 파일을 열어 브로커 설정을 변경하세요:

```javascript
export const MQTT_CONFIG = {
  broker: "ws://localhost:8080/mqtt", // 로컬 브로커
  // broker: "wss://your-broker.com:8081/mqtt", // 외부 브로커
  topic: "terrain/elevation", // 고도 데이터 토픽
  options: {
    username: "your-username", // 인증 필요 시
    password: "your-password", // 인증 필요 시
  },
};
```

### 3. 고도 데이터 전송

MQTT 클라이언트로 다음 형식의 JSON 데이터를 전송하세요:

```json
{
  "width": 10,
  "height": 8,
  "data": [0.1, 0.2, 0.3, ..., 0.8]
}
```

예시 (mosquitto_pub 사용):

```bash
mosquitto_pub -h localhost -t "terrain/elevation" -m '{"width": 10, "height": 8, "data": [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]}'
```

## 폴더 구조

- `src/` : 주요 소스 코드
- `public/` : 정적 파일 및 HTML
- `src/mqtt-config.js` : MQTT 설정 파일

## 참고

WebXR 기능은 지원되는 브라우저에서만 동작합니다. 최신 Chrome, Edge, Firefox를 권장합니다.
