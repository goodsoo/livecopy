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

const PANEL_ID = "copy-editor-panel";

// 헤더(상단 네비) — 이동 전용이라 편집 대상에서 제외하고 클릭도 막지 않는다.
// 기본값 = 표준 랜드마크 + 임의 옵트인 훅. 사이트 헤더 선택자가 다르면
// initCopyEditor({ headerSelector }) 로 재정의하거나, 헤더 요소에 data-livecopy-header 를 단다.
let HEADER_SEL = 'header, [role="banner"], [data-livecopy-header]';

// 링크·버튼 등 클릭 시 동작이 있는 요소
const INTERACTIVE_SEL = 'a, button, [role="button"], [role="link"], summary';

// 편집 대상에서 제외할 태그
const EXCLUDE_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "SVG", "PATH", "IMG", "VIDEO", "AUDIO",
  "IFRAME", "CANVAS", "INPUT", "TEXTAREA", "SELECT", "OPTION", "HEAD",
  "META", "LINK", "TITLE",
]);

interface Change {
  old: string;
  new: string;
  page: string;
  nearHeading: string;
  tag: string;
  ts: number;
}

// 변경분은 localStorage 에 영구 저장한다 → 새로고침·탭이동·다음 세션에도 유지.
// 키는 페이지+옛문구 (data-ce-id 는 로드마다 재생성되므로 영구키로 못 씀).
// storagePrefix 는 initCopyEditor({ storagePrefix }) 로 프로젝트별 재정의 (기본 "livecopy").
let downloadPrefix = "livecopy";
let STORAGE_KEY = "livecopy-copy-edits";
const store = new Map<string, Change>(); // key = `${page}\n${old}`
let idSeq = 0;
let active = false; // 편집 모드 활성 여부 (teardown 후 예약된 스캔이 재-태깅 못 하게)
let scanTimer: number | undefined;

function storeKey(page: string, old: string): string {
  return `${page}\n${old}`;
}

function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    for (const c of JSON.parse(raw) as Change[]) store.set(storeKey(c.page, c.old), c);
  } catch {
    /* 손상된 저장값은 무시 */
  }
}

function saveStore() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(store.values())));
  } catch {
    /* 저장 실패는 무시 (편집은 계속 가능) */
  }
}

// ── 메모(핀) ──────────────────────────────────────────────
// 기존 텍스트 박스에 "요청 메모"를 붙인다. 앵커 = 그 박스의 원문(data-ce-orig)
// → grep 으로 파일·줄 위치가 잡히므로 개발자가 위치를 정확히 안다.
// 편집(자동 반영)과 달리 메모는 개발자 할일 체크리스트로 출력된다.
interface Memo {
  page: string;
  anchorText: string;
  note: string;
  tag: string;
  nearHeading: string;
  ts: number;
}
let MEMO_KEY = "livecopy-copy-memos";
const memos = new Map<string, Memo>(); // key = `${page}\n${anchorText}`

function loadMemos() {
  try {
    const raw = localStorage.getItem(MEMO_KEY);
    if (!raw) return;
    for (const m of JSON.parse(raw) as Memo[]) memos.set(storeKey(m.page, m.anchorText), m);
  } catch {
    /* 손상된 저장값은 무시 */
  }
}

function saveMemos() {
  try {
    localStorage.setItem(MEMO_KEY, JSON.stringify(Array.from(memos.values())));
  } catch {
    /* 무시 */
  }
}

// 메모는 텍스트 단위가 아니라 "카드 덩어리" 단위로 붙는다.
// 텍스트를 감싸는 가장 바깥 카드형 조상(둥근 모서리 + 배경/보더/그림자, 또는 article/li)을
// 찾고, 없으면(히어로·본문 문단 등) 텍스트 자신을 앵커로 쓴다.
const MEMO_BOUNDARY = "section, main, header, nav, footer, body";

