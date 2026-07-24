#!/usr/bin/env node
/**
 * livecopy CLI
 *
 *   livecopy init                      → 앱 진입 파일에 ?edit 배선 3줄 자동 삽입
 *   livecopy apply <changes.json>      → 받은 JSON 의 edits 를 소스에 반영, memos 는 체크리스트 출력
 *   livecopy apply <file> --dry        → 미리보기 (파일 안 바꿈)
 *   livecopy apply <file> --src <dir>  → 소스 디렉토리 지정 (기본: client/src 또는 src 자동감지)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { basename } from "node:path";

const [, , cmd, ...rest] = process.argv;

function detectSrc(flags) {
  const eq = flags.find((f) => f.startsWith("--src="));
  if (eq) return eq.slice("--src=".length);
  const i = flags.indexOf("--src");
  if (i !== -1 && flags[i + 1]) return flags[i + 1];
  if (existsSync("client/src")) return "client/src";
  if (existsSync("src")) return "src";
  return null;
}

// ── init: 진입 파일에 ?edit 배선 삽입 ──────────────────────────
function init() {
  const candidates = [
    "src/main.tsx", "src/main.ts", "src/main.jsx", "src/main.js",
    "src/index.tsx", "src/index.ts", "src/index.jsx", "src/index.js",
    "client/src/main.tsx", "client/src/main.ts",
    "app/main.tsx", "app/entry-client.tsx",
  ];
  const entry = candidates.find((f) => existsSync(f));
  if (!entry) {
    console.error("✗ 진입 파일을 못 찾음. 아래 3줄을 직접 진입 파일에 추가하세요:\n");
    console.error(snippet(basename(process.cwd())));
    process.exit(1);
  }
  const content = readFileSync(entry, "utf8");
  if (content.includes("livecopy")) {
    console.log(`✓ 이미 배선됨: ${entry}`);
    return;
  }
  const prefix = basename(process.cwd());
  const wired = content.trimEnd() + "\n\n" + snippet(prefix) + "\n";
  writeFileSync(entry, wired);
  console.log(`✓ ${entry} 에 ?edit 배선 추가 (storagePrefix: "${prefix}")`);
  console.log(`  → 배포 후 <URL>?edit=1 로 편집 오버레이 활성화`);
}

function snippet(prefix) {
  return `// livecopy: ?edit 쿼리일 때만 카피 편집 오버레이 로드 (평상시 번들 영향 0)
if (new URLSearchParams(window.location.search).has("edit")) {
  import("livecopy").then((m) => m.initCopyEditor({ storagePrefix: "${prefix}" }));
}`;
}

// ── apply: JSON 을 소스에 반영 ────────────────────────────────
function apply() {
  const jsonPath = rest.find((a) => !a.startsWith("--"));
  const DRY = rest.includes("--dry");
  const SRC = detectSrc(rest);
  if (!jsonPath) {
    console.error("사용법: livecopy apply <changes.json> [--dry] [--src <dir>]");
    process.exit(1);
  }
  if (!SRC) {
    console.error("✗ 소스 디렉토리를 못 찾음. --src <dir> 로 지정하세요.");
    process.exit(1);
  }

  const parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
  const edits = Array.isArray(parsed) ? parsed : parsed.edits || [];
  const memoList = Array.isArray(parsed) ? [] : parsed.memos || [];

  const files = execSync(`git ls-files ${SRC}`, { encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.(tsx?|jsx?|vue|svelte|astro|html)$/.test(f));
  const fileCache = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));

  const applied = [];
  const skipped = [];
  const candidatesFor = (text) => {
    const tokens = (text || "").split(/[\s.,!?·…"'()<>]+/).filter((t) => t.length >= 2);
    return files
      .map((f) => [f, tokens.filter((t) => fileCache.get(f).includes(t)).length])
      .filter(([, n]) => n >= Math.max(2, Math.ceil(tokens.length / 2)))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
  };

  for (const c of edits) {
    if (!c.old || c.new == null || c.old === c.new) continue;
    const hits = [];
    for (const [f, content] of fileCache) {
      let idx = content.indexOf(c.old);
      while (idx !== -1) {
        hits.push({ f });
        idx = content.indexOf(c.old, idx + 1);
      }
    }
    if (hits.length === 1) {
      const f = hits[0].f;
      fileCache.set(f, fileCache.get(f).split(c.old).join(c.new));
      applied.push({ ...c, file: f });
    } else {
      const cands =
        hits.length === 0
          ? candidatesFor(c.old).map(([f, n]) => `${f} (단어 ${n})`)
          : [...new Set(hits.map((h) => h.f))];
      skipped.push({ ...c, hitCount: hits.length, files: cands });
    }
  }

  if (!DRY) for (const [f, content] of fileCache) writeFileSync(f, content);

  console.log(`\n=== 반영 결과 ${DRY ? "(DRY RUN)" : ""} · src=${SRC} ===`);
  console.log(`\n✅ 자동 반영 ${applied.length}건`);
  for (const a of applied) console.log(`  [${a.file}]\n    - ${a.old}\n    + ${a.new}`);

  if (skipped.length) {
    console.log(`\n⚠️  수동 처리 ${skipped.length}건 (0곳/중복)`);
    for (const s of skipped) {
      console.log(`  "${s.old}" → "${s.new}"  (${s.hitCount}곳${s.files.length ? `: ${s.files.join(", ")}` : ""})`);
    }
  }

  if (memoList.length) {
    console.log(`\n📌 메모/요청 ${memoList.length}건 (자동 반영 안 됨 — 개발자 처리)`);
    for (const m of memoList) {
      const cands = candidatesFor(m.anchorText).map(([f]) => f);
      console.log(`  • [${m.page}] "${(m.anchorText || "").slice(0, 40)}" 근처\n    → ${m.note}`);
      if (cands.length) console.log(`    위치 후보: ${cands.join(", ")}`);
    }
  }

  console.log(`\n다음: git diff 로 검토 후 커밋하세요.\n`);
}

// ── dispatch ──────────────────────────────────────────────
switch (cmd) {
  case "init":
    init();
    break;
  case "apply":
    apply();
    break;
  default:
    console.log(`livecopy — 카피 검수 오버레이

  livecopy init                  진입 파일에 ?edit 배선 추가
  livecopy apply <json> [--dry]  받은 JSON 을 소스에 반영 (--src <dir> 로 경로 지정)
`);
}
