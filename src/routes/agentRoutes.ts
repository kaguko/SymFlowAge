import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { AgentRequest, requireAgentAuth } from '../middleware/agentAuth.ts';
import { AuthRequest } from '../middleware/auth.ts';
import { ai, cleanJsonResponse } from '../lib/ai.ts';
import { serverDriftFeedbackStore, getDriftCalibrationStats } from './driftFeedbackStore.ts';
import {
  createRateLimitMiddleware,
  getMeaningfulGoalTokens,
  addSemanticGuardrailMetadata,
  persistPredictionBestEffort,
} from './routeHelpers.ts';
import { getActiveCalibrationRules, addCalibrationRule } from '../lib/calibrationMemory.ts';
import {
  generateContentWithFallback,
  buildSmartFallbackDecompositionSteps,
  buildSmartFallbackDecision,
  buildSmartFallbackPrediction,
  buildSmartFallbackSemanticDrift,
} from '../lib/geminiResilience.ts';
import {
  evaluateAndTriggerCircuitBreaker,
  getCircuitBreakerConfig,
  updateCircuitBreakerConfig,
} from '../lib/circuitBreaker.ts';
import { insertPredictionOutcome, insertPredictionSnapshot, getPredictionById } from '../db/predictions.ts';
import { runBacktest, assertThresholds } from '../lib/backtest.ts';
import { getOrCreateUserRecord, calculateSemanticDriftScore, cosineSimilarity } from '../db/rag.ts';
import { smartCache } from '../utils/smartCacheRateLimitEngine.ts';

export const agentRouter = Router();

async function generateAgentDecomposition(goalTitle: string, technicalContext: unknown) {
  const calibrationRules = getActiveCalibrationRules();
  const calibrationContext = calibrationRules.length > 0
    ? `\nActive Calibration Rules:\n${calibrationRules.map((rule, index) => `${index + 1}. ${rule.rule}`).join('\n')}`
    : '';

  if (!ai) return buildSmartFallbackDecompositionSteps(goalTitle);

  try {
    const response = await generateContentWithFallback(ai, {
      contents: `Phân rã mục tiêu của AI Agent thành 3-5 vi bước lập trình 5-15 phút.\nMục tiêu: ${goalTitle}\nNgữ cảnh kỹ thuật: ${JSON.stringify(technicalContext || {})}${calibrationContext}`,
      taskComplexity: 'simple',
      config: {
        systemInstruction:
          'Trả về JSON thuần với taskTitle, microSteps và leanAdvice. Mỗi microStep phải có title, durationMinutes <= 15, singleAction, testCriterion, programmerPrinciple và unblockTip. Tuân thủ Active Calibration Rules khi lập kế hoạch.',
        responseMimeType: 'application/json',
        temperature: 0.2,
      },
    });
    const parsed = JSON.parse(cleanJsonResponse(response.text || '{}'));
    const rawSteps = Array.isArray(parsed?.microSteps)
      ? parsed.microSteps
      : Array.isArray(parsed?.steps)
      ? parsed.steps
      : [];
    if (rawSteps.length === 0) {
      return buildSmartFallbackDecompositionSteps(goalTitle);
    }
    const microSteps = rawSteps.map((step: any, index: number) => ({
      id: step.id || `step_${Date.now()}_${index + 1}`,
      order: typeof step.order === 'number' ? step.order : index + 1,
      title: String(step.title || `Vi bước ${index + 1}`),
      durationMinutes: Math.min(15, Math.max(5, Number(step.durationMinutes) || 10)),
      singleAction: String(step.singleAction || step.title || ''),
      testCriterion: String(step.testCriterion || 'Test pass'),
      programmerPrinciple: step.programmerPrinciple || 'Divide & Conquer',
      unblockTip: step.unblockTip || '',
      completed: false,
    }));
    return {
      taskTitle: parsed.taskTitle || goalTitle,
      microSteps,
      leanAdvice: parsed.leanAdvice || 'Tập trung hoàn thành từng vi bước nhỏ khép kín.',
    };
  } catch (error: any) {
    console.warn('[agent/decompose] fallback:', error?.message || error);
    return buildSmartFallbackDecompositionSteps(goalTitle);
  }
}