function memoAnchorEl(el: HTMLElement): HTMLElement {
  let node: HTMLElement | null = el.parentElement;
  let best: HTMLElement | null = null;
  let depth = 0;
  while (node && depth < 7) {
    if (node === document.body || node.matches(MEMO_BOUNDARY)) break;
    const cs = getComputedStyle(node);
    const rounded = parseFloat(cs.borderTopLeftRadius) > 0;
    const bg =
      (cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent") ||
      cs.backgroundImage !== "none"; // 그라디언트/이미지 배경도 카드 신호
    const border = parseFloat(cs.borderTopWidth) > 0;
    const shadow = !!cs.boxShadow && cs.boxShadow !== "none";
    const cardTag = node.tagName === "ARTICLE" || node.tagName === "LI" || node.tagName === "FIGURE";
    if (cardTag || (rounded && (bg || border || shadow))) best = node; // 바깥 카드까지 계속 갱신
    node = node.parentElement;
    depth++;
  }
  return best || el;
}

// 앵커의 식별 텍스트 (저장 키 + 위치 힌트). 텍스트면 원문, 카드면 제목/첫 문구.
function memoAnchorText(anchorEl: HTMLElement): string {
  const orig = anchorEl.getAttribute("data-ce-orig");
  if (orig) return orig;
  const h = anchorEl.querySelector("h1,h2,h3,h4,h5,h6");
  if (h && (h.textContent || "").trim()) return (h.textContent || "").trim();
  const fe = anchorEl.querySelector("[data-ce-orig]");
  if (fe) return fe.getAttribute("data-ce-orig") || "";
  return (anchorEl.textContent || "").trim().slice(0, 80);
}

// 저장된 메모의 청록 링을 (카드 단위로) 복원한다.
function restoreMemoMarkers() {
  document.querySelectorAll(".ce-has-memo").forEach((el) => el.classList.remove("ce-has-memo"));
  for (const m of Array.from(memos.values())) {
    if (m.page !== location.pathname) continue;
    let match: HTMLElement | null = null;
    document.querySelectorAll<HTMLElement>("[data-ce-orig]").forEach((el) => {
      if (!match && el.getAttribute("data-ce-orig") === m.anchorText) match = el;
    });
    if (!match) {
      document.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6").forEach((h) => {
        if (!match && (h.textContent || "").trim() === m.anchorText) match = h;
      });
    }
    if (match) memoAnchorEl(match).classList.add("ce-has-memo");
  }
}

function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.getClientRects().length === 0) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== "hidden" && cs.display !== "none";
}

function nearestHeading(el: Element): string {
  // 위로 올라가며 형제/조상에서 가장 가까운 heading 텍스트를 찾아 반영 시 위치 힌트로 쓴다
  let node: Element | null = el;
  while (node) {
    let sib: Element | null = node;
    while (sib) {
      if (/^H[1-6]$/.test(sib.tagName)) return (sib.textContent || "").trim().slice(0, 60);
      sib = sib.previousElementSibling;
    }
    node = node.parentElement;
  }
  return "";
}

function qualifies(el: Element): boolean {
  if (EXCLUDE_TAGS.has(el.tagName)) return false;
  if (el.id === PANEL_ID || el.closest(`#${PANEL_ID}`)) return false;
  if (el.closest("#ce-memo-bar, #ce-memo-pop, #ce-memo-backdrop")) return false; // 메모 UI 제외
  if (el.closest(HEADER_SEL)) return false; // 헤더는 이동 전용 → 편집 안 함
  if (el.closest("[data-ce-id]")) return false; // 이미 편집 대상인 조상 안이면 skip
  if (!isVisible(el)) return false;

  const text = (el.textContent || "").replace(/\s+/g, " ").trim();
  if (!text) return false;

  // "한 문구"로 편집 가능하려면 자식 요소가 전부 인라인이어야 한다(블록 자식 = 컨테이너 → skip).
  // 판정은 태그 이름이 아니라 실제 computed display 로 한다 — <a>·<span> 이 display:flex/block 으로
  // 블록 카드로 쓰이면 inline 이 아니므로, 링크 카드 여러 개를 감싼 그리드가 통째로 잡히지 않는다.
  // 미디어(img/svg/video)는 버튼·링크가 아닌 한 항상 차단 → "사진+텍스트" 카드도 통째로 안 잡힘.
  const interactive = isInteractive(el);
  for (const child of Array.from(el.children)) {
    if (child.tagName === "BR" || child.tagName === "WBR") continue;
    const media =
      child instanceof SVGElement ||
      child.tagName === "IMG" || child.tagName === "VIDEO" ||
      child.tagName === "CANVAS" || child.tagName === "IFRAME";
    if (media) {
      if (interactive) continue; // 아이콘+라벨 버튼은 허용
      return false; // 컨텐츠 미디어 → 통째 편집 금지
    }
    const disp = getComputedStyle(child).display;
    if (!disp.startsWith("inline") && disp !== "contents") return false; // 블록형 자식 = 컨테이너
  }
  return true;
}

