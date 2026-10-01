import { serverConfig } from '../../serverConfig.ts';

export interface CircuitBreakerConfig {
  maxDriftThreshold: number;
  consecutiveFailureThreshold: number;
  enableWebhook: boolean;
  webhookUrl: string;
}

export interface CircuitBreakerTriggerPayload {
  event: 'CIRCUIT_BREAKER_TRIGGERED';
  timestamp: string;
  agentId: string;
  requestId: string;
  severity: 'CRITICAL' | 'HIGH' | 'WARNING';
  driftMetrics: {
    driftScore: number;
    detectedPatterns: string[];
    recommendedAction: string;
  };
  circuitStatus: 'OPEN' | 'CLOSED';
  reason: string;
}

let globalConfig: CircuitBreakerConfig = {
  maxDriftThreshold: 65,
  consecutiveFailureThreshold: 3,
  enableWebhook: true,
  webhookUrl: process.env.SYMFLOWAGE_WEBHOOK_URL || '',
};

const consecutiveFailureMap = new Map<string, number>();
const sseSubscribers = new Set<{ callback: (payload: any) => void; scope: string }>();

export function getCircuitBreakerConfig(): CircuitBreakerConfig {
  return {
    ...globalConfig,
    webhookUrl: globalConfig.webhookUrl || process.env.SYMFLOWAGE_WEBHOOK_URL || '',
  };
}

export function updateCircuitBreakerConfig(newConfig: Partial<CircuitBreakerConfig>): CircuitBreakerConfig {
  globalConfig = {
    ...globalConfig,
    ...newConfig,
  };
  return getCircuitBreakerConfig();
}

export function registerSseAlertSubscriber(callback: (payload: any) => void, scope = 'legacy') {
  const entry = { callback, scope };
  sseSubscribers.add(entry);
  return () => {
    sseSubscribers.delete(entry);
  };
}

export async function sendOutboundWebhook(payload: CircuitBreakerTriggerPayload, targetUrl?: string) {
  const url = targetUrl || globalConfig.webhookUrl || process.env.SYMFLOWAGE_WEBHOOK_URL;
  if (!url) return false;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return res.ok;
  } catch (err: any) {
    console.warn('[CircuitBreaker] Outbound webhook dispatch failed:', err?.message || err);
    return false;
  }
}

export function notifySseSubscribers(payload: any, scope = 'legacy') {
  for (const subscriber of sseSubscribers) {
    if (subscriber.scope !== scope) continue;
    try {
      subscriber.callback(payload);
    } catch (err) {
      // Ignore subscriber errors
    }
  }
}

export interface EvaluateCircuitInput {
  agentId?: string;
  requestId?: string;
  driftScore: number;
  decision?: 'ALLOW' | 'WARN' | 'BLOCK' | string;
  detectedPatterns?: string[];
  recommendedAction?: string;
  customWebhookUrl?: string;
  /** Isolation scope (see agentScope); defaults to the legacy pool. */
  scope?: string;
}

export function evaluateAndTriggerCircuitBreaker(input: EvaluateCircuitInput) {
  const config = getCircuitBreakerConfig();
  const agentId = input.agentId || 'agent_m2m_client';
  const scope = input.scope || 'legacy';
  const requestId = input.requestId || `req_${Math.random().toString(36).slice(2, 10)}`;
  const driftScore = input.driftScore ?? 0;
  const decision = (input.decision || 'ALLOW').toUpperCase();
  const patterns = input.detectedPatterns || [];

  const isFailed = driftScore >= config.maxDriftThreshold || decision === 'BLOCK';
  // agent ids are client-chosen, so failure streaks are tracked per scope to stop cross-tenant interference
  const failureKey = `${scope}:${agentId}`;
  let currentFailures = consecutiveFailureMap.get(failureKey) || 0;

  if (isFailed) {
    currentFailures += 1;
    consecutiveFailureMap.set(failureKey, currentFailures);
  } else {
    consecutiveFailureMap.set(failureKey, 0);
  }

  const triggeredByDrift = driftScore >= config.maxDriftThreshold;
  const triggeredByBlock = decision === 'BLOCK';
  const triggeredByConsecutive = currentFailures >= config.consecutiveFailureThreshold;

  const isTriggered = triggeredByDrift || triggeredByBlock || triggeredByConsecutive;

  if (isTriggered) {
    const reasonParts: string[] = [];
    if (triggeredByDrift) reasonParts.push(`Drift Score (${driftScore}%) exceeded safety threshold (${config.maxDriftThreshold}%)`);
    if (triggeredByBlock) reasonParts.push(`M2M Decision returned BLOCK due to critical pattern`);
    if (triggeredByConsecutive) reasonParts.push(`Consecutive failure count (${currentFailures}) reached threshold (${config.consecutiveFailureThreshold})`);

    const reason = reasonParts.join('; ');

    const triggerPayload: CircuitBreakerTriggerPayload = {
      event: 'CIRCUIT_BREAKER_TRIGGERED',
      timestamp: new Date().toISOString(),
      agentId,
      requestId,
      severity: 'CRITICAL',
      driftMetrics: {
        driftScore,
        detectedPatterns: patterns.length > 0 ? patterns : ['semantic_drift_detected'],
        recommendedAction: input.recommendedAction || 'Gỡ rối tác vụ và quay lại Core Goal',
      },
      circuitStatus: 'OPEN',
      reason,
    };

    const sseAlertData = {
      type: 'CIRCUIT_BREAKER',
      requestId,
      agentId,
      action: 'HALT_EXECUTION',
      reason,
      circuitStatus: 'OPEN',
      driftScore,
      timestamp: triggerPayload.timestamp,
    };

    // Dispatch Webhook non-blocking
    if (config.enableWebhook) {
      void sendOutboundWebhook(triggerPayload, input.customWebhookUrl);
    }

    // Broadcast SSE alerts
    notifySseSubscribers(sseAlertData, scope);

    return {
      triggered: true,
      circuitStatus: 'OPEN' as const,
      reason,
      payload: triggerPayload,
      sseAlertData,
    };
  }

  return {
    triggered: false,
    circuitStatus: 'CLOSED' as const,
    reason: 'Drift and execution metrics within safe operational parameters.',
  };
}
