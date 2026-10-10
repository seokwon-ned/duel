# 땅따 | Turf Duel v1.1

1v1 실시간 영토 확장 게임 (Paper.io 스타일)

## 프로젝트 구조

```
packages/
├── engine/          # 공용 TypeScript 게임 엔진 (결정론적)
├── bot/            # AI 봇 (easy/normal/hard)
├── server/         # Colyseus 서버 (20Hz 틱)
└── client/         # Phaser 웹 클라이언트
docs/
├── requirements.md  # v1.1 확정 요구사항
├── qa-checklist.md # QA 테스트 체크리스트
└── ux.md           # UX 스펙 (화면 흐름, 결과 이유 문구)
```

## 빠른 시작

### 1. 설치

```bash
npm install
```

### 2. 로컬 서버 실행 (한 줄)

```bash
npm run server
```

서버가 `0.0.0.0:2567`에서 시작됩니다.

### 3. 웹 클라이언트 실행

별도 터미널에서:

```bash
cd packages/client
npm run dev
```

브라우저에서 `http://localhost:3000` 접속 후:
- **온라인 모드**: 두 개의 탭을 열고 "Connect to Server" 클릭
- **봇 모드**: "Play vs Bot" 클릭 (오프라인 가능)

조작: 화살표 키 또는 WASD

## 테스트

### 엔진 및 봇 테스트

```bash
npm test
```

각 패키지별 테스트:

```bash
cd packages/engine && npm test
cd packages/bot && npm test
```

### 테스트 커버리지

엔진 테스트는 QA 체크리스트의 모든 판정 규칙을 커버합니다:

| QA 체크리스트 항목 | 테스트 케이스 |
|---|---|
| 선이 끊김 | `선이 끊김 - Player 2 cuts Player 1 trail` |
| 내 선을 밟음 | `내 선을 밟음 - Player steps on own trail outside territory` |
| 벽에 부딪힘 | `벽에 부딪힘 - Player hits wall` |
| 동시 충돌 (정면) | `동시 충돌 - Head-on collision` |
| 동시 충돌 (벽) | `동시 충돌 - Both hit walls same tick` |
| 동시 컷 | `동시 컷 - Simultaneous trail cut` |
| 돌아오면서 끊김 | `같은 틱에 돌아오기 vs 끊기 - Returner loses` |
| 내 땅 안 자기 선 | `내 땅 안에서는 자기 선을 밟아도 패배 아님` |
| 상대 선 감쌈 | `감싼 영역 안 상대 선 - Opponent trail inside enclosure survives` |
| 땅 동률 | `땅 동률 - Territory tie at time up` |
| 시간 종료 승리 | `시간 종료 승리 - Time up win` |
| 정반대 입력 무시 | `정반대 입력 무시 - Opposite direction input ignored` |
| 입력 버퍼 1개 | `입력 버퍼 1개 - Fast input sequence does not suicide` |
| 결정론 | `결정론 - Determinism: same log twice yields identical result` |

봇 테스트:
- 각 난이도가 불법 이동을 하지 않음
- 난이도 순서대로 승률이 높음 (easy < normal < hard)

## 모바일 테스트 (Android)

### 로컬 서버에 연결

#### macOS에서:

1. **Mac의 LAN IP 찾기**:
   ```bash
   ipconfig getifaddr en0
   ```
   예: `192.168.1.100`

2. **방화벽 설정**: 
   - 서버 첫 실행 시 macOS가 "Node가 들어오는 네트워크 연결을 수신하려고 합니다"라고 물으면 **"허용"** 클릭
   - 수동 설정: 시스템 설정 → 네트워크 → 방화벽 → 옵션에서 Node.js 허용

3. **안드로이드 폰 연결**:
   - 폰과 Mac이 같은 Wi-Fi에 연결되어 있어야 함
   - 개발 빌드 설치 후 설정에서 서버 주소 입력: `192.168.1.100:2567`

#### Windows에서:

1. **PC의 LAN IP 찾기**:
   ```cmd
   ipconfig
   ```
   "IPv4 주소" 확인 (예: `192.168.1.100`)

2. **방화벽 설정**:
   - Windows Defender 방화벽 → 고급 설정 → 인바운드 규칙
   - 새 규칙: TCP 포트 2567 허용