async function generateAgentDecision(dilemma: string, context: unknown) {
  if (!ai) return buildSmartFallbackDecision(dilemma, context);

  try {
    const aiPromise = generateContentWithFallback(ai, {
      contents: `Phân tích quyết định kỹ thuật sau theo First Principles.\nDilemma: ${dilemma}\nContext: ${JSON.stringify(context || {})}`,
      taskComplexity: 'simple',
      config: {
        systemInstruction:
          'Trả về JSON thuần với dilemma, whyRootProblem, alternativesEvaluated, tradeOffsAndRisks, howRecommendation, verificationBasis, socraticQuestions và microActionPlan.',
        responseMimeType: 'application/json',
        temperature: 0.2,
      },
    });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Agent decision timed out')), 6000)
    );
    const response = await Promise.race([aiPromise, timeoutPromise]);
    const parsed = JSON.parse(cleanJsonResponse(response.text || '{}'));
    const fallback = buildSmartFallbackDecision(dilemma, context);
    return {
      ...fallback,
      ...parsed,
    };
  } catch (error: any) {
    console.warn('[agent/socratic-decision] fallback:', error?.message || error);
    return buildSmartFallbackDecision(dilemma, context);
  }
}

async function generateAgentPrediction(context: any) {
  if (!ai) return buildSmartFallbackPrediction(context);

  try {
    const aiPromise = generateContentWithFallback(ai, {
      contents: `Dự báo ba lộ trình thực thi cho context sau: ${JSON.stringify(context)}`,
      taskComplexity: 'simple',
      config: {
        systemInstruction:
          'Trả về JSON thuần với strategicWhySummary, timelines gồm đúng ba pathType optimal/drift/bottleneck, microSteps, bottlenecks, riskMatrix và behavioralInsights. Mỗi timeline phải có probability, milestones và consequence.',
        responseMimeType: 'application/json',
        temperature: 0.2,
      },
    });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Agent prediction timed out')), 6000)
    );
    const response = await Promise.race([aiPromise, timeoutPromise]);
    const parsed = JSON.parse(cleanJsonResponse(response.text || '{}'));
    const fallback = buildSmartFallbackPrediction(context);
    return {
      strategicWhySummary: parsed.strategicWhySummary || fallback.strategicWhySummary,
      timelines: Array.isArray(parsed.timelines) && parsed.timelines.length > 0 ? parsed.timelines : fallback.timelines,
      microSteps: Array.isArray(parsed.microSteps) && parsed.microSteps.length > 0 ? parsed.microSteps : fallback.microSteps,
      bottlenecks: Array.isArray(parsed.bottlenecks) && parsed.bottlenecks.length > 0 ? parsed.bottlenecks : fallback.bottlenecks,
      riskMatrix: Array.isArray(parsed.riskMatrix) && parsed.riskMatrix.length > 0 ? parsed.riskMatrix : fallback.riskMatrix,
      behavioralInsights: parsed.behavioralInsights || fallback.behavioralInsights,
    };
  } catch (error: any) {
    console.warn('[agent/predict] fallback:', error?.message || error);
    return buildSmartFallbackPrediction(context);
  }
}

agentRouter.post(
  '/decompose',
  createRateLimitMiddleware('ai_simple', 1),
  requireAgentAuth,
  async (req: AgentRequest, res: Response) => {
    const goalTitle = typeof req.body?.goalTitle === 'string' ? req.body.goalTitle.trim() : '';
    if (!goalTitle) return res.status(400).json({ error: 'goalTitle is required' });

    const cacheKey = `agent_decompose:${goalTitle.toLowerCase()}:${JSON.stringify(req.body?.technicalContext || {})}`;
    const cached = smartCache.get<any>(cacheKey);
    if (cached.hit && cached.data) {
      res.setHeader('X-Cache-Status', 'HIT');
      return res.json({
        contractVersion: 'agent.v1',
        requestId: randomUUID(),
        agentId: req.agentId,
        goalTitle,
        cached: true,
        activeCalibrationRules: getActiveCalibrationRules(),
        ...cached.data,
      });
    }
    res.setHeader('X-Cache-Status', 'MISS');

    const requestId = randomUUID();
    const result = await generateAgentDecomposition(goalTitle, req.body?.technicalContext);
    smartCache.set(cacheKey, result, 'simple');

    return res.json({
      contractVersion: 'agent.v1',
      requestId,
      agentId: req.agentId,
      goalTitle,
      cached: false,
      activeCalibrationRules: getActiveCalibrationRules(),
      ...result,
    });
  }
);

