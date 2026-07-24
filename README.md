# livecopy

웹앱의 **카피(문구)를 렌더된 화면에서 직접 검수·수정**하고, 그 결과를 소스 코드에 반영하는 도구.
비개발자(대표·기획·클라이언트)가 실제 사이트에서 글자를 고치고, 개발자는 명령 한 줄로 반영한다.

- **프레임워크 무관 · 의존성 0** — 순수 DOM. React/Vue/Svelte/정적 사이트 어디든.
- **평상시 번들 영향 0** — `?edit` 쿼리일 때만 동적 로드.
- **검수자 경험 = URL 하나** — 설치·클릭 없음. `https://<사이트>/?edit=1` 열면 끝.

## 전체 흐름 (한눈에)

```
[개발자] 1회 세팅        [검수자] 링크만            [개발자] 명령 하나
─────────────────       ──────────────────        ────────────────────
npm i + livecopy init    …/?edit=1 열기             npx livecopy apply changes.json
   → ?edit 배선          글자 수정 · 💬 메모    →    → edits 자동 치환
                         JSON 다운로드              → git diff 검토 후 커밋
                              │
                              └──── JSON 파일 전달 ────┘
```

1. **개발자**가 프로젝트에 1회 세팅 (아래 "프로젝트에 추가").
2. **검수자**가 배포된 사이트를 `?edit=1` 로 열어 고치고, **JSON 다운로드** 버튼으로 파일을 받아 담당자에게 전달.
3. **개발자**가 그 JSON 을 `npx livecopy apply` 로 소스에 반영하고 커밋.

## 검수자가 하는 일

1. 받은 링크 열기 (`https://<사이트>/?edit=1`)
2. 화면의 글자·버튼 라벨 클릭 → 그 자리서 수정 (완전히 지우면 삭제로 표시)
3. 카드·글에 **💬 메모** 로 요청 남기기 ("여기 아래 사례 섹션 추가해주세요" 등)
4. 우하단 패널의 **JSON 다운로드** → 담당자에게 파일 전달

수정·메모는 자동 저장돼 새로고침·탭이동·재방문에도 유지된다. 페이지 이동은 사이트 상단 메뉴로.

## 프로젝트에 추가 (개발자, 1회)

```bash
npm i -D github:goodsoo/livecopy
npx livecopy init        # 진입 파일에 ?edit 배선 자동 삽입
```

> 빌드 산출물(dist)이 repo 에 포함돼 있어 **설치 후 별도 빌드가 필요 없다** (npm 이 install 스크립트를 차단하는 환경에서도 동작).

`init` 이 진입 파일(`src/main.tsx` 등)을 찾아 아래를 넣는다:

```ts
if (new URLSearchParams(window.location.search).has("edit")) {
  import("livecopy").then((m) => m.initCopyEditor({ storagePrefix: "<프로젝트명>" }));
}
```

수동으로 넣어도 된다. 옵션:

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `storagePrefix` | `"livecopy"` | localStorage 키·다운로드 파일명 접두 (프로젝트마다 고유하게) |
| `headerSelector` | `'header, [role="banner"], [data-livecopy-header]'` | 편집 제외·클릭 통과할 헤더(이동 전용). 헤더에 `data-livecopy-header` 를 달거나 직접 선택자 지정 |

## 변경분 반영 (개발자)

받은 JSON 을 **해당 프로젝트 repo 안에서** 실행한다 (git 으로 소스를 훑음):

```bash
npx livecopy apply ~/Downloads/onephai-copy-changes-2026-07-24.json --dry   # ① 먼저 미리보기
npx livecopy apply ~/Downloads/onephai-copy-changes-2026-07-24.json          # ② 실제 반영
```

옵션:

| 옵션 | 설명 |
|------|------|
| `--dry` | 파일을 바꾸지 않고 무엇이 반영될지 미리보기 (먼저 돌려보길 권장) |
| `--src <dir>` | 소스 디렉토리 지정. 미지정 시 `client/src` → `src` 순으로 자동 감지 |

동작:

- **`edits`** — 각 "옛 문구" 를 소스에서 찾아 "새 문구" 로 **자동 치환**한다. 단, **정확히 한 곳**에서만 발견될 때만. 여러 곳/0곳이면 건너뛰고 위치 후보와 함께 수동 안내(JSX 로 쪼개진 헤드라인 등).
- **`memos`** — 자동 반영하지 않는다. 위치 후보 파일과 함께 **개발자 할일 체크리스트**로 출력(섹션 추가·이미지 교체 등은 사람이 판단·구현).

출력 예시:

```
=== 반영 결과 · src=client/src ===

✅ 자동 반영 2건
  [client/src/pages/About.tsx]
    - 우리는 로봇을 만듭니다
    + 우리는 미래를 만듭니다

⚠️  수동 처리 1건 (0곳/중복)
  "Physical AI가 세상을 바꾼다는데…" → "…"  (0곳: client/src/pages/Home.tsx (단어 7))

📌 메모/요청 1건 (자동 반영 안 됨 — 개발자 처리)
  • [/aepr] "AEPR 소개…" 근처
    → 이 카드 아래에 협력 사례 섹션 추가
    위치 후보: client/src/pages/Aepr.tsx
```

반영 후 반드시 **`git diff` 로 검토**하고 커밋한다.

## JSON 형식

`?edit` 오버레이가 다운로드하는 파일 구조:

```json
{
  "edits": [
    { "old": "옛 문구", "new": "새 문구", "page": "/about", "nearHeading": "섹션 제목", "tag": "P" }
  ],
  "memos": [
    { "anchorText": "카드 제목/앵커 문구", "note": "요청 내용", "page": "/about", "tag": "DIV" }
  ]
}
```

- 구형(플랫 배열 `[ ... ]`)도 `edits` 로 간주해 하위 호환.
- `apply` 는 `page`·`nearHeading`·`tag` 를 위치 힌트로만 쓰고, 반영 앵커는 `old`(edits)/`anchorText`(memos) 다.

## 동작 원리 (요약)

- **편집 앵커 = 옛 문구.** 소스에 소스맵/태깅을 심지 않고, 반영 시 옛 문구를 grep 치환한다 → 빌드 파이프라인 불필요.
- **메모 앵커 = 카드 덩어리.** 텍스트를 감싸는 카드형 컨테이너(computed display 로 감지)에 붙어, 카드 내부 개별 줄마다 붙지 않는다.
- **영구 저장.** 모든 편집·메모는 `localStorage`(키 접두 = `storagePrefix`)에 저장 → 새로고침·재방문에도 유지·복원.
- **`?edit` 없으면 로드 안 됨.** 동적 import 라 일반 사용자 번들엔 포함되지 않는다.

## 한계

- 편집 앵커가 "옛 문구"라, JSX 등으로 **쪼개진 문구**는 자동 치환 대신 후보 파일만 제시(수동 반영).
- **보간 문구**(`{name}님`)는 통짜 편집이 애매 — 리터럴 텍스트 위주.
- 같은 문구가 **여러 곳**에 있으면 자동 치환하지 않고 수동 안내(오치환 방지).
- 동적 데이터(목록·DB 콘텐츠)는 고정 카피가 아니므로 대상이 아니다.

## 개발

```bash
npm run build   # src/overlay.ts → dist (tsc). dist 는 커밋됨.
```

`src/overlay.ts` 수정 후엔 `npm run build` 로 dist 를 갱신해 함께 커밋한다.