3. **안드로이드 폰 연결**:
   - 개발 빌드에서 서버 주소: `192.168.1.100:2567`

#### Linux에서:

```bash
hostname -I  # LAN IP 확인
sudo ufw allow 2567/tcp  # 방화벽 허용
```

### Capacitor 설정 (향후 작업)

#### 디버그 빌드 (cleartext ws:// 허용)

`android/app/src/debug/res/xml/network_security_config.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>
</network-security-config>
```

`android/app/src/debug/AndroidManifest.xml`:

```xml
<application
    android:networkSecurityConfig="@xml/network_security_config"
    ...>
```

#### 릴리스 빌드 (ws:// 차단, wss://만 허용)

`android/app/src/main/res/xml/network_security_config.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="false">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>
</network-security-config>
```

릴리스 빌드에서는 클라이언트 코드에서 서버 주소 입력란을 숨기고 고정된 `wss://` URL만 사용합니다.

## 네트워크 지연/손실 시뮬레이션

QA 테스트용 (200ms 지연 / 5% 손실)

### macOS

#### 방법 1: Network Link Conditioner (권장)

1. Xcode → Settings → Downloads → Components → "Additional Tools for Xcode" 다운로드
2. `/Applications/Xcode.app/Contents/Applications/Network Link Conditioner.prefPane` 더블클릭하여 설치
3. 시스템 설정 → Network Link Conditioner 열기
4. 프로필 설정:
   - Profile: Custom
   - Downlink: Bandwidth 1000 kbps, Delay 100ms, Packet Loss 5%
   - Uplink: Bandwidth 1000 kbps, Delay 100ms, Packet Loss 5%
   - (양방향 100ms씩 = 총 200ms RTT)
5. "Turn On" 활성화
6. 테스트 완료 후 "Turn Off" 또는 시스템 재부팅

#### 방법 2: dnctl + pfctl (고급)

포트 2567만 대상으로:

```bash
# Dummynet 파이프 생성 (200ms 지연, 5% 손실)
sudo dnctl pipe 1 config delay 200 plr 0.05

# PF 규칙 추가
echo "dummynet in proto tcp from any to any port 2567 pipe 1" | sudo pfctl -f -

# 활성화
sudo pfctl -e

# 비활성화
sudo pfctl -d
```

### Linux

`tc netem` 사용:

```bash
# 지연 200ms, 손실 5% 추가 (loopback)
sudo tc qdisc add dev lo root netem delay 200ms loss 5%

# 제거
sudo tc qdisc del dev lo root
```

특정 포트만 (iptables + tc):

```bash
sudo iptables -A OUTPUT -p tcp --dport 2567 -j MARK --set-mark 1
sudo tc qdisc add dev eth0 root handle 1: prio
sudo tc filter add dev eth0 protocol ip parent 1:0 prio 1 handle 1 fw flowid 1:1
sudo tc qdisc add dev eth0 parent 1:1 handle 10: netem delay 200ms loss 5%

# 제거
sudo iptables -D OUTPUT -p tcp --dport 2567 -j MARK --set-mark 1
sudo tc qdisc del dev eth0 root
```

### Windows

**Clumsy** 사용:

