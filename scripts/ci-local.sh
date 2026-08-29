#!/bin/bash
# ─────────────────────────────────────────────────────────────
# scripts/ci-local.sh
#
# 本地 CI 验证脚本 — 在 push 前模拟 GitHub Actions CI 全流程。
# 按照 .github/workflows/ci.yml 的 job 顺序依次执行，
# 在本地捕获绝大多数 CI 失败场景，避免 push 后才发现。
#
# 用法:
#   bash scripts/ci-local.sh          # 运行全部检查
#   bash scripts/ci-local.sh --quick  # 快速模式（跳过 e2e + docs）
#
# 退出码:
#   0 — 所有检查通过
#   1 — 存在失败项
#
# 对应 CI Jobs:
#   0. version-check     → bash scripts/check-version-sync.sh
#   1. lint-typecheck     → typecheck + public type contracts + build
#   2. unit-tests         → vitest run test/unit
#   3. integration-tests  → npm run build + vitest run test/integration
#   4. e2e-tests          → vitest run test/e2e
#   5. format-check       → npm run format:check
#   6. docs-build         → cd website && npm run build
#
# @see .github/workflows/ci.yml
# ─────────────────────────────────────────────────────────────

set -euo pipefail

# ── 配置 ────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

QUICK_MODE=false
if [[ "${1:-}" == "--quick" ]]; then
  QUICK_MODE=true
fi

# ── 颜色定义 ────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# ── 辅助函数 ────────────────────────────────────────────────

ERRORS=0
TOTAL=0
SKIPPED=0
STEP_START=0

step_start() {
  local step_name="$1"
  TOTAL=$((TOTAL + 1))
  STEP_START=$(date +%s)
  echo ""
  echo -e "${CYAN}${BOLD}── [${TOTAL}] ${step_name} ──────────────────────────────${NC}"
}

step_pass() {
  local elapsed=$(( $(date +%s) - STEP_START ))
  echo -e "${GREEN}✅ 通过${NC} (${elapsed}s)"
}

step_fail() {
  local elapsed=$(( $(date +%s) - STEP_START ))
  echo -e "${RED}❌ 失败${NC} (${elapsed}s)"
  ERRORS=$((ERRORS + 1))
}

step_skip() {
  echo -e "${YELLOW}⏭️  跳过${NC} (--quick 模式)"
  SKIPPED=$((SKIPPED + 1))
}

# ── 开始 ────────────────────────────────────────────────────

TOTAL_START=$(date +%s)
echo -e "${BOLD}🔍 vext 本地 CI 验证${NC}"
echo "──────────────────────────────────────────"
if $QUICK_MODE; then
  echo -e "${YELLOW}⚡ 快速模式：跳过 e2e-tests 和 docs-build${NC}"
fi
echo ""

# ── 0. Version Channel Check ────────────────────────────────

step_start "Version Channel Check"
# Keep one version-contract implementation for local CI and GitHub Actions.
# Later steps already require Node.js/npx, so a separate grep-based copy only
# creates drift when documentation paths or README version policy change.
if bash scripts/check-version-sync.sh; then
  step_pass
else
  step_fail
fi

# ── 1. Lint + Typecheck ─────────────────────────────────────

step_start "TypeScript Type Check"
if npm run typecheck; then
  step_pass
else
  step_fail
fi

step_start "Public Type Contract Tests"
if npm run test:types; then
  step_pass
else
  step_fail
fi

step_start "Build (ESM + CJS)"
if npm run build; then
  step_pass
else
  step_fail
fi

# ── 2. Unit Tests ───────────────────────────────────────────

step_start "Unit Tests"
if npx vitest run test/unit --reporter=verbose; then
  step_pass
else
  step_fail
fi

# ── 3. Integration Tests ───────────────────────────────────

step_start "Integration Tests"
if npx vitest run test/integration --reporter=verbose; then
  step_pass
else
  step_fail
fi

# ── 4. E2E Tests ───────────────────────────────────────────

step_start "E2E Tests"
if $QUICK_MODE; then
  step_skip
else
  if npx vitest run test/e2e --reporter=verbose; then
    step_pass
  else
    step_fail
  fi
fi

# ── 5. Format Check ────────────────────────────────────────

step_start "Prettier Format Check"
if npm run format:check; then
  step_pass
else
  step_fail
fi

# ── 6. Docs Build ──────────────────────────────────────────

step_start "Docs Build (website)"
if $QUICK_MODE; then
  step_skip
else
  if [ -d "website" ] && [ -f "website/package.json" ]; then
    (cd website && npm ci --silent && npm run build)
    if [ $? -eq 0 ]; then
      step_pass
    else
      step_fail
    fi
  else
    echo -e "${YELLOW}⚠️  website/ 目录不存在，跳过${NC}"
    SKIPPED=$((SKIPPED + 1))
  fi
fi

# ── 汇总 ────────────────────────────────────────────────────

TOTAL_ELAPSED=$(( $(date +%s) - TOTAL_START ))
PASSED=$((TOTAL - ERRORS - SKIPPED))

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BOLD}📊 本地 CI 结果汇总${NC}  (${TOTAL_ELAPSED}s)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "  通过: ${GREEN}${PASSED}${NC}"
echo -e "  失败: ${RED}${ERRORS}${NC}"
echo -e "  跳过: ${YELLOW}${SKIPPED}${NC}"
echo -e "  总计: ${TOTAL}"
echo ""

if [ "$ERRORS" -gt 0 ]; then
  echo -e "${RED}${BOLD}❌ 本地 CI 未通过 — 请修复后再 push${NC}"
  exit 1
else
  echo -e "${GREEN}${BOLD}✅ 本地 CI 全部通过 — 可以安全 push${NC}"
  exit 0
fi
