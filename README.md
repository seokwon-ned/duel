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

### 서버 E2E 테스트

#### 대역폭 시뮬레이션 (150초 풀 매치)

```bash
npm run sim:bandwidth
```

- 3000틱이 정확히 실행되는지 검증
- 서버 틱 간격 정확도 측정 (1분간 99% 이상이 50±5ms 이내)
- 플레이어당 대역폭 측정

#### 재접속 테스트 (자동화 E2E)

```bash
npm run test:reconnection
```

테스트 항목:
- ✅ 재접속 시 동일한 틱/위치 유지
- ✅ 2회 짧은 연결 끊김 허용
- ✅ 3번째 연결 끊김 시 패배
- ✅ 총 30초 초과 시 패배
- ✅ 29초는 허용 (경계값 테스트)
- ✅ 양쪽 모두 끊김 시 무효
- ✅ 재접속 플레이어는 동일한 플레이어 번호 유지
- ✅ 상대방 화면에 카운트다운 표시

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

1. Xcode → Preferences → Components → "Additional Tools for Xcode" 다운로드
2. `/Applications/Xcode.app/Contents/Applications/Network Link Conditioner.prefPane` 열기
3. 프로필 설정:
   - Profile: Custom
   - Downlink: Bandwidth 1000 kbps, Delay 100ms, Packet Loss 5%
   - Uplink: Bandwidth 1000 kbps, Delay 100ms, Packet Loss 5%
4. "Turn On" 활성화

#### 방법 2: dnctl + pfctl (고급)

포트 2567만 대상으로:

```bash
# Dummynet 파이프 생성
sudo dnctl pipe 1 config delay 200 plr 0.05

# PF 규칙 파일 생성
echo "dummynet in proto tcp from any to any port 2567 pipe 1" | sudo pfctl -f -

# 활성화
sudo pfctl -e

# 비활성화
sudo pfctl -d
```

### Linux

`tc netem` 사용:

```bash
# 지연 200ms, 손실 5% 추가
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

- **Colyseus 0.15+**: 방 기반 멀티플레이어
- **틱 레이트**: 20Hz (50ms)
- **델타 동기화**: 머리 위치와 변경된 칸만 전송
- **대역폭 로깅**: 플레이어당 bytes/sec 콘솔 출력

## 재접속 기능 (v1.1)

### 작동 방식

1. **세션 기반 플레이어 식별**
   - 플레이어 번호(1 또는 2)는 세션 ID에 바인딩됨
   - 재접속 시 동일한 플레이어 번호 및 상태 복원

2. **연결 끊김 처리**
   - 연결 끊김 시 서버 틱 즉시 정지
   - 남은 시간과 위치가 그대로 유지됨
   - 상대방 화면에 카운트다운 표시

3. **제한 사항**
   - 판당 최대 2회 연결 끊김 허용
   - 총 30초까지 연결 끊김 허용
   - 3번째 끊김 또는 30초 초과 시 즉시 패배
   - 양쪽 모두 끊김 시 판 무효 (전적 미반영)

4. **클라이언트 측**
   - 재접속 토큰을 localStorage에 저장
   - 앱 재실행 시 "진행 중인 대전으로 돌아가기" 버튼 표시
   - 판 종료 후 토큰 자동 삭제

### 로컬 테스트 방법

재접속 기능은 실제 네트워크 끊김 상황에서 테스트해야 합니다:

#### 방법 1: E2E 자동화 테스트 (권장)

```bash
npm run test:reconnection
```

자동화된 8개 시나리오 실행 (~2분 소요):
- 재접속 시 상태 유지, 2회 끊김 허용, 3회 끊김 패배, 시간 제한 등

#### 방법 2: 수동 네트워크 끊김 시뮬레이션

1. 서버 실행:
   ```bash
   npm run server
   ```

2. 두 개의 브라우저 탭에서 접속:
   ```
   http://localhost:3000
   ```

3. 네트워크 끊김 시뮬레이션:
   - **Chrome DevTools**: Network 탭 → Offline 선택
   - **Firefox**: File → Work Offline
   - **실제 네트워크**: Wi-Fi 끄기/켜기

4. 재접속:
   - 네트워크를 다시 활성화하면 자동으로 재접속 시도
   - reconnectionToken을 사용하여 동일한 방에 재입장

#### 방법 3: 비행기 모드 (모바일)

1. 모바일 기기에서 앱 실행
2. 대전 중 비행기 모드 활성화
3. 2~5초 대기
4. 비행기 모드 비활성화
5. 앱으로 돌아가면 "진행 중인 대전으로 돌아가기" 표시

## 다음 단계 (v1.2+)

- [ ] 로비/매칭 시스템
- [ ] Capacitor 앱 빌드 (Android/iOS)
- [ ] 터치 드래그 조작 (20px 임계값, 입력 버퍼)
- [ ] 랭크 시스템
- [ ] AWS Lightsail 배포

## 기술 스택

- **엔진**: TypeScript (순수 로직, 프레임워크 무관)
- **서버**: Node.js, Colyseus, Express
- **클라이언트**: Phaser 3, Vite
- **모바일**: Capacitor (계획)
- **테스트**: Vitest

## 색상 스펙

- 내 땅: `#FF7A1A` (오렌지)
- 상대 땅: `#2F6BFF` (파랑)
- 배경: `#0F172A` (다크 네이비)

## 라이선스

MIT