function isInteractive(el: Element): boolean {
  return !!el.closest(INTERACTIVE_SEL);
}

function tag(el: HTMLElement) {
  const id = `ce-${idSeq++}`;
  const orig = (el.innerText || "").trim();
  el.setAttribute("data-ce-id", id);
  el.setAttribute("data-ce-orig", orig);
  el.setAttribute("data-ce-heading", nearestHeading(el));
  el.contentEditable = "true";
  el.spellcheck = false;
  el.classList.add("ce-editable");
  if (isInteractive(el)) el.classList.add("ce-interactive");

  // 이전에 저장된 수정이 있으면 화면에 다시 반영 (새로고침·재방문 복원)
  const saved = store.get(storeKey(location.pathname, orig));
  if (saved && saved.new !== orig) {
    el.innerText = saved.new;
    el.classList.add("ce-changed");
    if (saved.new === "") el.classList.add("ce-emptied");
  }
  // 메모 마커는 카드 단위라 scan 후 restoreMemoMarkers() 가 일괄 복원한다.
}

// 본문의 버튼·링크는 클릭 시 동작(이동·제출) 대신 글자 편집이 되도록 막는다.
// 헤더(HEADER_SEL) 와 패널은 예외 — 그대로 클릭돼 페이지 이동에 쓰인다.
function onClickCapture(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (!target?.closest) return;
  if (target.closest(`#${PANEL_ID}`)) return;
  if (target.closest("#ce-memo-bar, #ce-memo-pop, #ce-memo-backdrop")) return; // 메모 UI 통과
  if (target.closest(HEADER_SEL)) return; // 헤더는 이동 허용
  if (target.closest(INTERACTIVE_SEL)) {
    e.preventDefault();
    e.stopPropagation(); // React onClick(wouter 이동 등)까지 차단
  }
}

function scan(root: ParentNode = document.body) {
  if (!active) return; // 종료된 뒤 예약된 스캔은 무시
  const els = root.querySelectorAll<HTMLElement>("*");
  els.forEach((el) => {
    if (el.hasAttribute("data-ce-id")) return;
    if (qualifies(el)) tag(el);
  });
  untagHeader(); // 리렌더 레이스로 헤더에 잘못 붙은 태그를 정리 (헤더는 이동 전용)
  restoreMemoMarkers(); // 저장된 메모의 청록 링을 카드 단위로 복원
  updatePanel();
}

// 헤더 안/자신에 (레이스로) 태깅된 요소를 편집 대상에서 되돌린다.
// HEADER_SEL 은 콤마 목록이라 문자열 조합 대신 closest() 로 판정한다.
function untagHeader() {
  document.querySelectorAll<HTMLElement>("[data-ce-id]").forEach((el) => {
    if (!el.closest(HEADER_SEL)) return;
    el.removeAttribute("data-ce-id");
    el.removeAttribute("data-ce-orig");
    el.removeAttribute("data-ce-heading");
    el.contentEditable = "inherit";
    el.classList.remove("ce-editable", "ce-interactive", "ce-changed");
  });
}

function onInput(e: Event) {
  const el = (e.target as HTMLElement)?.closest?.("[data-ce-id]") as HTMLElement | null;
  if (!el) return;
  const orig = el.getAttribute("data-ce-orig") || "";
  const current = (el.innerText || "").trim();
  const key = storeKey(location.pathname, orig);
  if (current === orig) {
    // 원문과 같아지면 변경 취소. 빈 문자열(완전 삭제)은 정당한 변경이므로 else 로 저장됨.
    store.delete(key);
    el.classList.remove("ce-changed", "ce-emptied");
  } else {
    store.set(key, {
      old: orig,
      new: current,
      page: location.pathname,
      nearHeading: el.getAttribute("data-ce-heading") || "",
      tag: el.tagName,
      ts: Date.now(),
    });
    el.classList.add("ce-changed");
    el.classList.toggle("ce-emptied", current === ""); // 완전 삭제 시 클릭 가능한 크기 유지
  }
  saveStore(); // 매 편집마다 영구 저장 → 새로고침/이동에도 유지
  updatePanel();
}

