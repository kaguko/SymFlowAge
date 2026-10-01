import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { ai, cleanJsonResponse } from '../lib/ai.ts';
import {
  buildSmartFallbackDecompositionSteps,
  buildSmartFallbackDecomposition,
  generateContentWithFallback,
} from '../lib/geminiResilience.ts';
import { smartCache, MODEL_TIERS } from '../utils/smartCacheRateLimitEngine.ts';
import { createRateLimitMiddleware } from './routeHelpers.ts';
import { getActiveCalibrationRules, addCalibrationRule } from '../lib/calibrationMemory.ts';
import { runBacktest, assertThresholds } from '../lib/backtest.ts';
import { openapiSpec } from '../openapi/openapiSpec.ts';
import { Modality } from '@google/genai';

import { getDbFallbackStats } from '../db/index.ts';

export const systemRouter = Router();

// Lightweight Health & Load-Testing Probes
systemRouter.get('/health', (_req: Request, res: Response) => {
  const mem = process.memoryUsage();
  res.json({
    status: 'healthy',
    database: getDbFallbackStats(),
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: Date.now(),
    memory: {
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
    },
    system: 'SymFlowAge M2M Swarm Core',
  });
});

systemRouter.get('/ping', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/plain');
  res.send('pong');
});

// OpenAPI Specification & Interactive Swagger UI
systemRouter.get('/docs', (_req: Request, res: Response) => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>SymFlowAge M2M API Documentation - Swagger UI</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    body { margin: 0; padding: 0; background-color: #0f172a; color: #f8fafc; font-family: system-ui, sans-serif; }
    #swagger-ui { max-width: 1200px; margin: 0 auto; padding: 20px; }
    .swagger-ui .topbar { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.onload = () => {
      window.ui = SwaggerUIBundle({
        url: '/openapi.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis
        ],
      });
    };
  </script>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

/**
 * POST /api/tts
 * Synthesizes audio guidance using gemini-3.1-flash-tts-preview
 */
systemRouter.post('/tts', async (req: Request, res: Response) => {
  try {
    const { text, voice } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'Text is required for TTS' });
    }

    if (!ai) {
      return res.status(503).json({
        error: 'GEMINI_API_KEY is not configured on the server.',
      });
    }

    const voiceName = voice || 'Kore'; // 'Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr'

    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-tts-preview',
      contents: [{ parts: [{ text: text.slice(0, 500) }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName },
          },
        },
      },
    });

    const base64Audio =
      response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

    if (!base64Audio) {
      return res.status(500).json({ error: 'No audio returned from Gemini TTS' });
    }

    return res.json({ audio: base64Audio, sampleRate: 24000 });
  } catch (err: any) {
    console.error('Error in /api/tts:', err);
    return res.status(500).json({
      error: 'Failed to synthesize speech: ' + (err.message || String(err)),
    });
  }
});

/**
 * GET /api/smart-cache-stats
 * Real-time telemetry for Smart Caching, Rate Limiting, and Model Routing
 */
systemRouter.get('/smart-cache-stats', (_req: Request, res: Response) => {
  const stats = smartCache.getStats();
  const entries = smartCache.getEntries().slice(0, 10);
  res.json({
    stats,
    entries,
    modelTiers: MODEL_TIERS,
    timestamp: Date.now(),
  });
});

/**
 * POST /api/rate-limit/test
 */
systemRouter.post('/rate-limit/test', createRateLimitMiddleware('ai_simple', 1), (req: Request, res: Response) => {
  res.json({
    success: true,
    message: 'Yêu cầu được chấp thuận qua Token Bucket Rate Limiter!',
    timestamp: Date.now(),
  });
});

systemRouter.get('/agent/calibration-rules', (_req: Request, res: Response) => {
  return res.json({
    rules: getActiveCalibrationRules(),
    total: getActiveCalibrationRules().length,
  });
});

systemRouter.post('/agent/feedback/false-positive', (req: Request, res: Response) => {
  const { taskId, taskTitle, reason, detectedType } = req.body || {};
  const cleanTitle = String(taskTitle || taskId || 'Tác vụ được người dùng xác nhận hợp lệ').trim();
  const cleanReason = String(reason || 'Người dùng xác nhận tác vụ không bị sa đà (False Positive)').trim();
  const requestId = String(taskId || randomUUID().slice(0, 8));

  addCalibrationRule('DRIFT', requestId, `[FALSE_POSITIVE_EXEMPTION] ${cleanTitle}: ${cleanReason}`);

  return res.json({
    success: true,
    message: 'Đã nạp quy tắc ngoại lệ False Positive vào Calibration Memory thành công.',
    activeCalibrationRules: getActiveCalibrationRules(),
  });
});

