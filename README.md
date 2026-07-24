# livecopy

웹앱의 **카피(문구)를 렌더된 화면에서 직접 검수·수정**하고, 그 결과를 소스 코드에 반영하는 도구.
비개발자(대표·기획·클라이언트)가 실제 사이트에서 글자를 고치고, 개발자는 명령 한 줄로 반영한다.

- **프레임워크 무관 · 의존성 0** — 순수 DOM. React/Vue/Svelte/정적 사이트 어디든.
- **평상시 번들 영향 0** — `?edit` 쿼리일 때만 동적 로드.
- **검수자 경험 = URL 하나** — 설치·클릭 없음. `https://<사이트>/?edit=1` 열면 끝.

## 검수자가 하는 일

1. 받은 링크 열기 (`.../?edit=1`)
2. 화면의 글자·버튼 라벨 클릭 → 그 자리서 수정 (지우면 삭제)
3. 카드·글에 **💬 메모** 로 요청 남기기 ("여기 섹션 추가" 등)
4. 우하단 **JSON 다운로드** → 담당자에게 파일 전달

수정·메모는 자동 저장돼 새로고침·재방문에도 유지된다. 페이지 이동은 사이트 상단 메뉴로.

## 프로젝트에 추가 (개발자, 1회)

```bash
npm i -D github:goodsoo/livecopy
npx livecopy init        # 진입 파일에 ?edit 배선 자동 삽입
```

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

```bash
livecopy apply ~/Downloads/livecopy-copy-changes-2026-07-24.json
livecopy apply <file> --dry              # 미리보기
livecopy apply <file> --src frontend/src # 소스 경로 지정 (기본: client/src 또는 src 자동감지)
```

- `edits` — 옛 문구를 소스에서 찾아 자동 치환 (유일 매칭만). 중복/미발견은 위치 후보와 함께 수동 안내.
- `memos` — 자동 반영 안 함. 위치 후보 파일과 함께 **개발자 할일 체크리스트**로 출력.

반영 후 `git diff` 로 검토하고 커밋한다.

## JSON 형식

```json
{
  "edits": [{ "old": "...", "new": "...", "page": "/about", "nearHeading": "...", "tag": "P" }],
  "memos": [{ "anchorText": "...", "note": "...", "page": "/about", "tag": "DIV" }]
}
```

## 한계

- 편집 앵커가 "옛 문구"라, JSX 등으로 쪼개진 문구는 자동 치환 대신 후보 파일만 제시(수동).
- 보간 문구(`{name}님`)는 통짜 편집이 애매 — 리터럴 텍스트 위주.
- CSP 로 외부 스크립트를 막는 사이트에서도 `import` 방식(빌드 통합)이라 무관하게 동작.