function onPaste(e: ClipboardEvent) {
  const el = (e.target as HTMLElement)?.closest?.("[data-ce-id]");
  if (!el) return;
  e.preventDefault();
  const text = e.clipboardData?.getData("text/plain") ?? "";
  document.execCommand("insertText", false, text); // 서식 없이 평문만 붙여넣기
}

function buildJson(): string {
  const edits = Array.from(store.values())
    .sort((a, b) => a.page.localeCompare(b.page) || b.ts - a.ts)
    .map(({ old, new: nw, page, nearHeading, tag }) => ({ old, new: nw, page, nearHeading, tag }));
  const memoList = Array.from(memos.values())
    .sort((a, b) => a.page.localeCompare(b.page) || b.ts - a.ts)
    .map(({ anchorText, note, page, nearHeading, tag }) => ({ anchorText, note, page, nearHeading, tag }));
  return JSON.stringify({ edits, memos: memoList }, null, 2);
}

function download() {
  const json = buildJson();
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `${downloadPrefix}-copy-changes-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

let panel: HTMLElement | null = null;
let countEl: HTMLElement | null = null;

function updatePanel() {
  if (!countEl) return;
  countEl.textContent = String(store.size);
  const memoCountEl = panel?.querySelector("[data-ce-memocount]");
  if (memoCountEl) memoCountEl.textContent = String(memos.size);
  const total = store.size + memos.size;
  const dl = panel?.querySelector<HTMLButtonElement>("[data-ce-dl]");
  if (dl) dl.disabled = total === 0;
  const reset = panel?.querySelector<HTMLButtonElement>("[data-ce-reset]");
  if (reset) reset.disabled = total === 0;
}

function buildPanel() {
  panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <span style="font-weight:600;font-size:14px;">✏️ 문구 편집</span>
      <button data-ce-exit title="편집 모드 끄기" style="
        border:0;border-radius:6px;cursor:pointer;background:#3f3f46;color:#e4e4e7;
        font-size:11px;padding:4px 8px;">편집 종료 ✕</button>
    </div>
    <ul style="margin:0 0 10px;padding-left:16px;font-size:12px;line-height:1.7;color:#d4d4d8;">
      <li>글자·버튼 클릭해 수정 (지우면 삭제)</li>
      <li>추가·요청은 글 위 <b>💬</b> 눌러 메모</li>
      <li>이동은 <b>상단 메뉴</b>로 · 자동 저장</li>
    </ul>
    <div style="font-size:12px;margin-bottom:8px;">
      수정 <span data-ce-count style="font-weight:700;color:#fde047;">0</span>건 ·
      메모 <span data-ce-memocount style="font-weight:700;color:#5eead4;">0</span>건
    </div>
    <button data-ce-dl disabled style="
      width:100%;padding:9px 12px;border:0;border-radius:6px;cursor:pointer;
      background:#fde047;color:#111;font-weight:600;font-size:13px;
    ">JSON 다운로드</button>
    <button data-ce-reset disabled style="
      width:100%;margin-top:6px;padding:6px 12px;border:0;border-radius:6px;cursor:pointer;
      background:transparent;color:#a1a1aa;font-size:11px;text-decoration:underline;
    ">전체 초기화</button>
  `;
  Object.assign(panel.style, {
    position: "fixed",
    right: "16px",
    bottom: "16px",
    width: "220px",
    padding: "14px",
    background: "#18181b",
    color: "#fff",
    borderRadius: "10px",
    boxShadow: "0 8px 30px rgba(0,0,0,.35)",
    zIndex: "2147483647",
    fontFamily: "system-ui, sans-serif",
  } as CSSStyleDeclaration);
  document.body.appendChild(panel);
  countEl = panel.querySelector("[data-ce-count]");
  panel.querySelector("[data-ce-exit]")!.addEventListener("click", teardownCopyEditor);
  panel.querySelector("[data-ce-dl]")!.addEventListener("click", download);
  panel.querySelector("[data-ce-reset]")!.addEventListener("click", () => {
    if (!window.confirm("저장된 모든 수정·메모를 지울까요? 되돌릴 수 없습니다.")) return;
    store.clear();
    memos.clear();
    saveStore();
    saveMemos();
    document.querySelectorAll(".ce-changed").forEach((el) => {
      const orig = el.getAttribute("data-ce-orig");
      if (orig != null) (el as HTMLElement).innerText = orig; // 원문 복원
      el.classList.remove("ce-changed", "ce-emptied");
    });
    document.querySelectorAll(".ce-has-memo").forEach((el) => el.classList.remove("ce-has-memo"));
    closeMemo();
    updatePanel();
  });
}