agentRouter.post(
  '/guardrail/drift-check',
  createRateLimitMiddleware('ai_simple', 1),
  requireAgentAuth,
  async (req: AgentRequest, res: Response) => {
    const originalGoal = typeof req.body?.originalGoal === 'string' ? req.body.originalGoal.trim() : '';
    const agentOutput = typeof req.body?.agentOutput === 'string' ? req.body.agentOutput.trim() : '';
    if (!originalGoal || !agentOutput) {
      return res.status(400).json({ error: 'originalGoal and agentOutput are required' });
    }

    // Default circuit breaker threshold: 65 (prevents false positives while strictly catching rabbit holes >= 75)
    const threshold = Number.isFinite(Number(req.body?.circuitBreakerThreshold))
      ? Math.min(100, Math.max(1, Number(req.body.circuitBreakerThreshold)))
      : 65;

    // Collect all system exemptions (historical user feedback + per-request exemptions)
    const userExemptions = Array.isArray(req.body?.userExemptions) ? req.body.userExemptions : [];
    const allExemptions = [
      ...serverDriftFeedbackStore.filter((f) => f.isFalsePositive).map((f) => ({
        taskId: f.taskId,
        taskTitle: f.taskTitle,
        reason: f.userReason,
      })),
      ...userExemptions.map((e: any) =>
        typeof e === 'string'
          ? { taskTitle: e, reason: 'Request exemption' }
          : { taskId: e?.taskId, taskTitle: e?.taskTitle || e?.title || '', reason: e?.reason || 'Request exemption' }
      ),
    ];

    const cacheKey = `agent_drift_check:${originalGoal.toLowerCase()}:${agentOutput.toLowerCase()}:${threshold}:ex_${allExemptions.length}`;
    const cached = smartCache.get<any>(cacheKey);
    if (cached.hit && cached.data) {
      res.setHeader('X-Cache-Status', 'HIT');
      return res.json({
        ...cached.data,
        requestId: randomUUID(),
        agentId: req.agentId,
      });
    }
    res.setHeader('X-Cache-Status', 'MISS');

    const semantic = buildSmartFallbackSemanticDrift(
      originalGoal,
      [{ id: 'agent-output', title: agentOutput }],
      allExemptions
    );

    // Check if task matches any active exemptions
    const lowerOutput = agentOutput.toLowerCase();
    const isExempted = allExemptions.some(
      (e) => e.taskTitle && (lowerOutput.includes(e.taskTitle.toLowerCase()) || e.taskTitle.toLowerCase().includes(lowerOutput))
    );

    // Real Vector Space Semantic Evaluation (768-dim embeddings + cosineSimilarity from src/db/rag.ts)
    const semanticCalculation = await calculateSemanticDriftScore(originalGoal, agentOutput, {
      detectedRabbitHoles: semantic.detectedRabbitHoles,
      isExempted,
    });

    const driftScore = semanticCalculation.driftScore;

    const status = driftScore >= threshold ? 'BLOCK' : 'ALLOW';
    const decision = status;
    const requestId = randomUUID();
    const circuitEval = evaluateAndTriggerCircuitBreaker({
      agentId: req.agentId,
      requestId,
      driftScore,
      decision: status,
      detectedPatterns: semantic.detectedRabbitHoles.map((rabbitHole: any) => rabbitHole.type || rabbitHole.taskTitle),
      recommendedAction: 'Thu hẹp hành động về mục tiêu cốt lõi trước khi tiếp tục',
    });

    const responsePayload = {
      contractVersion: 'agent.v1',
      requestId,
      agentId: req.agentId,
      originalGoal,
      agentOutput,
      driftScore,
      semanticMetrics: {
        cosineSimilarity: Number(semanticCalculation.cosineSimilarity.toFixed(4)),
        deliveryAlignmentSimilarity: Number(semanticCalculation.deliveryAlignmentSimilarity.toFixed(4)),
        effectiveSimilarity: Number(semanticCalculation.effectiveSimilarity.toFixed(4)),
      },
      threshold,
      status,
      decision: status,
      isExempted,
      detectedRabbitHoles: semantic.detectedRabbitHoles,
      calibrationStats: getDriftCalibrationStats(),
      reason:
        status === 'BLOCK'
          ? semanticCalculation.reason || 'Agent output has insufficient goal overlap or contains a known rabbit-hole pattern.'
          : semanticCalculation.reason || 'Agent output remains aligned with the original goal.',
      circuitBreaker: {
        triggered: circuitEval.triggered,
        circuitStatus: circuitEval.circuitStatus,
        reason: circuitEval.reason,
      },
    };

    smartCache.set(cacheKey, responsePayload, 'simple');
    return res.json(responsePayload);
  }
);

