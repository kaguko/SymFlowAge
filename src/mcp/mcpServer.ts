import { randomUUID } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { GoogleGenAI } from '@google/genai';
import { serverConfig } from '../../serverConfig.ts';
import {
  generateContentWithFallback,
  buildSmartFallbackDecompositionSteps,
  buildSmartFallbackSemanticDrift,
  buildSmartFallbackDecision,
  buildSmartFallbackPrediction,
} from '../lib/geminiResilience.ts';
import { decomposeOffline } from '../services/offlineDecomposer.ts';
import { insertPredictionOutcome, insertPredictionSnapshot } from '../db/predictions.ts';
import { runBacktest } from '../lib/backtest.ts';
import {
  getCircuitBreakerConfig,
  updateCircuitBreakerConfig,
  registerSseAlertSubscriber,
} from '../lib/circuitBreaker.ts';
import { requireAgentAuth } from '../middleware/agentAuth.ts';
import { addCalibrationRule, getActiveCalibrationRules } from '../lib/calibrationMemory.ts';
import { serverDriftFeedbackStore, getDriftCalibrationStats } from '../routes/driftFeedbackStore.ts';
import { calculateSemanticDriftScore } from '../db/rag.ts';
import { smartCache } from '../utils/smartCacheRateLimitEngine.ts';

const apiKey = serverConfig.geminiApiKey;
const ai = apiKey
  ? new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build-mcp',
        },
      },
    })
  : null;