systemRouter.get('/admin/backtest', async (req: Request, res: Response) => {
  if (!process.env.ADMIN_TOKEN || req.header('x-admin-token') !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const requestedDays = Number(req.query.days ?? 7);
  const days = Number.isFinite(requestedDays) ? Math.min(90, Math.max(1, requestedDays)) : 7;
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

  try {
    const report = await runBacktest({ from, to, minAgeHours: 24 });
    const verdict = assertThresholds(report);
    return res.status(verdict.pass ? 200 : 500).json({ report, verdict });
  } catch (error: any) {
    console.error('[admin/backtest] failed:', error?.message || error);
    return res.status(500).json({ error: 'backtest_failed' });
  }
});

/**
 * POST /api/decompose-task
 */
systemRouter.post('/decompose-task', createRateLimitMiddleware('ai_simple', 1), async (req: Request, res: Response) => {
  try {
    const { taskTitle, context } = req.body;
    if (!taskTitle) {
      return res.status(400).json({ error: 'taskTitle is required' });
    }

    const cacheKey = `decompose_task:${taskTitle.trim().toLowerCase()}`;
    const cached = smartCache.get(cacheKey);
    if (cached.hit && cached.data) {
      res.setHeader('X-Cache-Status', 'HIT');
      return res.json(cached.data);
    }
    res.setHeader('X-Cache-Status', 'MISS');

    if (!ai) {
      console.warn('[api/decompose-task] GEMINI_API_KEY not configured, serving smart fallback');
      const fallback = buildSmartFallbackDecompositionSteps(taskTitle);
      smartCache.set(cacheKey, fallback, 'simple');
      return res.json(fallback);
    }

    const systemInstruction = `
Bạn là Cố Vấn Tác Vụ Lập Trình (Atomic Decomposition Engine) dành riêng cho Solo Developer / Indie Hacker.
Nhiệm vụ: Phân rã công việc được giao thành 3-5 vi bước (Micro-steps) cực kỳ sắc bén, mỗi bước KHÔNG QUÁ 15 PHÚT.

Mỗi vi bước PHẢI tuân thủ:
1. Duration: 5, 10, hoặc 15 phút (tối đa 15 phút).
2. Single Action: 1 hành động duy nhất, cụ thể tới từng tên file, CLI command hoặc hàm.
3. Test Criterion (TDD / Fail-Fast): Tiêu chí kiểm chứng rõ ràng xem bước đó PASS hay FAIL trong vòng dưới 3 phút.
4. Programmer Principle: Một trong 6 nguyên lý: "Divide & Conquer", "Atomic Commit", "Fail Fast", "Boundary Isolation", "YAGNI", "TDD Verification Loop".
5. Unblock Tip: Gợi ý gỡ rối nhanh nếu gặp bế tắc.

Trả về định dạng JSON thuần:
{
  "taskTitle": "${taskTitle}",
  "microSteps": [
    {
      "id": "step_1",
      "order": 1,
      "title": "Tên vi bước ngắn gọn (dưới 8 từ)",
      "durationMinutes": 10,
      "programmerPrinciple": "Divide & Conquer",
      "inputRequired": "Điều kiện cần trước khi làm",
      "singleAction": "Hành động khép kín cụ thể",
      "testCriterion": "Tiêu chí kiểm chứng Pass/Fail (Fail-fast / TDD)",
      "unblockTip": "Mẹo vượt qua bế tắc dưới 3 phút",
      "completed": false
    }
  ],
  "leanAdvice": "1 lời khuyên thực dụng cho Solo Dev để ship nhanh nhất"
}
`;

    const prompt = `Phân rã tác vụ này thành các vi bước ≤15 phút: "${taskTitle}"\nNgữ cảnh: ${context ? JSON.stringify(context) : 'Solo Developer MVP'}`;

    try {
      const response = await generateContentWithFallback(ai, {
        contents: prompt,
        taskComplexity: 'simple',
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          temperature: 0.2,
        },
      });

      const text = response.text || '';
      const parsed = JSON.parse(cleanJsonResponse(text));
      smartCache.set(cacheKey, parsed, 'simple');
      return res.json(parsed);
    } catch (aiErr: any) {
      console.warn('[api/decompose-task] Upstream error, using fallback:', aiErr?.message || aiErr);
      const fallback = buildSmartFallbackDecompositionSteps(taskTitle);
      smartCache.set(cacheKey, fallback, 'simple');
      return res.json(fallback);
    }
  } catch (err: any) {
    console.error('Error in /api/decompose-task:', err);
    return res.json(buildSmartFallbackDecompositionSteps(req.body?.taskTitle || 'Tác vụ mới'));
  }
});

/**
 * POST /api/decompose
 */
