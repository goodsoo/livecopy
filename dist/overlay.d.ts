/**
 * livecopy — 카피 검수 오버레이 (프레임워크 무관, 의존성 0)
 *
 * `?edit=1` 로 페이지를 열면 활성화된다. 검수자가 화면의 텍스트를 그 자리에서 고치고,
 * 카드·글에 요청 메모를 남기고, 패널의 "JSON 다운로드" 로 변경분을 파일로 받는다.
 * 받은 JSON 은 `livecopy apply <file>` 로 소스에 반영한다.
 *
 * 설계 메모:
 *  - 순수 DOM(React 등 비의존). 변경·메모는 localStorage 에 영구 저장 → 새로고침·탭이동·다음
 *    세션에도 유지되고, 재방문 시 화면에도 이전 수정이 다시 반영된다.
 *  - 편집 앵커는 "옛 문구". 반영 시 소스에서 옛 문구를 grep 치환 → 소스 태깅 빌드 불필요.
 *  - 메모 앵커는 "카드 덩어리"(computed display 로 감지) 또는 텍스트 자신.
 *  - `?edit` 이 없으면 이 모듈은 동적 import 되지 않아 평상시 번들 영향 0.
 *
 * 사용: initCopyEditor(config) 로 활성화. 프로젝트별 값만 주입한다.
 *    initCopyEditor({ storagePrefix: "myapp", headerSelector: 'header, [role="banner"]' })
 */
export interface CopyEditorConfig {
    /** 헤더(이동 전용, 편집 제외) 선택자. 기본: header, [role=banner], [data-livecopy-header] */
    headerSelector?: string;
    /** localStorage 키·다운로드 파일명 접두. 프로젝트마다 다르게 (기본 "livecopy") */
    storagePrefix?: string;
}
export declare function initCopyEditor(config?: CopyEditorConfig): void;