// ── 메모 UI: hover 시 뜨는 [메모][되돌리기] 바 + 중앙 모달 ──────────────
let memoBar: HTMLElement | null = null; // [메모][되돌리기] 를 담는 클러스터
let memoBtn: HTMLButtonElement | null = null;
let undoBtn: HTMLButtonElement | null = null;
let memoPop: HTMLElement | null = null;
let memoBackdrop: HTMLElement | null = null;
let memoHoverEl: HTMLElement | null = null; // 현재 hover 로 잡힌 앵커(카드/텍스트)
let memoTargetEl: HTMLElement | null = null; // 모달이 편집 중인 앵커
let memoHideTimer: number | undefined;
let prevBodyOverflow = "";

// 말풍선 아이콘(lucide MessageSquare) + 되돌리기 아이콘(lucide RotateCcw)
const MEMO_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
const UNDO_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>';

// 앵커(카드/텍스트) 범위 안의 편집 대상들
function scopeTargets(el: HTMLElement): HTMLElement[] {
  return el.hasAttribute("data-ce-id")
    ? [el]
    : Array.from(el.querySelectorAll<HTMLElement>("[data-ce-id]"));
}

function scopeHasEdits(el: HTMLElement): boolean {
  return scopeTargets(el).some((t) => {
    const orig = t.getAttribute("data-ce-orig");
    return orig != null && store.has(storeKey(location.pathname, orig));
  });
}

// 앵커 범위의 수정을 전부 원문으로 되돌린다.
function revertScope(el: HTMLElement) {
  let changed = false;
  for (const t of scopeTargets(el)) {
    const orig = t.getAttribute("data-ce-orig");
    if (orig == null) continue;
    if (store.delete(storeKey(location.pathname, orig))) {
      t.innerText = orig;
      t.classList.remove("ce-changed", "ce-emptied");
      changed = true;
    }
  }
  if (changed) {
    saveStore();
    updatePanel();
  }
}

function positionMemoBar(el: HTMLElement) {
  if (!memoBar) return;
  // 되돌리기 버튼은 되돌릴 수정이 있을 때만 노출
  if (undoBtn) undoBtn.style.display = scopeHasEdits(el) ? "inline-flex" : "none";
  memoBar.style.display = "inline-flex";
  const w = memoBar.offsetWidth || 120;
  const h = memoBar.offsetHeight || 26;
  const r = el.getBoundingClientRect();
  // 박스 "바깥" 위쪽에 붙인다 (작은 박스를 가려 클릭을 막지 않도록). 위 공간 없으면 아래로.
  let top = r.top - h - 4;
  if (top < 4) top = r.bottom + 4;
  const left = Math.min(window.innerWidth - w - 4, Math.max(4, r.right - w));
  memoBar.style.top = `${top}px`;
  memoBar.style.left = `${left}px`;
}

function onMemoMouseOver(e: MouseEvent) {
  const t = e.target as HTMLElement;
  if (!t?.closest) return;
  if (memoBackdrop?.style.display === "block") return; // 모달 열려있으면 바 안 뜸
  if (memoBar?.contains(t) || memoPop?.contains(t)) {
    window.clearTimeout(memoHideTimer);
    return;
  }
  const textEl = t.closest<HTMLElement>(".ce-editable");
  if (textEl) {
    window.clearTimeout(memoHideTimer);
    memoHoverEl = memoAnchorEl(textEl); // 카드 덩어리(없으면 텍스트 자신) 단위로 앵커
    positionMemoBar(memoHoverEl);
  }
}