// POST /api/v1/agent/guardrail/exemptions (or /feedback) - Flag false positive ("Đây KHÔNG phải rabbit-hole")
export const handleRecordGuardrailExemption = (req: AgentRequest, res: Response) => {
  const taskTitle = typeof req.body?.taskTitle === 'string' ? req.body.taskTitle.trim() : '';
  if (!taskTitle) {
    return res.status(400).json({ error: 'taskTitle is required' });
  }

  const taskId = typeof req.body?.taskId === 'string' && req.body.taskId ? req.body.taskId : `task_${randomUUID().slice(0, 8)}`;
  const coreGoalTitle = typeof req.body?.coreGoalTitle === 'string' ? req.body.coreGoalTitle.trim() : undefined;
  const userReason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : (req.body?.userReason || 'Flagged as valid task (not a rabbit hole)').trim();
  const isFalsePositive = req.body?.isFalsePositive !== false;

  const feedbackEntry = {
    id: `fb_${randomUUID().slice(0, 8)}`,
    taskId,
    taskTitle,
    coreGoalTitle,
    detectedType: req.body?.detectedType || 'over_engineering',
    isFalsePositive,
    userReason,
    timestamp: Date.now(),
  };

  serverDriftFeedbackStore.push(feedbackEntry);

  if (isFalsePositive) {
    addCalibrationRule(
      'DRIFT',
      taskId,
      `Tác vụ "${taskTitle}" được xác nhận là hợp lệ và cần thiết: ${userReason}`
    );
  }

  return res.status(201).json({
    contractVersion: 'agent.v1',
    status: 'EXEMPTION_RECORDED',
    message: `Recorded exemption for "${taskTitle}". Future drift checks will NOT flag this task as a rabbit hole.`,
    exemption: feedbackEntry,
    calibrationStats: getDriftCalibrationStats(),
    activeCalibrationRules: getActiveCalibrationRules(),
  });
};

export const handleGetGuardrailExemptions = (_req: Request, res: Response) => {
  const exemptions = serverDriftFeedbackStore.filter((f) => f.isFalsePositive);
  return res.json({
    contractVersion: 'agent.v1',
    totalExemptions: exemptions.length,
    exemptions,
    calibrationStats: getDriftCalibrationStats(),
    activeCalibrationRules: getActiveCalibrationRules(),
  });
};

export const handleDeleteGuardrailExemption = (req: Request, res: Response) => {
  const { id } = req.params;
  const idx = serverDriftFeedbackStore.findIndex((f) => f.id === id || f.taskId === id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Exemption not found' });
  }
  const removed = serverDriftFeedbackStore.splice(idx, 1)[0];
  return res.json({
    contractVersion: 'agent.v1',
    status: 'EXEMPTION_REMOVED',
    removed,
    calibrationStats: getDriftCalibrationStats(),
  });
};

agentRouter.post(
  '/socratic-decision',
  createRateLimitMiddleware('ai_standard', 1),
  requireAgentAuth,
  async (req: AgentRequest, res: Response) => {
    const dilemma = typeof req.body?.dilemma === 'string' ? req.body.dilemma.trim() : '';
    if (!dilemma) return res.status(400).json({ error: 'dilemma is required' });

    const result = await generateAgentDecision(dilemma, req.body?.context);
    return res.json({
      contractVersion: 'agent.v1',
      requestId: randomUUID(),
      agentId: req.agentId,
      ...result,
    });
  }
);

