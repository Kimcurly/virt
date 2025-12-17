// MQTT 설정 파일
// 프로토콜별 MQTT 브로커 설정

export const MQTT_CONFIG = {
  // 동적 브로커 URL 선택 (프로토콜 기반)
  get broker() {
    // HTTPS 페이지에서는 WSS (WebSocket Secure) 필수
    if (window.location.protocol === "https:") {
      // ngrok HTTPS 환경
      if (window.location.hostname.includes("ngrok")) {
        console.log("🌐 ngrok HTTPS 환경 감지 - WSS 프로토콜 사용");
        // ngrok TCP 터널을 WSS로 연결
        // 예: wss://0.tcp.ngrok.io:19641
        const ngrokHost =
          localStorage.getItem("ngrok_mqtt_host") || "localhost";
        const ngrokPort = localStorage.getItem("ngrok_mqtt_port") || "9001";
        return `wss://${ngrokHost}:${ngrokPort}`;
      }

      // 일반 HTTPS 환경
      console.log("🔒 HTTPS 환경 감지 - WSS 프로토콜 사용");
      return `wss://192.168.27.92:3000`;
    }

    // HTTP 페이지에서는 WS (WebSocket) 사용
    console.log("🏠 HTTP 환경 (로컬) - WS 프로토콜 사용");
    return `ws://192.168.27.92:3000`;
  },

  // 고도 데이터 토픽
  topic: "sandbox/digitaltwin",

  // 연결 옵션
  options: {
    clientId: `webxr-client-${Math.random().toString(16).substr(2, 8)}`,
    username: "", // MQTT 브로커 사용자명 (필요 시)
    password: "", // MQTT 브로커 비밀번호 (필요 시)
    clean: true,
    connectTimeout: 5000, // 연결 타임아웃 5초 (단축)
    reconnectPeriod: 500, // 재연결 주기 0.5초 (단축)
    keepalive: 60, // 60초마다 keepalive 패킷 전송
    reschedulePings: true, // ping 재스케줄링 활성화
    queueQoSZero: false, // QoS 0 메시지 큐잉 비활성화
    protocolVersion: 4, // MQTT v3.1.1

    // 메시지 수신 성능 최적화
    rejectUnauthorized: false,
    will: undefined, // will 메시지 비활성화

    // WebSocket 및 네트워크 최적화
    incomingStore: null, // 메시지 저장 비활성화 (QoS 0)
    outgoingStore: null, // 송신 메시지 저장 비활성화

    // 콜백 처리 최적화
    maxPacketSize: 65535, // 최대 패킷 크기

    // 메시지 배치 비활성화 (즉시 처리)
    batchSize: 1, // 한 번에 1개 메시지씩 처리
  },
};