function onMemoMouseOut() {
  window.clearTimeout(memoHideTimer);
  memoHideTimer = window.setTimeout(() => {
    if (memoBar) memoBar.style.display = "none";
  }, 350);
}

function openMemo(anchorEl: HTMLElement) {
  if (!memoPop || !memoBackdrop) return;
  memoTargetEl = anchorEl;
  const text = memoAnchorText(anchorEl);
  const existing = memos.get(storeKey(location.pathname, text));
  memoPop.querySelector<HTMLElement>("[data-ce-anchor]")!.textContent =
    text.slice(0, 60) + (text.length > 60 ? "…" : "");
  const ta = memoPop.querySelector<HTMLTextAreaElement>("textarea")!;
  ta.value = existing?.note || "";
  memoPop.querySelector<HTMLButtonElement>("[data-ce-memo-del]")!.style.display = existing ? "block" : "none";
  memoBackdrop.style.display = "block";
  memoPop.style.display = "block";
  if (memoBar) memoBar.style.display = "none";
  prevBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden"; // 뒤 화면 스크롤 잠금
  ta.focus();
}

function closeMemo() {
  if (memoPop) memoPop.style.display = "none";
  if (memoBackdrop) memoBackdrop.style.display = "none";
  document.body.style.overflow = prevBodyOverflow; // 스크롤 복원
  memoTargetEl = null;
}

function saveMemo() {
  if (!memoTargetEl || !memoPop) return;
  const el = memoTargetEl;
  const text = memoAnchorText(el);
  const key = storeKey(location.pathname, text);
  const note = memoPop.querySelector<HTMLTextAreaElement>("textarea")!.value.trim();
  if (!note) {
    memos.delete(key);
    el.classList.remove("ce-has-memo");
  } else {
    memos.set(key, {
      page: location.pathname,
      anchorText: text,
      note,
      tag: el.tagName,
      nearHeading: el.getAttribute("data-ce-heading") || text,
      ts: Date.now(),
    });
    el.classList.add("ce-has-memo");
  }
  saveMemos();
  updatePanel();
  closeMemo();
}