agentRouter.post(
  '/predict',
  createRateLimitMiddleware('ai_standard', 1),
  requireAgentAuth,
  async (req: AgentRequest, res: Response) => {
    const context = req.body?.context;
    if (!context || typeof context.title !== 'string' || !context.title.trim()) {
      return res.status(400).json({ error: 'context.title is required' });
    }

    const startedAt = Date.now();
    const result = await generateAgentPrediction(context);
    const predictionId = persistPredictionBestEffort(req as AuthRequest, context, result, startedAt);
    return res.json({
      contractVersion: 'agent.v1',
      requestId: randomUUID(),
      agentId: req.agentId,
      ...result,
      predictionId,
    });
  }
);

export const handleRecordOutcome = async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const rawOutcomeStatus = String(
      body.outcomeStatus || body.status || body.actualPath || 'SUCCESS'
    ).toUpperCase();

    let actualPath: 'optimal' | 'drift' | 'bottleneck' = 'optimal';
    let outcomeStatus = 'SUCCESS';

    if (['DRIFT', 'DRIFTING'].includes(rawOutcomeStatus) || body.actualPath === 'drift') {
      actualPath = 'drift';
      outcomeStatus = 'DRIFT';
    } else if (
      ['CRASH', 'ABANDONED', 'BOTTLENECK', 'FAIL', 'FAILED'].includes(rawOutcomeStatus) ||
      ['bottleneck', 'crash'].includes(body.actualPath)
    ) {
      actualPath = 'bottleneck';
      outcomeStatus = rawOutcomeStatus === 'ABANDONED' ? 'ABANDONED' : 'CRASH';
    } else {
      actualPath = 'optimal';
      outcomeStatus = 'SUCCESS';
    }

    const requestId = body.requestId || `req_${randomUUID().slice(0, 8)}`;
    let predictionId = body.predictionId || body.prediction_id;
    const isFalsePositiveDrift = Boolean(
      body.isFalsePositiveDrift || body.userFeedback?.isFalsePositiveDrift
    );
    const notes =
      typeof body.userFeedback?.notes === 'string'
        ? body.userFeedback.notes
        : typeof body.notes === 'string'
        ? body.notes
        : undefined;

    if (isFalsePositiveDrift) {
      serverDriftFeedbackStore.push({
        id: `fb_${randomUUID().slice(0, 8)}`,
        taskId: requestId,
        taskTitle: notes || 'False positive agent drift report',
        detectedType: 'over_engineering',
        isFalsePositive: true,
        userReason: notes || 'Flagged false positive by Agent/User',
        timestamp: Date.now(),
      });
    }

    let predictionSnapshot = predictionId ? await getPredictionById(predictionId) : null;

    if (!predictionId || !predictionSnapshot) {
      predictionId = predictionId || `pred_${randomUUID().slice(0, 8)}`;
      await insertPredictionSnapshot({
        id: predictionId,
        userUid: (req as any).user?.uid || null,
        context: { requestId, agentId: body.agentId },
        payload: { timelines: [{ pathType: actualPath, probability: 100 }] },
        driftProb: actualPath === 'drift' ? 100 : 0,
        crashProb: actualPath === 'bottleneck' ? 100 : 0,
        flowProb: actualPath === 'optimal' ? 100 : 0,
        predictedPath: actualPath,
        modelVersion: 'agent-feedback',
      });
      predictionSnapshot = await getPredictionById(predictionId);
    }

    const outcomeId = `out_${randomUUID().slice(0, 8)}`;
    await insertPredictionOutcome({
      id: outcomeId,
      predictionId,
      userUid: (req as any).user?.uid || null,
      actualPath,
      actualDriftScore: typeof body.actualDriftScore === 'number' ? body.actualDriftScore : null,
      source: ['auto', 'user', 'manual'].includes(body.source) ? body.source : 'auto',
      notes: notes || null,
    });

    if (outcomeStatus === 'DRIFT' || outcomeStatus === 'CRASH') {
      addCalibrationRule(outcomeStatus, requestId, notes);
    }

    const backtest = await runBacktest({
      from: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      to: new Date(),
      minAgeHours: 0,
    });

    const predictionMatched = predictionSnapshot
      ? predictionSnapshot.predictedPath === actualPath
      : true;
    const updatedAgentPrecisionScore = Number(
      (backtest.overallAccuracyScore * 100).toFixed(1)
    );

    return res.status(201).json({
      contractVersion: '1.0',
      status: 'RECORDED',
      outcomeId,
      requestId,
      predictionId,
      outcomeStatus,
      accuracyDelta: {
        predictionMatched,
        updatedAgentPrecisionScore,
      },
      accuracyMetrics: {
        overallAccuracyPercent: backtest.overallAccuracyPercent,
        sampleSize: backtest.sampleSize,
        driftHitRate: Math.round(backtest.driftHitRate * 100) / 100,
        crashHitRate: Math.round(backtest.crashHitRate * 100) / 100,
      },
      feedbackMemory: {
        updated: outcomeStatus === 'DRIFT' || outcomeStatus === 'CRASH',
        activeCalibrationRules: getActiveCalibrationRules(),
      },
    });
  } catch (error: any) {
    console.error('[api/outcomes] failed:', error?.message || error);
    return res.status(500).json({ error: 'outcome_processing_failed' });
  }
};