function cleanJsonResponse(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/i, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '');
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.replace(/```$/, '');
  }
  return cleaned.trim();
}

export function createSymFlowAgeMcpServer() {
  const server = new Server(
    {
      name: 'symflowage-mcp-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List available tools for AI Agent / Editor (Cursor, Windsurf, Claude)
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'symflowage_decompose_task',
          description:
            'Decomposes a large software task or goal into atomic, independent micro-steps (<= 15 minutes each) adhering to Divide & Conquer, Atomic Commit, and Fail Fast engineering principles.',
          inputSchema: {
            type: 'object',
            properties: {
              taskTitle: {
                type: 'string',
                description: 'The main title or objective of the software task to decompose.',
              },
              goalTitle: {
                type: 'string',
                description: 'Optional overarching project goal context.',
              },
              technicalContext: {
                type: 'string',
                description: 'Optional architecture or tech stack notes (e.g. React 19, TypeScript, PostgreSQL).',
              },
            },
            required: ['taskTitle'],
          },
        },
        {
          name: 'symflowage_semantic_drift_analysis',
          description:
            'Analyzes candidate sub-tasks/plans against a core project goal to detect semantic goal drift and technical rabbit holes (over-engineering, premature optimization, reinventing the wheel).',
          inputSchema: {
            type: 'object',
            properties: {
              coreGoalTitle: {
                type: 'string',
                description: 'The core project goal or strategic vision.',
              },
              tasks: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    title: { type: 'string' },
                  },
                  required: ['title'],
                },
                description: 'Array of candidate tasks/plans proposed by the AI Agent or developer.',
              },
              userExemptions: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of known exceptions or valid technical requirements to ignore as false positives.',
              },
            },
            required: ['coreGoalTitle', 'tasks'],
          },
        },
        {
          name: 'symflowage_socratic_decision',
          description:
            'Provides a First-Principles "WHY-FIRST" Socratic architectural critique and trade-off analysis before executing high-impact technical decisions.',
          inputSchema: {
            type: 'object',
            properties: {
              dilemma: {
                type: 'string',
                description: 'The architectural dilemma or choice (e.g. REST vs GraphQL, PostgreSQL vs MongoDB).',
              },
              context: {
                type: 'string',
                description: 'Optional project constraints, scale requirements, or latency targets.',
              },
            },
            required: ['dilemma'],
          },
        },
        {
          name: 'symflowage_predict_timelines',
          description:
            'Predicts 3 future execution trajectories (Optimal Flow, Drift, Bottleneck / Crash) with risk probabilities and mitigation strategies.',
          inputSchema: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'Project or feature context title.',
              },
              vision: {
                type: 'string',
                description: 'Target outcome or architectural vision.',
              },
              constraints: {
                type: 'array',
                items: { type: 'string' },
                description: 'Key constraints (e.g. timeline, zero external DB, mobile offline support).',
              },
            },
            required: ['title'],
          },
        },
        {
          name: 'symflowage_guardrail_drift_check',
          description:
            'Fast Machine-to-Machine guardrail check evaluating agent output against an original goal to return an ALLOW / WARN / BLOCK decision with drift score, smart exemptions, and token-saving caching.',
          inputSchema: {
            type: 'object',
            properties: {
              originalGoal: {
                type: 'string',
                description: 'The original user prompt or goal given to the agent.',
              },
              agentOutput: {
                type: 'string',
                description: 'The agent response or proposed action plan to validate.',
              },
              circuitBreakerThreshold: {
                type: 'number',
                description: 'Drift score threshold (1-100) to trigger BLOCK decision. Default: 65.',
              },
              userExemptions: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional list of verified task titles to exempt from rabbit-hole detection.',
              },
            },
            required: ['originalGoal', 'agentOutput'],
          },
        },
        {
          name: 'symflowage_report_false_positive',
          description:
            'Báo cáo "Đây KHÔNG phải Rabbit Hole" - lưu ngoại lệ vào Calibration Memory để hệ thống học và không bao giờ BLOCK nhầm các tác vụ lập trình thiết yếu nữa.',
          inputSchema: {
            type: 'object',
            properties: {
              taskTitle: {
                type: 'string',
                description: 'Tên tác vụ bị cảnh báo sai (ví dụ: "Fix login bug", "Cài đặt HTTPS")',
              },
              reason: {
                type: 'string',
                description: 'Lý do tác vụ này là hợp lệ và cần thiết cho mục tiêu dự án.',
              },
              coreGoalTitle: {
                type: 'string',
                description: 'Mục tiêu cốt lõi liên quan (ví dụ: "Ship MVP")',
              },
            },
            required: ['taskTitle'],
          },
        },
        {
          name: 'symflowage_report_outcome',
          description:
            'Báo cáo kết quả thực thi thực tế (SUCCESS, DRIFT, CRASH, ABANDONED) để tối ưu hóa độ chính xác dự báo của AI.',
          inputSchema: {
            type: 'object',
            properties: {
              requestId: { type: 'string', description: 'Mã request từ API decompose/drift-check trước đó' },
              predictionId: { type: 'string', description: 'Mã dự báo từ /api/predict (nếu có)' },
              outcomeStatus: {
                type: 'string',
                enum: ['SUCCESS', 'DRIFT', 'CRASH', 'ABANDONED'],
                description: 'Trạng thái thực thi thực tế',
              },
              isFalsePositiveDrift: {
                type: 'boolean',
                description: 'Đánh dấu nếu bị cảnh báo sa đà sai (False Positive)',
              },
              notes: { type: 'string', description: 'Ghi chú bổ sung về quá trình thực thi' },
            },
            required: ['outcomeStatus'],
          },
        },
        {
          name: 'symflowage_record_outcome',
          description:
            'Records the actual execution outcome (optimal, drift, or bottleneck) for a task to calculate AI Accuracy Score and continuous backtesting metrics.',
          inputSchema: {
            type: 'object',
            properties: {
              predictionId: {
                type: 'string',
                description: 'Optional prediction ID if available.',
              },
              actualPath: {
                type: 'string',
                enum: ['optimal', 'drift', 'bottleneck', 'crash'],
                description: 'The actual path experienced during execution.',
              },
              actualDriftScore: {
                type: 'number',
                description: 'Optional recorded drift score (0-100).',
              },
              notes: {
                type: 'string',
                description: 'Optional execution notes or agent feedback summary.',
              },
            },
            required: ['actualPath'],
          },
        },
        {
          name: 'symflowage_get_accuracy_score',
          description:
            'Retrieves the current AI system Accuracy Score, backtest hit rates, and continuous evaluation metrics.',
          inputSchema: {
            type: 'object',
            properties: {
              evaluationWindowDays: {
                type: 'number',
                description: 'Number of past days to evaluate (default: 30).',
              },
            },
          },
        },
        {
          name: 'symflowage_configure_circuit_breaker',
          description:
            'Thiết lập ngưỡng Drift Score và bật/tắt cơ chế ngắt mạch tự động (Circuit Breaker & Outbound Webhook) cho Agent.',
          inputSchema: {
            type: 'object',
            properties: {
              maxDriftThreshold: {
                type: 'number',
                description: 'Ngưỡng Drift Score (1-100) kích hoạt Circuit Breaker (Default: 65)',
              },
              enableWebhook: {
                type: 'boolean',
                description: 'Bật/tắt gửi thông báo Outbound Webhook',
              },
              webhookUrl: {
                type: 'string',
                description: 'URL nhận webhook cảnh báo (Slack, Discord, PagerDuty, Custom)',
              },
              consecutiveFailureThreshold: {
                type: 'number',
                description: 'Số lần sa đà/BLOCK liên tiếp để ngắt luồng (Default: 3)',
              },
            },
          },
        },
        {
          name: 'symflowage_subscribe_alerts',
          description:
            'Đăng ký lắng nghe cảnh báo ngắt mạch thời gian thực hoặc kiểm tra trạng thái Circuit Breaker hiện tại.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
    };
  });

  // Handle Tool Calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    let activityStatus: AgentActivityEvent['status'] = 'success';
    publishAgentActivity({
      id: `activity_${randomUUID().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      agentId: String(args.agentId || 'mcp-agent'),
      toolName: name,
      phase: 'started',
      status: 'info',
      summary: `Agent bắt đầu gọi ${name}.`,
    });

    try {
      if (name === 'symflowage_decompose_task') {
        const taskTitle = String(args.taskTitle || '').trim();
        const goalTitle = String(args.goalTitle || taskTitle).trim();
        const techCtx = String(args.technicalContext || '').trim();
        const calibrationRules = getActiveCalibrationRules();
        const calibrationContext = calibrationRules.length > 0
          ? ` Active Calibration Rules: ${calibrationRules.map((rule, index) => `${index + 1}. ${rule.rule}`).join(' ')}`
          : '';

        if (!taskTitle) {
          throw new Error('taskTitle argument is required');
        }

        if (ai) {
          const systemInstruction = `
Bạn là Trợ lý Kiến trúc SymFlowAge. Nhiệm vụ của bạn là nhận một task lớn hoặc mục tiêu kỹ thuật, phân rã thành danh sách các vi bước (micro-steps) độc lập.
Mỗi vi bước phải:
1. Có thời lượng ngắn (<= 15 phút).
2. Tự hoàn chỉnh và kiểm thử được độc lập (Atomic & Testable).
3. Tuân thủ Divide & Conquer, Atomic Commit, Fail Fast.
4. Tuân thủ mọi Active Calibration Rules được cung cấp.

Bắt buộc trả về đúng định dạng JSON:
{
  "taskTitle": "...",
  "goalTitle": "...",
  "microSteps": [
    {
      "id": "step-1",
      "title": "Tên bước cụ thể",
      "estimatedMinutes": 10,
      "verificationMethod": "Cách kiểm tra kết quả bước này",
      "riskFactor": "low" | "medium" | "high"
    }
  ]
}
`;
          const prompt = `Phân rã tác vụ: "${taskTitle}" trong bối cảnh mục tiêu "${goalTitle}".${
            techCtx ? ` Ngữ cảnh công nghệ: ${techCtx}` : ''
          }${calibrationContext}`;

          try {
            const aiPromise = generateContentWithFallback(ai, {
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              config: {
                systemInstruction,
                responseMimeType: 'application/json',
              },
              taskComplexity: 'simple',
            });
            const timeoutPromise = new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Decompose AI timed out')), 5000)
            );
            const response = await Promise.race([aiPromise, timeoutPromise]);

            const parsed = JSON.parse(cleanJsonResponse(response.text || '{}'));
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      activeCalibrationRules: calibrationRules,
                      ...parsed,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          } catch (err: any) {
            const fallback = buildSmartFallbackDecompositionSteps(taskTitle);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      activeCalibrationRules: calibrationRules,
                      ...fallback,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
        } else {
          // Local offline decomposer fallback
          const localPayload = decomposeOffline({ title: taskTitle, description: goalTitle } as any);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    taskTitle,
                    goalTitle,
                    engine: 'Local Rule Engine (Offline)',
                    activeCalibrationRules: calibrationRules,
                    microSteps: localPayload.microSteps || [],
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
      }

      if (name === 'symflowage_semantic_drift_analysis') {
        const coreGoalTitle = String(args.coreGoalTitle || '').trim();
        const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
        const userExemptions = Array.isArray(args.userExemptions) ? args.userExemptions : [];

        if (!coreGoalTitle || rawTasks.length === 0) {
          throw new Error('coreGoalTitle and at least 1 task are required');
        }

        const tasks = rawTasks.map((t: any, index: number) => ({
          id: t.id || `task-${index + 1}`,
          title: String(t.title || ''),
        }));

        if (ai) {
          const systemInstruction = `
Bạn là AI Semantic Guardrail trong hệ thống SymFlowAge.
Đánh giá danh sách task/kế hoạch so với Mục tiêu cốt lõi: "${coreGoalTitle}".
Phát hiện nếu agent hoặc dev đang bị trôi dạt mục tiêu (Semantic Drift) hoặc rơi vào bẫy kỹ thuật (Rabbit Holes) như: over_engineering, premature_optimization, reinventing_wheel, bike_shedding.

Bắt buộc trả về đúng JSON:
{
  "overallAlignmentPercent": 85,
  "driftStatus": "safe" | "caution" | "danger_yellow",
  "detectedRabbitHoles": [
    {
      "taskId": "task-id",
      "taskTitle": "Tên task sa đà",
      "type": "over_engineering",
      "reason": "Giải thích vì sao đây là bẫy",
      "suggestedFix": "Cách điều chỉnh lại"
    }
  ],
  "recommendations": ["Lời khuyên giữ đúng hướng"]
}
`;
          const prompt = `Phân tích ${tasks.length} task này so với mục tiêu cốt lõi:\n${JSON.stringify(
            tasks,
            null,
            2
          )}`;

          try {
            const response = await generateContentWithFallback(ai, {
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              config: {
                systemInstruction,
                responseMimeType: 'application/json',
              },
              taskComplexity: 'simple',
            });

            const parsed = JSON.parse(cleanJsonResponse(response.text || '{}'));
            return {
              content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }],
            };
          } catch (err) {
            const fallback = buildSmartFallbackSemanticDrift(coreGoalTitle, tasks);
            return {
              content: [{ type: 'text', text: JSON.stringify(fallback, null, 2) }],
            };
          }
        } else {
          const fallback = buildSmartFallbackSemanticDrift(coreGoalTitle, tasks);
          return {
            content: [{ type: 'text', text: JSON.stringify(fallback, null, 2) }],
          };
        }
      }

      if (name === 'symflowage_socratic_decision') {
        const dilemma = String(args.dilemma || '').trim();
        const context = String(args.context || '').trim();

        if (!dilemma) {
          throw new Error('dilemma argument is required');
        }

        if (ai) {
          const systemInstruction = `
Bạn là Trợ lý Phản biện Socratic thuộc SymFlowAge. Tuân thủ triết lý "WHY-FIRST Manifesto".
Phân tích quyết định kỹ thuật theo Nguyên lý gốc (First Principles).

Bắt buộc trả về đúng JSON:
{
  "dilemma": "...",
  "corePurposeWhy": "Lý do cốt lõi tại sao cần quyết định này",
  "firstPrinciplesAnalysis": [
    "Phân tích nguyên lý gốc 1",
    "Phân tích nguyên lý gốc 2"
  ],
  "tradeOffs": {
    "advantages": ["Ưu điểm 1", "Ưu điểm 2"],
    "disadvantages": ["Nhược điểm 1", "Nhược điểm 2"]
  },
  "socraticQuestions": [
    "Câu hỏi phản biện 1?",
    "Câu hỏi phản biện 2?"
  ],
  "recommendedOption": "Tùy chọn khuyến nghị tối ưu nhất"
}
`;
          const prompt = `Phản biện quyết định: "${dilemma}".${context ? ` Ngữ cảnh: ${context}` : ''}`;

          try {
            const response = await generateContentWithFallback(ai, {
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              config: {
                systemInstruction,
                responseMimeType: 'application/json',
              },
              taskComplexity: 'complex',
            });

            const parsed = JSON.parse(cleanJsonResponse(response.text || '{}'));
            return {
              content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }],
            };
          } catch (err) {
            const fallback = buildSmartFallbackDecision(dilemma);
            return {
              content: [{ type: 'text', text: JSON.stringify(fallback, null, 2) }],
            };
          }
        } else {
          const fallback = buildSmartFallbackDecision(dilemma);
          return {
            content: [{ type: 'text', text: JSON.stringify(fallback, null, 2) }],
          };
        }
      }

      if (name === 'symflowage_predict_timelines') {
        const title = String(args.title || '').trim();
        const vision = String(args.vision || '').trim();
        const constraints = Array.isArray(args.constraints) ? args.constraints.map(String) : [];

        if (!title) {
          throw new Error('title argument is required');
        }

        if (ai) {
          const systemInstruction = `
Bạn là AI Engine Dự báo Tương lai SymFlowAge.
Dự báo 3 lộ trình thực thi tương lai: Optimal Flow, Drift, và Bottleneck.

Bắt buộc trả về đúng JSON:
{
  "title": "...",
  "timelines": [
    {
      "pathType": "optimal",
      "name": "Luồng tối ưu",
      "probability": 0.65,
      "durationEstimate": "3-5 ngày",
      "keyMilestones": ["Mốc 1", "Mốc 2"],
      "summary": "Tóm tắt lộ trình"
    },
    {
      "pathType": "drift",
      "name": "Trôi dạt tiến độ",
      "probability": 0.25,
      "durationEstimate": "7-10 ngày",
      "keyMilestones": ["Bắt đầu sa đà vào refactor", "Mất tập trung mục tiêu"],
      "summary": "Tóm tắt nguy cơ trôi dạt"
    },
    {
      "pathType": "bottleneck",
      "name": "Điểm nghẽn nghiêm trọng",
      "probability": 0.10,
      "durationEstimate": "Bị kẹt không xác định",
      "keyMilestones": ["Xung đột thư viện/database", "Gãy kiến trúc"],
      "summary": "Tóm tắt nguy cơ sụp đổ"
    }
  ],
  "riskMatrix": [
    {
      "risk": "Mô tả rủi ro chính",
      "severity": "high",
      "mitigation": "Biện pháp phòng ngừa"
    }
  ]
}
`;
          const prompt = `Dự báo tương lai dự án: "${title}". Vision: "${vision}". Ràng buộc: ${constraints.join(
            ', '
          )}`;

          try {
            const response = await generateContentWithFallback(ai, {
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              config: {
                systemInstruction,
                responseMimeType: 'application/json',
              },
              taskComplexity: 'complex',
            });

            const parsed = JSON.parse(cleanJsonResponse(response.text || '{}'));
            return {
              content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }],
            };
          } catch (err) {
            const fallback = buildSmartFallbackPrediction({ title, vision });
            return {
              content: [{ type: 'text', text: JSON.stringify(fallback, null, 2) }],
            };
          }
        } else {
          const fallback = buildSmartFallbackPrediction({ title, vision });
          return {
            content: [{ type: 'text', text: JSON.stringify(fallback, null, 2) }],
          };
        }
      }

      if (name === 'symflowage_guardrail_drift_check') {
        const originalGoal = String(args.originalGoal || '').trim();
        const agentOutput = String(args.agentOutput || '').trim();
        const threshold = Number.isFinite(Number(args.circuitBreakerThreshold))
          ? Math.min(100, Math.max(1, Number(args.circuitBreakerThreshold)))
          : 65;

        if (!originalGoal || !agentOutput) {
          throw new Error('originalGoal and agentOutput are required');
        }

        const userExemptions = Array.isArray(args.userExemptions) ? args.userExemptions : [];
        const allExemptions = [
          ...serverDriftFeedbackStore.filter((f) => f.isFalsePositive).map((f) => ({
            taskId: f.taskId,
            taskTitle: f.taskTitle,
            reason: f.userReason,
          })),
          ...userExemptions.map((e: any) =>
            typeof e === 'string'
              ? { taskTitle: e, reason: 'MCP user exemption' }
              : { taskId: e?.taskId, taskTitle: e?.taskTitle || e?.title || '', reason: e?.reason || 'MCP user exemption' }
          ),
        ];

        const cacheKey = `mcp_drift:${originalGoal.toLowerCase()}:${agentOutput.toLowerCase()}:${threshold}:ex_${allExemptions.length}`;
        const cached = smartCache.get<any>(cacheKey);
        if (cached.hit && cached.data) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ ...cached.data, cached: true }, null, 2) }],
          };
        }

        const semantic = buildSmartFallbackSemanticDrift(
          originalGoal,
          [{ id: 'agent-output', title: agentOutput }],
          allExemptions
        );

        const lowerOutput = agentOutput.toLowerCase();
        const isExempted = allExemptions.some(
          (e) => e.taskTitle && (lowerOutput.includes(e.taskTitle.toLowerCase()) || e.taskTitle.toLowerCase().includes(lowerOutput))
        );

        const semanticCalculation = await calculateSemanticDriftScore(originalGoal, agentOutput, {
          detectedRabbitHoles: semantic.detectedRabbitHoles,
          isExempted,
        });
        const detectedRabbitHoles = [
          ...semantic.detectedRabbitHoles,
          ...semanticCalculation.semanticRabbitHoles.map((r) => ({
            taskId: 'agent-output',
            taskTitle: agentOutput,
            rabbitHoleType: r.rabbitHoleType,
            severity: 'high',
            similarity: Number(r.similarity.toFixed(4)),
            whyItsATrap: r.whyItsATrap,
            detectedBy: 'embedding',
          })),
        ];

        const driftScore = semanticCalculation.driftScore;
        const status = driftScore >= threshold ? 'BLOCK' : 'ALLOW';
        const decision = status;

        const result = {
          mcpContract: 'symflowage.mcp.v1',
          originalGoal,
          agentOutput,
          driftScore,
          semanticMetrics: {
            cosineSimilarity: Number(semanticCalculation.cosineSimilarity.toFixed(4)),
            deliveryAlignmentSimilarity: Number(semanticCalculation.deliveryAlignmentSimilarity.toFixed(4)),
            effectiveSimilarity: Number(semanticCalculation.effectiveSimilarity.toFixed(4)),
            embeddingSource: semanticCalculation.embeddingSource,
          },
          threshold,
          status,
          decision: status,
          isExempted,
          detectedRabbitHoles,
          calibrationStats: getDriftCalibrationStats(),
          reason:
            status === 'BLOCK'
              ? semanticCalculation.reason || 'Agent output has insufficient goal overlap or contains a known rabbit-hole pattern.'
              : semanticCalculation.reason || 'Agent output remains aligned with the original goal.',
        };

        smartCache.set(cacheKey, result, 'simple');

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      if (name === 'symflowage_report_false_positive') {
        const taskTitle = String(args.taskTitle || '').trim();
        const reason = String(args.reason || 'Flagged valid task via MCP tool').trim();
        const coreGoalTitle = String(args.coreGoalTitle || '').trim() || undefined;

        if (!taskTitle) {
          throw new Error('taskTitle is required');
        }

        const taskId = `task_${randomUUID().slice(0, 8)}`;
        const feedbackEntry = {
          id: `fb_${randomUUID().slice(0, 8)}`,
          taskId,
          taskTitle,
          coreGoalTitle,
          detectedType: 'over_engineering',
          isFalsePositive: true,
          userReason: reason,
          timestamp: Date.now(),
        };

        serverDriftFeedbackStore.push(feedbackEntry);
        addCalibrationRule('DRIFT', taskId, `Tác vụ "${taskTitle}" được xác nhận là hợp lệ: ${reason}`);

        const result = {
          status: 'EXEMPTION_RECORDED',
          message: `Đã lưu ngoại lệ cho "${taskTitle}". Lần kiểm tra tiếp theo sẽ KHÔNG bị BLOCK nhầm nữa.`,
          exemption: feedbackEntry,
          calibrationStats: getDriftCalibrationStats(),
          activeCalibrationRules: getActiveCalibrationRules(),
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      if (name === 'symflowage_report_outcome' || name === 'symflowage_record_outcome') {
        const outcomeStatus = String(
          args.outcomeStatus || args.actualPath || 'SUCCESS'
        ).toUpperCase();

        let actualPath: 'optimal' | 'drift' | 'bottleneck' = 'optimal';
        if (['DRIFT', 'DRIFTING'].includes(outcomeStatus) || args.actualPath === 'drift') {
          actualPath = 'drift';
        } else if (
          ['CRASH', 'ABANDONED', 'BOTTLENECK', 'FAIL', 'FAILED'].includes(outcomeStatus) ||
          ['bottleneck', 'crash'].includes(String(args.actualPath || ''))
        ) {
          actualPath = 'bottleneck';
        }

        const requestId = String(args.requestId || `req_${randomUUID().slice(0, 8)}`);
        let predictionId = String(args.predictionId || '').trim();
        const isFalsePositiveDrift = Boolean(args.isFalsePositiveDrift);
        const notes = typeof args.notes === 'string' ? args.notes : 'Recorded via MCP';

        if (isFalsePositiveDrift) {
          const feedbackEntry = {
            id: `fb_${randomUUID().slice(0, 8)}`,
            taskId: requestId,
            taskTitle: notes,
            detectedType: 'over_engineering',
            isFalsePositive: true,
            userReason: notes,
            timestamp: Date.now(),
          };
          serverDriftFeedbackStore.push(feedbackEntry);
        }

        if (!predictionId) {
          predictionId = `pred_${randomUUID().slice(0, 8)}`;
          await insertPredictionSnapshot({
            id: predictionId,
            context: { source: 'mcp_outcome', requestId },
            payload: { timelines: [{ pathType: actualPath, probability: 100 }] },
            driftProb: actualPath === 'drift' ? 100 : 0,
            crashProb: actualPath === 'bottleneck' ? 100 : 0,
            flowProb: actualPath === 'optimal' ? 100 : 0,
            predictedPath: actualPath as any,
            modelVersion: 'mcp-feedback',
          });
        }

        const outcomeId = `out_${randomUUID().slice(0, 8)}`;
        await insertPredictionOutcome({
          id: outcomeId,
          predictionId,
          actualPath: actualPath as any,
          actualDriftScore: typeof args.actualDriftScore === 'number' ? args.actualDriftScore : null,
          source: 'auto',
          notes: typeof args.notes === 'string' ? args.notes : 'Recorded via MCP',
        });

        const backtest = await runBacktest({
          from: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
          to: new Date(),
          minAgeHours: 0,
        });

        if (actualPath === 'drift' || actualPath === 'bottleneck') {
          addCalibrationRule(actualPath === 'drift' ? 'DRIFT' : 'CRASH', requestId, String(args.notes || ''));
        }

        const response = {
          contractVersion: '1.0',
          status: 'RECORDED',
          outcomeId,
          requestId,
          predictionId,
          outcomeStatus,
          accuracyDelta: {
            predictionMatched: true,
            updatedAgentPrecisionScore: Number((backtest.overallAccuracyScore * 100).toFixed(1)),
          },
          updatedAccuracyMetrics: {
            overallAccuracyPercent: backtest.overallAccuracyPercent,
            sampleSize: backtest.sampleSize,
            driftHitRate: Math.round(backtest.driftHitRate * 100) / 100,
            crashHitRate: Math.round(backtest.crashHitRate * 100) / 100,
          },
          feedbackMemory: {
            updated: actualPath === 'drift' || actualPath === 'bottleneck',
            activeCalibrationRules: getActiveCalibrationRules(),
          },
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
        };
      }

      if (name === 'symflowage_get_accuracy_score') {
        const days = Number.isFinite(Number(args.evaluationWindowDays))
          ? Math.min(90, Math.max(1, Number(args.evaluationWindowDays)))
          : 30;

        const to = new Date();
        const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
        const report = await runBacktest({ from, to, minAgeHours: 0 });

        const response = {
          accuracyScore: report.overallAccuracyScore,
          accuracyPercent: report.overallAccuracyPercent,
          sampleSize: report.sampleSize,
          evaluationWindowDays: days,
          metrics: {
            driftHitRate: Math.round(report.driftHitRate * 100) / 100,
            crashHitRate: Math.round(report.crashHitRate * 100) / 100,
            optimalHitRate: Math.round(report.optimalHitRate * 100) / 100,
            falseAlarmRate: Math.round(report.falseAlarmRate * 100) / 100,
          },
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
        };
      }

      if (name === 'symflowage_configure_circuit_breaker') {
        const newConfig = updateCircuitBreakerConfig({
          maxDriftThreshold: typeof args.maxDriftThreshold === 'number' ? args.maxDriftThreshold : undefined,
          enableWebhook: typeof args.enableWebhook === 'boolean' ? args.enableWebhook : undefined,
          webhookUrl: typeof args.webhookUrl === 'string' ? args.webhookUrl : undefined,
          consecutiveFailureThreshold: typeof args.consecutiveFailureThreshold === 'number' ? args.consecutiveFailureThreshold : undefined,
        });

        const response = {
          success: true,
          status: 'CONFIGURED',
          message: 'Cấu hình Circuit Breaker đã được cập nhật thành công.',
          circuitBreakerConfig: newConfig,
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
        };
      }

      if (name === 'symflowage_subscribe_alerts') {
        const config = getCircuitBreakerConfig();
        const response = {
          success: true,
          status: 'SUBSCRIBED',
          sseChannel: '/api/mcp/sse',
          circuitBreakerConfig: config,
          activeTransportsCount: sseTransports.size,
          instructions:
            'Lắng nghe các sự kiện guardrail_alert qua kênh SSE /api/mcp/sse. Khi Circuit Breaker kích hoạt (Drift >= threshold hoặc BLOCK), hệ thống sẽ tự động phát sự kiện HALT_EXECUTION ngắt luồng Agent.',
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
        };
      }

      throw new Error(`Unknown MCP Tool: ${name}`);
    } catch (err: any) {
      activityStatus = 'critical';
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `MCP Tool Execution Error [${name}]: ${err?.message || String(err)}`,
          },
        ],
      };
    } finally {
      publishAgentActivity({
        id: `activity_${randomUUID().slice(0, 8)}`,
        timestamp: new Date().toISOString(),
        agentId: String(args.agentId || 'mcp-agent'),
        toolName: name,
        phase: 'completed',
        status: activityStatus,
        summary: activityStatus === 'success'
          ? `Agent hoàn tất ${name}.`
          : `Agent dừng tại ${name} do lỗi hoặc guardrail.`,
      });
    }
  });

  return server;
}