function buildMemoUI() {
  // [메모][되돌리기] 클러스터
  memoBar = document.createElement("div");
  memoBar.id = "ce-memo-bar";
  Object.assign(memoBar.style, {
    position: "fixed", display: "none", gap: "4px", zIndex: "2147483646",
    fontFamily: "system-ui, sans-serif",
  } as CSSStyleDeclaration);

  const barBtnStyle = {
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "4px",
    height: "24px", padding: "0 8px", border: "0", borderRadius: "6px",
    color: "#fff", fontSize: "11px", fontWeight: "600", lineHeight: "1",
    cursor: "pointer", boxShadow: "0 2px 8px rgba(0,0,0,.3)",
  } as CSSStyleDeclaration;

  memoBtn = document.createElement("button");
  memoBtn.id = "ce-memo-btn";
  memoBtn.type = "button";
  memoBtn.title = "이 카드/글에 메모·요청 남기기";
  memoBtn.innerHTML = `${MEMO_ICON}<span>메모</span>`;
  Object.assign(memoBtn.style, { ...barBtnStyle, background: "#0f766e" });
  memoBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (memoHoverEl) openMemo(memoHoverEl);
  });

  undoBtn = document.createElement("button");
  undoBtn.id = "ce-undo-btn";
  undoBtn.type = "button";
  undoBtn.title = "이 카드/글의 수정을 원문으로 되돌리기";
  undoBtn.innerHTML = `${UNDO_ICON}<span>되돌리기</span>`;
  Object.assign(undoBtn.style, { ...barBtnStyle, background: "#57534e", display: "none" });
  undoBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (memoHoverEl) {
      revertScope(memoHoverEl);
      positionMemoBar(memoHoverEl); // 되돌린 뒤 버튼 상태 갱신(없으면 숨김)
    }
  });

  memoBar.appendChild(memoBtn);
  memoBar.appendChild(undoBtn);
  document.body.appendChild(memoBar);

  // 배경 차단막: 뒤 화면 클릭 차단 + 바깥 클릭 시 닫기 (스크롤은 body overflow 로 잠금)
  memoBackdrop = document.createElement("div");
  memoBackdrop.id = "ce-memo-backdrop";
  Object.assign(memoBackdrop.style, {
    position: "fixed", inset: "0", display: "none",
    background: "rgba(0,0,0,.45)", zIndex: "2147483646",
  } as CSSStyleDeclaration);
  memoBackdrop.addEventListener("click", closeMemo);
  memoBackdrop.addEventListener("wheel", (e) => e.preventDefault(), { passive: false });
  document.body.appendChild(memoBackdrop);

  memoPop = document.createElement("div");
  memoPop.id = "ce-memo-pop";
  memoPop.innerHTML = `
    <div style="font-weight:600;font-size:14px;margin-bottom:8px;">💬 메모 / 요청</div>
    <div style="font-size:11px;color:#a1a1aa;margin-bottom:8px;">위치: “<span data-ce-anchor></span>”</div>
    <textarea placeholder="예: 이 카드 아래에 도입 사례 섹션 추가해주세요" style="
      width:100%;height:90px;resize:vertical;box-sizing:border-box;padding:9px;
      border:1px solid #3f3f46;border-radius:6px;background:#27272a;color:#fff;
      font-size:13px;font-family:inherit;"></textarea>
    <div style="display:flex;gap:6px;margin-top:10px;">
      <button data-ce-memo-save style="flex:1;padding:8px;border:0;border-radius:6px;cursor:pointer;background:#14b8a6;color:#052e2b;font-weight:600;font-size:13px;">저장</button>
      <button data-ce-memo-del style="padding:8px 10px;border:0;border-radius:6px;cursor:pointer;background:#3f3f46;color:#fca5a5;font-size:13px;display:none;">삭제</button>
      <button data-ce-memo-close style="padding:8px 10px;border:0;border-radius:6px;cursor:pointer;background:transparent;color:#a1a1aa;font-size:13px;">닫기</button>
    </div>
  `;
  Object.assign(memoPop.style, {
    position: "fixed", display: "none", left: "50%", top: "50%",
    transform: "translate(-50%, -50%)", width: "340px", maxWidth: "calc(100vw - 32px)",
    padding: "16px", background: "#18181b", color: "#fff", borderRadius: "12px",
    border: "1px solid #14b8a6", boxShadow: "0 12px 40px rgba(0,0,0,.5)",
    zIndex: "2147483647", fontFamily: "system-ui, sans-serif",
  } as CSSStyleDeclaration);
  document.body.appendChild(memoPop);
  memoPop.querySelector("[data-ce-memo-save]")!.addEventListener("click", saveMemo);
  memoPop.querySelector("[data-ce-memo-close]")!.addEventListener("click", closeMemo);
  memoPop.querySelector("[data-ce-memo-del]")!.addEventListener("click", () => {
    memoPop!.querySelector<HTMLTextAreaElement>("textarea")!.value = "";
    saveMemo();
  });

  document.addEventListener("mouseover", onMemoMouseOver, true);
  document.addEventListener("mouseout", onMemoMouseOut, true);
  document.addEventListener("keydown", onEscKeydown);
}

function onEscKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && memoBackdrop?.style.display === "block") closeMemo();
}

// 편집 모드 완전 종료 — 리로드/URL 조작에 의존하지 않고 그 자리서 해제한다.
let observerRef: MutationObserver | null = null;
function teardownCopyEditor() {
  active = false;
  window.clearTimeout(scanTimer); // 대기 중인 debounce 스캔 취소
  observerRef?.disconnect();
  observerRef = null;
  document.removeEventListener("input", onInput, true);
  document.removeEventListener("paste", onPaste, true);
  document.removeEventListener("click", onClickCapture, true);
  document.removeEventListener("mouseover", onMemoMouseOver, true);
  document.removeEventListener("mouseout", onMemoMouseOut, true);
  document.removeEventListener("keydown", onEscKeydown);

  // 편집 대상 원문 복원 + 태그 해제 (수정·메모는 localStorage 에 보존됨 → 재진입 시 복원)
  document.querySelectorAll<HTMLElement>("[data-ce-id]").forEach((el) => {
    const orig = el.getAttribute("data-ce-orig");
    if (orig != null) el.innerText = orig;
    el.removeAttribute("data-ce-id");
    el.removeAttribute("data-ce-orig");
    el.removeAttribute("data-ce-heading");
    el.contentEditable = "inherit";
    el.classList.remove("ce-editable", "ce-interactive", "ce-changed", "ce-emptied", "ce-has-memo");
  });

  panel?.remove();
  memoBar?.remove();
  memoPop?.remove();
  memoBackdrop?.remove();
  document.getElementById("ce-styles")?.remove();
  document.body.style.overflow = prevBodyOverflow;
  panel = memoBar = memoPop = memoBackdrop = null;
  countEl = null;
  memoBtn = undoBtn = null;

  // URL 에서 edit 제거 (리로드 없이) → 이후 새로고침해도 편집모드로 재진입하지 않음
  try {
    const u = new URL(location.href);
    u.searchParams.delete("edit");
    history.replaceState(null, "", u.toString());
  } catch {
    /* ignore */
  }
  // eslint-disable-next-line no-console
  console.info("[copy-editor] 편집 모드 종료");
}