1. [Clumsy](https://jagt.github.io/clumsy/) 다운로드 (관리자 권한 필요)
2. Filter: `tcp.DstPort == 2567 or tcp.SrcPort == 2567`
3. Functions:
   - Lag: 체크, 200ms
   - Drop: 체크, Inbound/Outbound 5%
4. Start 클릭
5. 테스트 완료 후 Stop 클릭

## 대역폭 측정

실제 WebSocket 트래픽을 확인하여 네트워크 사용량을 모니터링할 수 있습니다.

### 브라우저 DevTools에서 확인

1. 클라이언트 실행 (`cd packages/client && npm run dev`)
2. 브라우저에서 `http://localhost:3000` 열기
3. **DevTools 열기** (F12 또는 우클릭 → "검사")
4. **Network 탭** 선택
5. **WS 필터** 클릭 (WebSocket만 표시)
6. "Connect to Server" 클릭하여 게임 시작
7. WebSocket 연결 클릭 → **Messages 탭**에서 실시간 메시지 확인
8. 각 메시지의 크기(Bytes)와 시간(Time) 확인 가능

### 서버 측 측정

실제 WebSocket 바이트 측정 (`npm run sim:bandwidth`로 실행):

**측정 결과 (150초 매치, 실제 프레임 바이트, lossless grid sync):**
- **평균**: 309 bytes/sec (~0.30 KB/s) per player
- **P95**: 509 bytes/sec (~0.50 KB/s) per player
- **피크**: 11,752 bytes/sec (~11.48 KB/s) per player (initial grid + periodic full sync)
- **총 데이터**: ~46 KB per player per 150s match (~90 KB total)

Colyseus Schema의 델타 인코딩 + 전체 grid sync로 무손실 동기화를 제공하며, 평균 대역폭은 여전히 1 KB/s 미만입니다.

```bash
# E2E 테스트 + 실제 대역폭 측정 + assertions
npm run sim:bandwidth
```

**측정 방법:**
- 실제 WebSocket `message` 이벤트에서 바이트 카운트
- Colyseus @colyseus/schema 5.0.36 delta encoding
- 20Hz tick rate, 150초 실시간 매치
- 영토 확장 패턴 (2x2 → 15x15 growing loops)
- 매 초마다 샘플링하여 avg/P95/peak 계산
- Full grid (40×40 cells) synced every tick for lossless state under latency

## 게임 엔진 설계

### 결정론 (Deterministic)

- 순수 함수: `step(state, inputs) → { state, events }`
- 벽시계 시간 없음, `Math.random()` 없음 (봇에서만 시드된 RNG 사용)
- 동일한 입력 로그 → 항상 동일한 결과

### 서브틱 이동

- 8 cells/s at 20 ticks/s = **0.4 cells/tick**
- 매 틱마다 `movementAccumulator`에 0.4 누적
- 1.0 이상이 되면 한 칸 이동, 1.0 차감

### 틱 순서

1. **이동**: 두 플레이어 동시 이동
2. **충돌/컷 판정**: 벽, 자기 선, 상대 선, 정면 충돌
3. **영토 닫기**: 자기 영토로 돌아온 경우 flood fill로 영역 계산

## 서버 아키텍처

- **Colyseus 0.18**: 방 기반 멀티플레이어 (@colyseus/core 0.18.18)
- **틱 레이트**: 20Hz (50ms)
- **델타 동기화**: 머리 위치와 변경된 칸만 전송 (@colyseus/schema 5.0)
- **대역폭**: ~0.22 KB/s per player average (measured from real WebSocket frames)

## 다음 단계 (v1.2+)

- [ ] 로비/매칭 시스템
- [ ] 재접속 로직 (틱 정지, 30초 타임아웃)
- [ ] Capacitor 앱 빌드 (Android/iOS)
  - Android launcher icon: `assets/brand/icon_1024.png` 사용 예정
  - iOS launcher icon: `assets/brand/icon_1024.png` 사용 예정
- [ ] 터치 드래그 조작 (20px 임계값, 입력 버퍼)
- [ ] 랭크 시스템
- [ ] AWS Lightsail 배포

## 브랜드 에셋

앱 아이콘, 로고, 브랜드 가이드라인은 `assets/brand/` 참조.

- **앱 아이콘**: 4×4 그리드 디자인 (오렌지/파랑 영토, 다크 네이비 배경)
- **로고**: 한글(Black Han Sans) + 영문(Press Start 2P) 워드마크
- **웹 클라이언트**: favicon, apple-touch-icon, PWA manifest 아이콘 적용됨
- **Capacitor**: Android/iOS 런처 아이콘은 `icon_1024.png`에서 생성 (앱 셸 추가 시)

상세 정보: `assets/brand/README.md`

## 기술 스택

- **엔진**: TypeScript (순수 로직, 프레임워크 무관)
- **서버**: Node.js, Colyseus 0.18, Express
- **클라이언트**: Phaser 3, Vite, @colyseus/sdk 0.18
- **모바일**: Capacitor (계획)
- **테스트**: Vitest

## 색상 스펙

- 내 땅: `#FF7A1A` (오렌지)
- 상대 땅: `#2F6BFF` (파랑)
- 배경: `#0F172A` (다크 네이비)

## 라이선스

MIT