export interface AgentActivityEvent {
  id: string;
  timestamp: string;
  agentId: string;
  toolName: string;
  phase: 'connected' | 'started' | 'completed';
  status: 'info' | 'success' | 'critical';
  summary: string;
  driftScore?: number;
}

const activitySubscribers = new Set<(event: AgentActivityEvent) => void>();

export function registerAgentActivitySubscriber(callback: (event: AgentActivityEvent) => void) {
  activitySubscribers.add(callback);
  return () => activitySubscribers.delete(callback);
}

function publishAgentActivity(event: AgentActivityEvent) {
  for (const subscriber of activitySubscribers) subscriber(event);
}

// Active SSE Transports Map
const sseTransports = new Map<string, SSEServerTransport>();

/**
 * Express HTTP & SSE endpoint handlers for MCP Server integration
 */
export function mountMcpRoutes(app: any) {
  app.get('/api/agent/activity/stream', (_req: any, res: any) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const writeEvent = (event: AgentActivityEvent) => {
      res.write(`event: agent_activity\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const unregister = registerAgentActivitySubscriber(writeEvent);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
    writeEvent({
      id: `activity_${randomUUID().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      agentId: 'system',
      toolName: 'browser_activity_stream',
      phase: 'connected',
      status: 'info',
      summary: 'Browser đã kết nối telemetry stream của Agent.',
    });

    res.on('close', () => {
      clearInterval(heartbeat);
      unregister();
    });
  });

  // 1. JSON-RPC Direct HTTP POST endpoint (/api/mcp)
  // For lightweight HTTP JSON-RPC tools invocation by Cursor / Windsurf / Custom Agents
  app.post('/api/mcp', requireAgentAuth, async (req: any, res: any) => {
    try {
      const server = createSymFlowAgeMcpServer();
      const jsonRpcRequest = req.body;

      if (!jsonRpcRequest || typeof jsonRpcRequest !== 'object') {
        return res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Invalid JSON-RPC Request payload' },
          id: null,
        });
      }

      // If it's a list tools request or call tool request, handle gracefully
      if (jsonRpcRequest.method === 'tools/list') {
        return res.json({
          jsonrpc: '2.0',
          result: {
            tools: [
              {
                name: 'symflowage_decompose_task',
                description:
                  'Decomposes a large task or goal into atomic micro-steps (<= 15 mins) adhering to Divide & Conquer.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    taskTitle: { type: 'string' },
                    goalTitle: { type: 'string' },
                    technicalContext: { type: 'string' },
                  },
                  required: ['taskTitle'],
                },
              },
              {
                name: 'symflowage_semantic_drift_analysis',
                description:
                  'Analyzes candidate sub-tasks against a core goal to detect goal drift & technical rabbit holes.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    coreGoalTitle: { type: 'string' },
                    tasks: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: { id: { type: 'string' }, title: { type: 'string' } },
                      },
                    },
                  },
                  required: ['coreGoalTitle', 'tasks'],
                },
              },
              {
                name: 'symflowage_socratic_decision',
                description:
                  'Provides a First-Principles "WHY-FIRST" Socratic architectural critique before execution.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    dilemma: { type: 'string' },
                    context: { type: 'string' },
                  },
                  required: ['dilemma'],
                },
              },
              {
                name: 'symflowage_predict_timelines',
                description:
                  'Predicts 3 future execution trajectories (Optimal, Drift, Crash) with risk matrices.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    vision: { type: 'string' },
                    constraints: { type: 'array', items: { type: 'string' } },
                  },
                  required: ['title'],
                },
              },
              {
                name: 'symflowage_guardrail_drift_check',
                description:
                  'Fast Machine-to-Machine guardrail check returning ALLOW / WARN / BLOCK decision.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    originalGoal: { type: 'string' },
                    agentOutput: { type: 'string' },
                    circuitBreakerThreshold: { type: 'number' },
                  },
                  required: ['originalGoal', 'agentOutput'],
                },
              },
              {
                name: 'symflowage_report_outcome',
                description: 'Records execution outcomes for feedback and calibration memory.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    requestId: { type: 'string' },
                    predictionId: { type: 'string' },
                    outcomeStatus: { type: 'string', enum: ['SUCCESS', 'DRIFT', 'CRASH', 'ABANDONED'] },
                    isFalsePositiveDrift: { type: 'boolean' },
                    notes: { type: 'string' },
                  },
                  required: ['outcomeStatus'],
                },
              },
              {
                name: 'symflowage_record_outcome',
                description: 'Records an optimal, drift, or bottleneck execution path.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    predictionId: { type: 'string' },
                    actualPath: { type: 'string', enum: ['optimal', 'drift', 'bottleneck', 'crash'] },
                    actualDriftScore: { type: 'number' },
                    notes: { type: 'string' },
                  },
                  required: ['actualPath'],
                },
              },
              {
                name: 'symflowage_get_accuracy_score',
                description: 'Retrieves backtesting accuracy and calibration metrics.',
                inputSchema: {
                  type: 'object',
                  properties: { evaluationWindowDays: { type: 'number' } },
                },
              },
              {
                name: 'symflowage_configure_circuit_breaker',
                description: 'Configures drift thresholds and circuit breaker behavior.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    maxDriftThreshold: { type: 'number' },
                    enableWebhook: { type: 'boolean' },
                    webhookUrl: { type: 'string' },
                    consecutiveFailureThreshold: { type: 'number' },
                  },
                },
              },
              {
                name: 'symflowage_subscribe_alerts',
                description: 'Subscribes the agent to circuit breaker alerts.',
                inputSchema: { type: 'object', properties: {} },
              },
            ],
          },
          id: jsonRpcRequest.id ?? 1,
        });
      }

      if (jsonRpcRequest.method === 'tools/call') {
        const params = jsonRpcRequest.params || {};
        const toolName = params.name;
        const toolArgs = params.arguments || {};

        // Delegate to server request handler
        const toolResult = await (server as any)._requestHandlers.get('tools/call')({
          method: 'tools/call',
          params: { name: toolName, arguments: toolArgs },
        });

        return res.json({
          jsonrpc: '2.0',
          result: toolResult,
          id: jsonRpcRequest.id ?? 1,
        });
      }

      if (jsonRpcRequest.method === 'initialize') {
        return res.json({
          jsonrpc: '2.0',
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'symflowage-mcp-server', version: '1.0.0' },
          },
          id: jsonRpcRequest.id ?? 1,
        });
      }

      return res.json({
        jsonrpc: '2.0',
        result: { status: 'acknowledged' },
        id: jsonRpcRequest.id ?? 1,
      });
    } catch (err: any) {
      return res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: err?.message || 'Internal MCP Error' },
        id: req.body?.id ?? null,
      });
    }
  });

  // 2. Server-Sent Events (SSE) Transport (/api/mcp/sse)
  // Standard MCP SSE Transport for Anthropic Claude Desktop, Cursor AI, Windsurf
  app.get('/api/mcp/sse', requireAgentAuth, async (req: any, res: any) => {
    try {
      const transport = new SSEServerTransport('/api/mcp/messages', res);
      const sessionId = transport.sessionId;
      sseTransports.set(sessionId, transport);

      const unregisterSseAlert = registerSseAlertSubscriber((alertData) => {
        try {
          res.write(`event: guardrail_alert\ndata: ${JSON.stringify(alertData)}\n\n`);
        } catch (err) {
          // SSE stream closed
        }
      });

      const server = createSymFlowAgeMcpServer();

      res.on('close', () => {
        unregisterSseAlert();
        sseTransports.delete(sessionId);
      });

      await server.connect(transport);
    } catch (err: any) {
      console.error('[MCP SSE Error]:', err?.message || err);
      if (!res.headersSent) {
        res.status(500).send('MCP SSE Transport Error');
      }
    }
  });

  // 3. Messages POST endpoint for SSE sessions (/api/mcp/messages)
  app.post('/api/mcp/messages', requireAgentAuth, async (req: any, res: any) => {
    const sessionId = String(req.query.sessionId || '');
    const transport = sseTransports.get(sessionId);

    if (!transport) {
      return res.status(404).json({ error: 'MCP SSE Session Not Found or Expired' });
    }

    try {
      await transport.handlePostMessage(req, res, req.body);
    } catch (err: any) {
      console.error('[MCP PostMessage Error]:', err?.message || err);
      return res.status(500).json({ error: 'Failed to process MCP message' });
    }
  });
}