function injectStyles() {
  const style = document.createElement("style");
  style.id = "ce-styles";
  style.textContent = `
    .ce-editable:hover { outline: 1px dashed rgba(59,130,246,.7); outline-offset: 2px; cursor: text; }
    .ce-editable.ce-interactive:hover { outline-color: rgba(168,85,247,.8); } /* 본문 버튼·링크는 보라 힌트 */
    .ce-editable:focus { outline: 2px solid #3b82f6; outline-offset: 2px; }
    .ce-changed { background: rgba(253,224,71,.35) !important; box-shadow: 0 0 0 2px rgba(253,224,71,.5); border-radius: 2px; }
    /* 완전히 지운 박스: 원문을 취소선으로 흐리게 표시해 크기를 유지 → 클릭·hover 가능 */
    .ce-emptied { display: inline-block; min-width: 40px; min-height: 1em; }
    .ce-emptied::after { content: attr(data-ce-orig); opacity: .15; text-decoration: line-through; pointer-events: none; }
    /* 메모 달린 카드/박스 = 청록 링 (outline 이라 카드 자체 그림자를 안 덮음) */
    .ce-has-memo { outline: 2px solid rgba(20,184,166,.8); outline-offset: 2px; }
    #ce-memo-btn:hover { background: #0d5f58 !important; }
    #ce-undo-btn:hover { background: #44403c !important; }
    #${PANEL_ID} button:disabled { opacity: .5; cursor: default; }
  `;
  document.head.appendChild(style);
}

export interface CopyEditorConfig {
  /** 헤더(이동 전용, 편집 제외) 선택자. 기본: header, [role=banner], [data-livecopy-header] */
  headerSelector?: string;
  /** localStorage 키·다운로드 파일명 접두. 프로젝트마다 다르게 (기본 "livecopy") */
  storagePrefix?: string;
}

export function initCopyEditor(config: CopyEditorConfig = {}) {
  if (document.getElementById(PANEL_ID)) return; // 중복 방지
  if (config.headerSelector) HEADER_SEL = config.headerSelector;
  if (config.storagePrefix) {
    downloadPrefix = config.storagePrefix;
    STORAGE_KEY = `${config.storagePrefix}-copy-edits`;
    MEMO_KEY = `${config.storagePrefix}-copy-memos`;
  }
  active = true;
  loadStore(); // 이전 세션 수정 복원
  loadMemos(); // 이전 세션 메모 복원
  injectStyles();
  buildPanel();
  buildMemoUI();

  document.addEventListener("input", onInput, true);
  document.addEventListener("paste", onPaste, true);
  document.addEventListener("click", onClickCapture, true);

  // React 최초 렌더 후 스캔
  setTimeout(() => scan(), 800);

  // 라우트 이동·지연 렌더로 새 콘텐츠가 붙으면 다시 스캔 (자기 변경으로 인한 루프는 debounce+disconnect 로 방지)
  observerRef = new MutationObserver(() => {
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(() => {
      observerRef?.disconnect();
      scan();
      observerRef?.observe(document.body, { childList: true, subtree: true });
    }, 400);
  });
  observerRef.observe(document.body, { childList: true, subtree: true });

  // eslint-disable-next-line no-console
  console.info("[copy-editor] 문구 편집 모드 활성화됨");
}