export const handleGetAccuracyScore = async (req: Request, res: Response) => {
  try {
    const requestedDays = Number(req.query.days ?? 30);
    const days = Number.isFinite(requestedDays) ? Math.min(90, Math.max(1, requestedDays)) : 30;
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

    const report = await runBacktest({ from, to, minAgeHours: 0 });
    const verdict = assertThresholds(report);

    return res.json({
      accuracyScore: report.overallAccuracyScore,
      accuracyPercent: report.overallAccuracyPercent,
      sampleSize: report.sampleSize,
      metrics: {
        driftHitRate: Math.round(report.driftHitRate * 100) / 100,
        crashHitRate: Math.round(report.crashHitRate * 100) / 100,
        optimalHitRate: Math.round(report.optimalHitRate * 100) / 100,
        falseAlarmRate: Math.round(report.falseAlarmRate * 100) / 100,
        crashPrecision: Math.round(report.crashPrecision * 100) / 100,
      },
      verdict,
      evaluationWindowDays: days,
    });
  } catch (error: any) {
    console.error('[accuracy-score] failed:', error?.message || error);
    return res.status(500).json({ error: 'accuracy_score_failed' });
  }
};

export const handleGetCircuitBreakerConfig = (_req: Request, res: Response) => {
  return res.json(getCircuitBreakerConfig());
};

export const handleUpdateCircuitBreakerConfig = (req: Request, res: Response) => {
  const body = req.body || {};
  const updated = updateCircuitBreakerConfig({
    maxDriftThreshold: typeof body.maxDriftThreshold === 'number' ? body.maxDriftThreshold : undefined,
    consecutiveFailureThreshold: typeof body.consecutiveFailureThreshold === 'number' ? body.consecutiveFailureThreshold : undefined,
    enableWebhook: typeof body.enableWebhook === 'boolean' ? body.enableWebhook : undefined,
    webhookUrl: typeof body.webhookUrl === 'string' ? body.webhookUrl : undefined,
  });
  return res.json({ success: true, config: updated });
};

agentRouter.post('/outcomes', requireAgentAuth, handleRecordOutcome);
agentRouter.post('/guardrail/exemptions', requireAgentAuth, handleRecordGuardrailExemption);
agentRouter.post('/guardrail/feedback', requireAgentAuth, handleRecordGuardrailExemption);
agentRouter.post('/guardrail/not-a-rabbit-hole', requireAgentAuth, handleRecordGuardrailExemption);
agentRouter.get('/guardrail/exemptions', handleGetGuardrailExemptions);
agentRouter.delete('/guardrail/exemptions/:id', requireAgentAuth, handleDeleteGuardrailExemption);
agentRouter.get('/accuracy-score', handleGetAccuracyScore);
agentRouter.get('/circuit-breaker/config', handleGetCircuitBreakerConfig);
agentRouter.post('/circuit-breaker/config', requireAgentAuth, handleUpdateCircuitBreakerConfig);
