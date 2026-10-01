# SymFlowAge - Agent Contextual Planner & Guardrail Engine

> **Lớp quản trị ngữ cảnh cho AI Agent: phân rã mục tiêu thành vi bước 5-15 phút, chấm điểm Goal Drift / Rabbit Hole bằng vector embedding, chặn quyết định lệch hướng và cung cấp RAG grounded qua REST / MCP. Giao diện Solo Developer là client tham chiếu.**

[![React](https://img.shields.io/badge/React-19.0-blue.svg)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![Gemini API](https://img.shields.io/badge/Google%20GenAI-SDK-orange.svg)](https://ai.google.dev/)
[![Drizzle ORM](https://img.shields.io/badge/Drizzle%20ORM-pgvector-green.svg)](https://orm.drizzle.team/)
[![License](https://img.shields.io/badge/Copyright-©%202026%20Lê%20Quang%20Huy-purple.svg)](#-tác-giả--bản-quyền)

## 📖 Mục Lục

1. [Tổng quan](#-tổng-quan)
2. [Guardrail ngữ nghĩa (Semantic Drift)](#-guardrail-ngữ-nghĩa-semantic-drift)
3. [Đã triển khai](#-đã-triển-khai)
4. [Chi phí & định giá](#-chi-phí--định-giá)
5. [Quickstart](#-quickstart)
6. [Tính năng](#-tính-năng)
7. [Tech stack & cấu trúc](#-tech-stack--cấu-trúc)
8. [API](#-api)
9. [Circuit Breaker & MCP](#-circuit-breaker--mcp)
10. [Gemini Resilience](#-gemini-resilience)
11. [Cài đặt & biến môi trường](#-cài-đặt--biến-môi-trường)
12. [Kiểm thử](#-kiểm-thử)
13. [Tác giả & bản quyền](#-tác-giả--bản-quyền)

---

## 🎯 Tổng Quan

SymFlowAge giải quyết hai vấn đề của kỹ sư, Solo Developer và Indie Hacker:

1. **Analysis Paralysis**: dự án lớn làm quá tải nhận thức, không bắt đầu được bước đầu tiên.
2. **Goal Drift & Rabbit Holes**: sa đà over-engineering, tối ưu sớm, chỉnh UI… và xa mục tiêu ship sản phẩm.

Mọi tác vụ được phân rã theo 6 nguyên lý: **Divide & Conquer** (đơn vị ≤ 15 phút), **Atomic Commit**, **Fail Fast** (phép thử < 3 phút), **Boundary Isolation**, **YAGNI**, **TDD Verification Loop** (mỗi vi bước có tiêu chí Pass/Fail).

| Khía cạnh | Không dùng | Dùng SymFlowAge |
| :--- | :--- | :--- |
| Bắt đầu | Tự quyết bước tiếp theo, dễ tê liệt | Micro-step 5-15 phút có test criterion |
| Hướng đi | Phát hiện drift sau khi tốn thời gian/token | Guardrail kiểm tra trước, có Circuit Breaker |
| Quan sát | Đọc log rời rạc | Browser Event Log theo lifecycle của Agent |
| Học từ lỗi | Mất sau khi restart | Calibration rule lưu persistent |
| Chịu lỗi | Gemini lỗi làm gián đoạn | Fallback chain vẫn trả contract hợp lệ |

SymFlowAge không thay thế developer: nó làm rõ bước tiếp theo, lý do cần dừng và bằng chứng đã kiểm chứng; developer vẫn quyết định cuối cùng.

---

## 🕳️ Guardrail Ngữ Nghĩa (Semantic Drift)

`POST /api/v1/agent/guardrail/drift-check` và MCP tool `symflowage_guardrail_drift_check` chấm `driftScore` (0-100) bằng **vector embedding + cosine similarity** (`src/db/rag.ts`), không còn bảng từ khóa cố định:

1. Embed mục tiêu, đầu ra của agent và một "ngữ cảnh delivery" bằng Gemini `gemini-embedding-001` (cắt về 768 chiều, chuẩn hóa L2).
2. `effectiveSimilarity = max(cos(goal, output), cos(delivery, output))` → điểm drift liên tục: bám sát mục tiêu ≈ 5-25, liên quan gián tiếp ≈ 15-35, ít liên quan ≈ 50-75.
3. **Rabbit hole** được nhận diện bằng cách so output với 4 archetype (over-engineering, premature optimization, bike-shedding, reinventing-wheel) trong không gian vector. Trúng khi similarity ≥ `0.6` và vượt similarity-với-mục-tiêu ≥ `0.12`; điểm phạt (60-95) tăng theo mức chênh. Danh sách từ khóa cũ chỉ còn là bằng chứng bổ sung (tối thiểu margin 0.15).
4. Tác vụ khớp ngoại lệ (Calibration Memory) → `driftScore = 0`.

Response có `semanticMetrics` (`cosineSimilarity`, `deliveryAlignmentSimilarity`, `effectiveSimilarity`, **`embeddingSource`**) và `detectedRabbitHoles` (mục do embedding phát hiện có `detectedBy: "embedding"` và `similarity`).

**Giới hạn cần biết**
- `embeddingSource: "deterministic-fallback"` xuất hiện khi không có `GEMINI_API_KEY` hoặc API lỗi/rate limit. Khi đó vector chỉ là hash từ khóa + trigram, **không phải semantic thật** và không chạy so khớp archetype. Đặt `SYMFLOWAGE_REQUIRE_SEMANTIC=1` để trả `503 SEMANTIC_UNAVAILABLE` thay vì âm thầm dùng fallback (khuyến nghị cho production).
- Embedding không hiểu phủ định/điều kiện: "Add Redis cache **after** load test showed the DB is the bottleneck" vẫn có thể bị chấm là premature optimization (false positive). Dùng exemption để hiệu chỉnh.
- Ngưỡng `0.6` / `0.12` mới được chỉnh trên ~12 mẫu, chưa calibrate trên dữ liệu lớn.
- `text-embedding-004` và `embedding-001` đã bị Google gỡ (404); trước bản sửa này đường embedding thật luôn rơi về fallback.

Mẫu kết quả với embedding thật (mục tiêu "Build a Node.js payment API with Stripe checkout"): Stripe webhook / unit test / JWT middleware → 9-17; "cluster orchestrator with ingress mesh across regions" → 79; "tweaking color palette and hover transitions" → 84; "homegrown query-builder instead of a library" → 91.

---

## ✅ Đã Triển Khai

- **Visual Task Coordinate Tree**: bản đồ 3 tầng Macro (Core Goal) → Meso (3 cột mốc) → Micro/Nano (vi bước 5-15p, nano-step 2p), có radar halo, huy hiệu vai trò (`PM`, `Coder`, `Guardrail`, `QA`) và Node Inspector.
- **Drift Score Meter + Sparkline**: 🟢 ≤15 · 🟡 15-40 · 🟠 40-65 · 🔴 ≥65 (ngắt mạch), kèm đường tham chiếu 40/65.
- **Hộp cảnh báo rabbit hole** (`over_engineering`, `premature_optimization`, `reinventing_wheel`, `scope_creep`, `bike_shedding`) và nút 1-click **"Báo False Positive"** → `calibrationMemory`.
- **Effort Sync & Status LED**: `DECOMPOSING` / `EXECUTING` / `GUARDRAIL_CHECK` / `HALT_EXECUTION` / `IDLE`; elapsed vs estimated budget.
- **Predictive Horizon View**: 3 timeline (Optimal 68% / Status Quo Drift 24% / Bottleneck Crash 8%) và "Lock Flow".
- **MCP orchestration & telemetry**: `decompose`, `guardrail`, `outcome`, `accuracy` qua JSON-RPC/SSE; UI đồng bộ qua `GET /api/agent/activity/stream` (chỉ metadata, phù hợp local/internal — cần xác thực và tách channel theo user trước khi mở ra internet).
- **Persistent Calibration Memory**: rule từ outcome `DRIFT`/`CRASH`/`FALSE_POSITIVE` lưu atomically ở `.data/calibration-memory.json`.
- **Heavy / high-frequency agent**: WebSocket duplex `/ws/agent/stream` (~8.269 steps/s), hàng đợi async `POST /api/v1/agent/async/enqueue` (ACK < 2ms, backpressure), cache đa tầng write-behind (`tests/heavy-agent.spec.ts`).
- **Smart Cache** cho `/decompose` và `/guardrail/drift-check`: lần lặp trả `X-Cache-Status: HIT`, < 1ms, 0 token; thống kê ở `GET /api/smart-cache-stats`.
- **Chống báo động giả**: ngưỡng `circuitBreakerThreshold` mặc định `65`; API/MCP "Đây KHÔNG phải Rabbit Hole" (`POST|GET /api/v1/agent/guardrail/exemptions`, `DELETE …/:id`, tool `symflowage_report_false_positive`).
- **Load test** (K6 spike 2.000 VUs: 65.762 req, 0 lỗi 5xx; ramp-up tới 5.000 VUs: 123.558 req, 0% lỗi; Autocannon đỉnh 2.656 req/s). Vùng vận hành an toàn ≤ ~1.500 kết nối; trên đó suy thoái êm ái.

### Thay đổi mới nhất (Guardrail semantic thật)
- `driftScore` ở `agentRoutes.ts` và MCP dùng `calculateSemanticDriftScore` (embedding + `cosineSimilarity`) thay cho bảng 0/15/50/75.
- Sửa model embedding (`gemini-embedding-001`, 768 chiều, chuẩn hóa L2) — model cũ trả 404 nên trước đó luôn dùng fallback.
- Nhận diện rabbit hole bằng archetype trong không gian vector; phạt liên tục theo mức chênh thay vì sàn 75.
- Thêm `embeddingSource` vào `semanticMetrics` và chế độ nghiêm ngặt `SYMFLOWAGE_REQUIRE_SEMANTIC=1`.
- Số liệu "Guardrail matrix 10/10 (`drift=15`/`75`)" trong `scripts/measure-value.cjs` được đo trên engine từ khóa cũ; điểm số hiện tại là giá trị liên tục.

---

## 💰 Chi Phí & Định Giá

Mô hình **BYOK**: khách tự mang `GEMINI_API_KEY`, SymFlowAge chỉ meter số lượt gọi Guardrail / Planner / Socratic.

| Gói | Giá/tháng | Quota | Overage | Ghi chú |
| :--- | :---: | :---: | :---: | :--- |
| **Free** | $0 | 1.000 calls (chặn cứng `402 quota_exceeded`) | — | 1 project, full MCP & REST, Smart Cache |
| **Pro Solo** | $19 | 50.000 calls | +$0.002/call | Accuracy 90 ngày, webhook Slack/Discord, Calibration Memory không giới hạn |
| **Team Swarm** | $99 | 250.000 calls | +$0.002/call | Theo dõi theo `x-agent-id`, dashboard drift toàn đội |

Vì sao rẻ: (1) **Model tiering** mặc định `gemini-3.1-flash-lite` (~$0.000021 / decompose, rẻ hơn ~88% so với Pro); (2) **SmartCache** lần lặp lại = 0 token (TTL 10/30/120 phút); (3) **BYOK**. Chạy `node scripts/measure-value.cjs` để tái hiện số liệu. Chi tiết: [`BENCHMARKS.md`](./BENCHMARKS.md).

API billing: `GET /api/billing/plans`, `POST /api/billing/api-keys` (M2M key `sk_live_…`), `GET /api/billing/usage?tenantId=…`, `POST /api/billing/checkout` (Stripe), `POST /api/billing/webhook`.

---

## ⚡ Quickstart

Bốn cách tích hợp: **MCP** (Cursor, Windsurf, Claude Desktop, Cline, Roo Code), **Node.js SDK**, **Python SDK**, **OpenAPI/Swagger** (`/api/docs`, spec ở `/openapi.json`).

### MCP (khuyến nghị)

```json
{
  "mcpServers": {
    "symflowage": {
      "url": "http://localhost:3000/api/mcp/sse",
      "transport": "sse",
      "headers": { "Authorization": "Bearer <SYMFLOWAGE_M2M_API_KEY>" }
    }
  }
}
```

Tools: `symflowage_decompose_task`, `symflowage_guardrail_drift_check`, `symflowage_report_false_positive`, `symflowage_report_outcome`, `symflowage_record_outcome`, `symflowage_configure_circuit_breaker`, `symflowage_subscribe_alerts`, `symflowage_get_accuracy_score`. Workspace đã có [`.vscode/mcp.json`](.vscode/mcp.json) (VS Code hỏi M2M key dạng password).

Kịch bản thử: yêu cầu Agent lập kế hoạch OAuth2 cho "Launch MVP" → `ALLOW` + vi bước; yêu cầu "tự viết lại UI framework thay vì dùng Tailwind" → `BLOCK` + SSE `HALT_EXECUTION`; cuối phiên Agent gọi `symflowage_report_outcome` để đóng vòng Feedback Loop.

### Node.js SDK (`src/sdk/node`)

```typescript
import { SymFlowAgeClient } from './src/sdk/node';

const client = new SymFlowAgeClient({
  apiKey: process.env.SYMFLOWAGE_M2M_API_KEY!,
  baseUrl: 'http://localhost:3000',
});

const plan = await client.decomposeTask({
  taskTitle: 'Tích hợp Stripe Checkout Payment',
  context: { coreGoal: 'Launch MVP SaaS' },
});

const decision = await client.checkGuardrail({
  agentId: 'agent_cline_vscode',
  proposedAction: 'Viết lại toàn bộ hệ thống Auth từ đầu',
  coreGoalTitle: 'Launch MVP SaaS',
});
if (decision.action === 'BLOCK') console.warn(decision.reason);

await client.reportOutcome({ requestId: plan.requestId, outcomeStatus: 'SUCCESS' });
```

### Python SDK (`src/sdk/python/symflowage`)

```python
from src.sdk.python.symflowage import AsyncSymFlowAgeClient

client = AsyncSymFlowAgeClient(api_key="SYMFLOWAGE_M2M_API_KEY", base_url="http://localhost:3000")
decision = await client.check_guardrail(
    agent_id="crewai_researcher_01",
    proposed_action="Tối ưu hóa query SQL trước khi có dữ liệu thực tế",
    core_goal_title="Ship Alpha Version",
)
if decision.action == "BLOCK":
    print(decision.reason, decision.recommended_action)
```

---

## 🚀 Tính Năng

**Cho Solo Dev / Indie Hacker**
- **Smart Presets 1-click**: Launch MVP SaaS 7 ngày, Solo AI Tool $1K MRR, khắc phục crash trước Product Hunt, refactor Auth spaghetti, tối ưu PostgreSQL pool.
- **Rabbit Hole Detector + False-positive loop**: xem [Guardrail ngữ nghĩa](#-guardrail-ngữ-nghĩa-semantic-drift); dashboard Precision Score % và danh sách quy tắc ngoại lệ.
- **Nano-Steps 2 phút ("Gỡ rối")**: 3 giai đoạn (định vị → bản thô → kiểm chứng), nút "Bấm Giờ 2p", định tuyến Gemini Flash-Lite (~140-300ms).
- **"Challenge Me"**: cố vấn Socratic bằng Gemini Pro, 100% passive (chỉ chạy khi bấm).
- **Phím tắt global** (`react-hotkeys-hook`): `1-8`/`Alt+1..8` đổi tab, `Shift/Alt+C` Challenge Me, `Shift/Alt+F` Focus Mode, `?` cheat sheet, `Esc` thoát; tự bỏ qua khi đang gõ.
- **Offline Mode + PWA**: `offlineDecomposer.ts` phân rã bằng heuristic khi mất mạng; Service Worker precache.

**Hệ thống**
- **Predictive Horizon View**: 3 dòng thời gian với xác suất, Key Indicator và mốc +2h/+24h.
- **Micro-Steps Tracker & Pomodoro**: Pomodoro 25m / Nano Sprint 2m / nghỉ 5m, elapsed vs estimated, chuông Web Audio, Goal Traceability.
- **Goal Canvas & Drift Score**: mục tiêu theo quý; `POST /api/goals/plan` sinh lộ trình.
- **Bottleneck Radar & Risk Matrix**: Cognitive / Technical / Dependency / Process, Probability × Impact + contingency.
- **Why-First Decision Copilot**: First Principles, trade-off, câu hỏi Socratic.
- **Semantic Knowledge Base & RAG (pgvector)**: embedding 768 chiều (`gemini-embedding-001`), tìm kiếm cosine trên pgvector, RAG QA có trích dẫn.
- **Behavioral Analytics (Recharts)**: Drift vs Goal Alignment vs Focus Efficiency (theo phiên / vi bước / 7 ngày), Productivity & Friction Trends, Burndown Velocity, Audio Report.

---

## 🛠️ Tech Stack & Cấu Trúc

| Thành phần | Công nghệ |
| :--- | :--- |
| Frontend | React 19, TypeScript, Tailwind v4, Recharts 3, Motion, Lucide |
| Backend | Express + TSX (Node.js), Vite middleware |
| Database | PostgreSQL 16 + Drizzle ORM (JSONB, `vector(768)`) |
| Queue & cache | Redis 7 / ARQ, Token Bucket rate limit (`X-RateLimit-*`), SHA-256 Smart Cache |
| AI | `@google/genai`; tiers `gemini-3.1-flash-lite` / `gemini-2.5-flash` / `gemini-2.5-pro`; embedding `gemini-embedding-001` |
| Container | Docker multi-stage, non-root (`10001`), dumb-init |

```
├── server.ts / serverConfig.ts   # Express API, Vite middleware, cấu hình & API key
├── src/
│   ├── App.tsx, main.tsx         # Shell React 3 tầng Zoom In/Out
│   ├── goal/ prediction/ microStep/ bottleneck/ decisionCopilot/ behavioral/ projectContext/  # Domain modules
│   ├── routes/                   # agentRoutes (guardrail, decompose, outcomes), decisionRoutes, notesRoutes…
│   ├── mcp/                      # MCP server (JSON-RPC + SSE)
│   ├── db/                       # schema.ts, index.ts, rag.ts (embedding, cosine, semantic drift)
│   ├── lib/                      # geminiResilience.ts, ai.ts, firebase*.ts
│   ├── sdk/                      # Node & Python SDK
│   └── components/ data/ utils/ types/ common/
├── tests/                        # Playwright specs + load/ (K6)
└── scripts/                      # autocannon, measure-value, verify-*
```

---

## 📡 API

Route legacy cho UI: `POST /api/predict`, `POST /api/decompose-task`, `POST /api/semantic-drift-analysis` (`{coreGoalTitle, tasks[]}` → `overallAlignmentPercent`, `detectedRabbitHoles`), `POST /api/socratic-decision`, `POST /api/goals/plan`, `GET /api/notes`, `POST /api/notes/search`, `POST /api/notes/rag-ask`.

### Agent API `/api/v1/agent/*` (machine-to-machine)

Xác thực bằng `Authorization: Bearer $SYMFLOWAGE_M2M_API_KEY` (không nhúng vào frontend/commit). Không dùng guest fallback.

- **`POST /decompose`** — `{goalTitle, technicalContext}` → `contractVersion`, `requestId`, `agentId`, `microSteps`, `leanAdvice`; Smart Cache (`X-Cache-Status`).
- **`POST /guardrail/drift-check`** — `{originalGoal, agentOutput, circuitBreakerThreshold?}` (mặc định 65):

  ```json
  {
    "driftScore": 14, "status": "ALLOW", "isExempted": false,
    "semanticMetrics": { "cosineSimilarity": 0.5252, "deliveryAlignmentSimilarity": 0.5936, "effectiveSimilarity": 0.5936, "embeddingSource": "gemini" },
    "detectedRabbitHoles": [], "reason": "…", "circuitBreaker": { "triggered": false }
  }
  ```

  `status = BLOCK` khi `driftScore >= threshold`. Lần lặp lại trả `X-Cache-Status: HIT`. Lỗi `503 SEMANTIC_UNAVAILABLE` khi bật `SYMFLOWAGE_REQUIRE_SEMANTIC=1` mà không có embedding thật.
- **`POST|GET /guardrail/exemptions`** (alias `/feedback`, `/not-a-rabbit-hole`; `DELETE /:id`) — nạp/liệt kê ngoại lệ `{taskTitle, coreGoalTitle, reason, isFalsePositive}` → `201 EXEMPTION_RECORDED` + `calibrationStats`.
- **`POST /outcomes`** (cũng có `/api/outcomes`) — `{predictionId|requestId, actualPath|outcomeStatus, actualDriftScore, notes}` để backtesting.
- **`GET /accuracy-score`** — `accuracyScore`, `sampleSize`, `metrics` (`driftHitRate`, `crashHitRate`, `optimalHitRate`, `falseAlarmRate`), `verdict`, cửa sổ 30 ngày.

```bash
curl -X POST "$APP_URL/api/v1/agent/guardrail/drift-check" \
  -H "Authorization: Bearer $SYMFLOWAGE_M2M_API_KEY" -H "Content-Type: application/json" \
  -d '{"originalGoal":"Ship MVP SaaS","agentOutput":"Dựng Kubernetes multi-region cluster","circuitBreakerThreshold":40}'
```

---

## 🚨 Circuit Breaker & MCP

MCP có 2 transport: HTTP JSON-RPC `POST /api/mcp` và SSE `GET /api/mcp/sse` + `POST /api/mcp/messages`; cả hai yêu cầu Bearer M2M key. SSE chỉ dành cho MCP client và guardrail alert, khác với telemetry UI `/api/agent/activity/stream`.

**Điều kiện ngắt mạch**: drift ≥ 65 (hoặc `maxDriftThreshold` tùy chỉnh), guardrail `BLOCK` do bẫy nghiêm trọng, hoặc sa đà liên tiếp ≥ 3 lần.

- **Webhook** (`SYMFLOWAGE_WEBHOOK_URL`): POST `CIRCUIT_BREAKER_TRIGGERED` tới Slack/Discord/PagerDuty với `agentId`, `requestId`, `severity`, `driftMetrics` (`driftScore`, `detectedPatterns`, `recommendedAction`), `circuitStatus: "OPEN"`.
- **SSE**: `event: guardrail_alert` với `action: HALT_EXECUTION` để IDE dừng sinh code ngay.

---

## 🛡️ Gemini Resilience

`src/lib/geminiResilience.ts`: chuỗi fallback mô hình (`gemini-2.5-flash` → `gemini-flash-latest` → `gemini-3.1-flash-lite` → …), jittered exponential backoff cho `503`/`429`, và bộ tổng hợp payload offline khi không có key để ứng dụng không bao giờ trắng màn hình. Đã kiểm chứng bằng `tests/fallback.spec.ts`. (Riêng điểm drift của guardrail dùng cờ `embeddingSource`/`SYMFLOWAGE_REQUIRE_SEMANTIC` như mô tả ở trên.)

---

## 🚀 Cài Đặt & Biến Môi Trường

Yêu cầu: Node.js ≥ 20; (tùy chọn) `GEMINI_API_KEY`.

```bash
git clone <repository-url> && cd <project-folder>
npm install --legacy-peer-deps   # nếu gặp xung đột peer dependency giữa vite và esbuild; nếu không, dùng npm install
cp .env.example .env             # điền GEMINI_API_KEY và SYMFLOWAGE_M2M_API_KEY
npm run dev                      # http://localhost:3000
```

Firebase Auth (tùy chọn): tạo `.env.local` (đã git-ignored) với `VITE_FIREBASE_*` từ Firebase Console và bật Google provider. Không commit key thật.

| Biến | Bắt buộc | Mô tả |
| :--- | :---: | :--- |
| `GEMINI_API_KEY` (hoặc `VITE_GEMINI_API_KEY`) | Khuyến nghị | Khóa Gemini; thiếu thì guardrail dùng fallback không-semantic |
| `SYMFLOWAGE_M2M_API_KEY` | Cho Agent/MCP | Bearer key cho `/api/v1/agent/*` và MCP |
| `SYMFLOWAGE_REQUIRE_SEMANTIC` | Không | `1` → drift-check trả `503` thay vì dùng embedding fallback |
| `SYMFLOWAGE_CALIBRATION_MEMORY_PATH` | Không | Mặc định `.data/calibration-memory.json` |
| `SYMFLOWAGE_WEBHOOK_URL` | Không | Webhook cho Circuit Breaker |
| `APP_URL` | Không | URL triển khai |
| `DATABASE_URL` | Không | PostgreSQL cho pgvector semantic search |
| `VITE_FIREBASE_*` | Không | `API_KEY`, `PROJECT_ID`, `AUTH_DOMAIN`, `STORAGE_BUCKET`, `MESSAGING_SENDER_ID`, `APP_ID`, `MEASUREMENT_ID` |

---

## 🧪 Kiểm Thử

```bash
npm run lint          # tsc --noEmit
npm run build         # Vite production bundle
npm run start         # chạy production
npm run test:e2e      # Playwright (toàn bộ)
npx playwright test tests/agent-api.spec.ts --reporter=line
npx playwright install chromium && npx playwright install-deps chromium   # nếu thiếu browser
```

Load test: `npm run test:load:k6-spike`, `test:load:k6-rampup`, `test:load:autocannon`, `test:load:heavy-agent`.

Test fallback không tốn quota:

```bash
env -u GEMINI_API_KEY -u VITE_GEMINI_API_KEY SYMFLOWAGE_M2M_API_KEY=test-agent-key npx playwright test tests/fallback.spec.ts
```

Các spec chính: `agent-api`, `mcp-sse`, `heavy-agent`, `ui-smoke`, `fallback`, `calibration-memory`, `drift-false-positive-and-cache`, `drift-score-golden`, `rabbit-hole-detector`. Khi có `GEMINI_API_KEY`, guardrail chạy bằng embedding thật; không có key, các test chạy bằng embedding fallback. Spec `rabbit-hole-detector` cần browser Chromium của Playwright. Báo cáo hiệu năng: [`BENCHMARKS.md`](./BENCHMARKS.md) (ARQ 35.420+ QPS, cache < 1.1ms P95, giảm 88,4% chi phí token).

---

## 👨‍💻 Tác Giả & Bản Quyền

**Lê Quang Huy** — © 2026. Tất cả các quyền được bảo lưu. *SymFlowAge — Contextual Future Prediction & Micro-Step Engine.*