systemRouter.post('/decompose', createRateLimitMiddleware('ai_simple', 1), async (req: Request, res: Response) => {
  try {
    const { stepTitle, contextFriction, currentAction } = req.body;
    if (!stepTitle) {
      return res.status(400).json({ error: 'stepTitle is required' });
    }

    if (!ai) {
      console.warn('[api/decompose] GEMINI_API_KEY not configured, serving smart fallback decomposition');
      return res.json(buildSmartFallbackDecomposition(stepTitle, contextFriction));
    }

    const systemInstruction = `
Bạn là Động Cơ Gỡ Rối Nhận Thức (Cognitive De-escalation & Nano-Step Engine) dành riêng cho Solo Developer / Indie Hacker khi bị tê liệt phân tích (Analysis Paralysis).

NGUYÊN TẮC VÀNG VỀ TRẢI NGHIỆM NGƯỜI DÙNG (ZERO COGNITIVE LOAD UX):
Khi người dùng bị tắc, não bộ họ đang bị quá tải nhận thức. Bạn TUYỆT ĐỐI KHÔNG được giao thêm bài toán cần suy nghĩ logic phức tạp.
Thay vào đó, bạn PHẢI phân rã thành ĐÚNG 3 Nano-Steps siêu nhỏ (2 phút mỗi bước) tuân theo công thức 3 giai đoạn:

1. Bước 1 (Giai đoạn Định Vị Vật Lý - Physical / Locate):
   - Không cần suy nghĩ logic. Chỉ là hành động mở file, chuyển tab hoặc định vị con trỏ chuột.
   - Ví dụ tốt: "Mở file src/auth/jwt.ts và cuộn đến hàm verifySession() (2 phút)".
   - Ví dụ xấu: "Thiết kế cấu trúc token".

2. Bước 2 (Giai đoạn Bản Thô Không Rủi Ro - Scratchpad / Skeleton):
   - Hành động gõ tối thiểu (chỉ 1-2 dòng), không sợ sai, không sợ hỏng.
   - Ví dụ tốt: "Gõ 1 dòng console.log('DEBUG:', token) hoặc khai báo const mockPayload = { id: 1 } (2 phút)".
   - Ví dụ xấu: "Hiện thực hóa logic mã hóa RSA".

3. Bước 3 (Giai đoạn Kiểm Chứng Phản Hồi Tức Thì - 1-Click Verify):
   - Thao tác bấm 1 phím hoặc chạy 1 lệnh để nhận phản hồi ngay lập tức, giải phóng dopamine.
   - Ví dụ tốt: "Chạy lệnh npm test auth hoặc F5 trình duyệt để thấy dòng log xuất hiện (2 phút)".
   - Ví dụ xấu: "Viết trọn bộ unit test bao phủ mọi edge case".

Trả về JSON thuần:
{
  "nanoSteps": [
    {
      "id": "ns_1",
      "text": "Mô tả hành động bước 1 định vị cụ thể (2 phút)",
      "done": false,
      "minutes": 2,
      "actionCategory": "navigate",
      "targetFileOrLocation": "Tên file hoặc CLI command nếu có"
    },
    {
      "id": "ns_2",
      "text": "Mô tả hành động bước 2 gõ bản thô tối thiểu (2 phút)",
      "done": false,
      "minutes": 2,
      "actionCategory": "scratchpad"
    },
    {
      "id": "ns_3",
      "text": "Mô tả hành động bước 3 kích hoạt phản hồi tức thì (2 phút)",
      "done": false,
      "minutes": 2,
      "actionCategory": "verify"
    }
  ],
  "unblockMantra": "1 câu châm ngôn gỡ rối tâm lý ngắn gọn, ấm áp, thúc đẩy hành động (VD: 'Chỉ cần mở đúng file và gõ 1 dòng, bạn đã vượt qua 80% sức ì!')."
}
`;

    const prompt = `
Vi bước đang bị kẹt: "${stepTitle}"
Hành động dự kiến: "${currentAction || stepTitle}"
Ngữ cảnh rào cản: "${contextFriction || 'Cảm thấy phức tạp, ngại bắt đầu'}"

Hãy bẻ khóa sức ì bằng 3 nano-steps 2 phút siêu dễ dàng:
`;

    try {
      const response = await generateContentWithFallback(ai, {
        contents: prompt,
        taskComplexity: 'simple',
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          temperature: 0.1,
        },
      });

      const text = response.text || '';
      const parsed = JSON.parse(cleanJsonResponse(text));
      return res.json(parsed);
    } catch (aiErr: any) {
      console.warn(
        '[api/decompose] Upstream Gemini error, serving resilient zero-cognitive-load fallback:',
        aiErr?.message || aiErr
      );
      return res.json(buildSmartFallbackDecomposition(stepTitle, contextFriction));
    }
  } catch (err: any) {
    console.error('Error in /api/decompose:', err);
    return res.json(
      buildSmartFallbackDecomposition(
        req.body?.stepTitle || 'Vi bước kỹ thuật',
        req.body?.contextFriction
      )
    );
  }
});
