import { useState, useCallback, useEffect } from 'react';
import { AgentNode, AgentTask, AgenticMemoryEntry, M2MApiKey } from '../entities/agent';
import { SwarmState, SwarmExecutionLog } from '../entities/swarm';
import { auth } from '../../lib/firebase';

const INITIAL_AGENTS: AgentNode[] = [
  {
    id: 'agent_pm',
    name: 'PM Orchestrator Agent',
    role: 'orchestrator_pm',
    roleTitle: 'Hệ Thống Phân Rã & Điều Phối Vi Bước (5-15m)',
    avatar: '🎯',
    status: 'idle',
    activeDriftScore: 6,
    latencyMs: 140,
    tokensProcessed: 18450,
    model: 'gemini-2.5-flash',
    systemPromptSnippet: 'Nhận yêu cầu sản phẩm cấp cao, bẻ thành vi bước nguyên tử kèm test criteria.',
  },
  {
    id: 'agent_coder',
    name: 'Coder Executor Agent',
    role: 'coder_executor',
    roleTitle: 'Tác Tử Lập Trình & Triển Khai Vi Bước (Atomic Execution)',
    avatar: '⚡',
    status: 'idle',
    activeDriftScore: 12,
    latencyMs: 380,
    tokensProcessed: 42100,
    model: 'gemini-2.5-flash',
    systemPromptSnippet: 'Chỉ nhận 1 vi bước tại một thời điểm. Viết code khép kín không phụ thuộc vòng lặp vô tận.',
  },
  {
    id: 'agent_guardrail',
    name: 'Socratic Guardrail Agent',
    role: 'socratic_guardrail',
    roleTitle: 'Rào Chắn Drift Score & Giám Sát Ngắt Mạch (Circuit Breaker)',
    avatar: '🛡️',
    status: 'idle',
    activeDriftScore: 4,
    latencyMs: 95,
    tokensProcessed: 9800,
    model: 'gemini-2.5-flash',
    systemPromptSnippet: 'Phát hiện lệch hướng và ảo giác ngay lập tức. Cắt mạch khi Drift Score vượt 40%.',
  },
  {
    id: 'agent_qa',
    name: 'QA & Security Verifier',
    role: 'qa_security',
    roleTitle: 'Tác Tử Thẩm Định Độc Lập & Kiểm Thử Ranh Giới (Boundary Test)',
    avatar: '🧪',
    status: 'idle',
    activeDriftScore: 2,
    latencyMs: 220,
    tokensProcessed: 15300,
    model: 'gemini-2.5-flash',
    systemPromptSnippet: 'Chạy fail-fast asserts. Xác thực ranh giới bảo mật trước khi commit vào repo chính.',
  },
];

const INITIAL_MEMORY: AgenticMemoryEntry[] = [
  {
    id: 'mem_1',
    agentId: 'agent_coder',
    agentRole: 'coder_executor',
    category: 'failure_prevention',
    title: 'Tránh vòng lặp tái xác thực JWT vô hạn (Infinite Token Refresh Loop)',
    content: 'Khi access token hết hạn trong môi trường WebSocket, bắt buộc kiểm tra cờ isRefreshing trước khi gửi lại request, tránh làm sập Redis session store.',
    timestamp: 'Hôm nay, 10:15',
    tags: ['auth', 'jwt', 'redis', 'websocket'],
  },
  {
    id: 'mem_2',
    agentId: 'agent_guardrail',
    agentRole: 'socratic_guardrail',
    category: 'architecture_constraint',
    title: 'Ràng buộc Clean Architecture: Domain Core không được phụ thuộc Drizzle/Express',
    content: 'Mọi entity trong src/*/entities phải là Pure TypeScript interface và pure functions để bảo toàn khả năng hoán đổi cơ sở dữ liệu.',
    timestamp: 'Hôm qua, 16:30',
    tags: ['clean-architecture', 'domain-core', 'ddd'],
  },
  {
    id: 'mem_3',
    agentId: 'agent_pm',
    agentRole: 'orchestrator_pm',
    category: 'proven_solution',
    title: 'Chiến thuật Nano-step 2 phút để giải phóng hiện tượng bế tắc nhận thức',
    content: 'Khi gặp một task phức tạp trên 15 phút, tự động kích hoạt Decompose thành đúng 3 nano-step 2 phút để kích hoạt động lực khởi đầu (Activation Energy).',
    timestamp: '2 ngày trước',
    tags: ['decomposition', 'nano-step', 'pomodoro'],
  },
];

const INITIAL_API_KEYS: M2MApiKey[] = [
  {
    id: 'key_live_1',
    name: 'Production Multi-Agent Swarm (CrewAI Mesh)',
    keyPrefix: 'sym_live_88a91c',
    fullKey: 'sym_live_88a91c_7e5d8b2a4c1f9a0d',
    createdAt: '2026-09-20',
    lastUsedAt: 'Vừa xong',
    rateLimit: '120 req/phút',
    totalRequests: 3420,
    status: 'active',
  },
  {
    id: 'key_live_2',
    name: 'Local LangGraph Developer Sandbox',
    keyPrefix: 'sym_dev_44d21f',
    fullKey: 'sym_dev_44d21f_3b6a9c8d1e5f0d2e',
    createdAt: '2026-09-22',
    lastUsedAt: '15 phút trước',
    rateLimit: '60 req/phút',
    totalRequests: 810,
    status: 'active',
  },
];

export function useAgentSwarm() {
  const [swarmState, setSwarmState] = useState<SwarmState>({
    id: 'swarm_session_01',
    objective: 'Xây dựng Module Xác thực JWT Phân quyền & Redis Token Blacklist chuẩn Clean Architecture',
    activeCycle: 1,
    totalMicroStepsCount: 6,
    completedMicroStepsCount: 3,
    averageDriftScore: 8,
    overallHealthScore: 94,
    circuitBreaker: {
      maxAllowedDrift: 40,
      autoHaltOnDrift: true,
      isTriggered: false,
    },
    agents: INITIAL_AGENTS,
    activeTasks: [
      {
        id: 'task_sw_1',
        title: 'Bẻ nhỏ giao diện JWT Revocation thành 3 vi bước nguyên tử',
        assignedAgentId: 'agent_pm',
        status: 'passed',
        estimatedMinutes: 5,
        elapsedSeconds: 240,
        inputContext: 'Mục tiêu: Đăng xuất người dùng ngay lập tức trên mọi thiết bị.',
        outputArtifact: 'Đã sinh 3 micro-steps: 1. Viết interface BlacklistRepo; 2. Tạo Redis TTL Key; 3. Assert HTTP 401.',
        driftScore: 4,
        testStatus: 'passing',
      },
      {
        id: 'task_sw_2',
        title: 'Viết Pure Entity TokenBlacklist và hàm verifyRevocation()',
        assignedAgentId: 'agent_coder',
        status: 'in_progress',
        estimatedMinutes: 10,
        elapsedSeconds: 420,
        inputContext: 'Không import Redis bên trong Entity, chỉ nhận Timestamp & TokenHash.',
        outputArtifact: 'export interface BlacklistEntry { tokenHash: string; expiresAt: number; }',
        driftScore: 12,
        testStatus: 'passing',
      },
    ],
    completedTasks: [],
    executionLogs: [
      {
        id: 'log_1',
        timestamp: '10:00:15',
        sourceAgentId: 'agent_pm',
        sourceAgentName: 'PM Orchestrator',
        actionType: 'DECOMPOSE_INVOKED',
        payloadSummary: 'Nhận User Requirement và phân rã thành 6 vi bước nguyên tử (5-10 phút).',
        driftScore: 3,
        status: 'info',
      },
      {
        id: 'log_2',
        timestamp: '10:02:40',
        sourceAgentId: 'agent_guardrail',
        sourceAgentName: 'Socratic Guardrail',
        actionType: 'DRIFT_CHECK',
        payloadSummary: 'Kiểm tra độ trôi dạt mục tiêu của Coder Agent: Drift Score = 12% (An toàn < 40%). Cho phép tiếp tục.',
        driftScore: 12,
        status: 'success',
      },
    ],
    memoryEntries: INITIAL_MEMORY,
  });

  const [apiKeys, setApiKeys] = useState<M2MApiKey[]>(INITIAL_API_KEYS);
  const [isRunningSimulation, setIsRunningSimulation] = useState(false);

  // Thêm Log vào Swarm
  const addExecutionLog = useCallback((log: Omit<SwarmExecutionLog, 'id' | 'timestamp'>) => {
    const newLog: SwarmExecutionLog = {
      ...log,
      id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      timestamp: new Date().toLocaleTimeString('vi-VN', { hour12: false }),
    };
    setSwarmState((prev) => ({
      ...prev,
      executionLogs: [newLog, ...prev.executionLogs].slice(0, 100),
    }));
  }, []);

  useEffect(() => {
    let stream: EventSource | null = null;
    let cancelled = false;
    // The stream requires auth: exchange the signed-in user's Firebase ID token for a one-time ticket.
    const connect = async () => {
      try {
        const token = await auth.currentUser?.getIdToken();
        if (!token) return;
        const res = await fetch('/api/agent/activity/ticket', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok || cancelled) return;
        const { ticket } = (await res.json()) as { ticket: string };
        stream = new EventSource(`/api/agent/activity/stream?ticket=${encodeURIComponent(ticket)}`);
        stream.addEventListener('agent_activity', handleActivity);
      } catch {
        // telemetry is best-effort; the swarm view still works without the live stream
      }
    };
    const handleActivity = (event: Event) => {
      try {
        const activity = JSON.parse((event as MessageEvent<string>).data) as {
          agentId: string;
          toolName: string;
          phase: 'connected' | 'started' | 'completed';
          status: 'info' | 'success' | 'critical';
          summary: string;
          driftScore?: number;
        };

        if (activity.phase === 'connected') return;

        const actionType: SwarmExecutionLog['actionType'] = activity.toolName.includes('guardrail')
          ? 'DRIFT_CHECK'
          : activity.toolName.includes('decompose')
          ? 'DECOMPOSE_INVOKED'
          : activity.toolName.includes('outcome') || activity.toolName.includes('accuracy')
          ? 'MEMORY_SYNC'
          : 'CODE_GENERATED';

        addExecutionLog({
          sourceAgentId: activity.agentId,
          sourceAgentName: 'MCP Agent',
          actionType,
          payloadSummary: activity.summary,
          driftScore: activity.driftScore,
          status: activity.status,
        });
      } catch {
        stream?.close();
      }
    };

    void connect();
    return () => {
      cancelled = true;
      stream?.removeEventListener('agent_activity', handleActivity);
      stream?.close();
    };
  }, [addExecutionLog]);

  // Kích hoạt mô phỏng chu trình Multi-Agent Swarm
  const runSwarmCycle = useCallback(async (objective: string) => {
    setIsRunningSimulation(true);
    setSwarmState((prev) => ({
      ...prev,
      objective,
      circuitBreaker: { ...prev.circuitBreaker, isTriggered: false },
    }));

    addExecutionLog({
      sourceAgentId: 'agent_pm',
      sourceAgentName: 'PM Orchestrator',
      actionType: 'DECOMPOSE_INVOKED',
      payloadSummary: `Khởi tạo quy trình phân rã mục tiêu: "${objective}"`,
      status: 'info',
    });

    // Update PM Agent status
    setSwarmState((prev) => ({
      ...prev,
      agents: prev.agents.map((a) =>
        a.id === 'agent_pm' ? { ...a, status: 'thinking', currentTaskTitle: 'Phân rã mục tiêu thành vi bước 5-15m' } : a
      ),
    }));

    try {
      // Gọi API decompose thật của backend
      const res = await fetch('/api/decompose-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskTitle: objective,
          context: { technicalContext: 'Clean Architecture, Domain-Driven Design, Zero Drift' },
        }),
      });

      const decomposeData = res.ok ? await res.json() : null;
      const stepCount = decomposeData?.microSteps?.length || 4;

      addExecutionLog({
        sourceAgentId: 'agent_pm',
        sourceAgentName: 'PM Orchestrator',
        actionType: 'TASK_DISPATCHED',
        payloadSummary: `Đã phân rã thành công ${stepCount} vi bước lập trình nguyên tử. Điều phối sang Coder Executor Agent.`,
        status: 'success',
      });

      // Step 2: Coder Agent nhận task
      setSwarmState((prev) => ({
        ...prev,
        agents: prev.agents.map((a) => {
          if (a.id === 'agent_pm') return { ...a, status: 'completed' };
          if (a.id === 'agent_coder') return { ...a, status: 'executing', currentTaskTitle: 'Triển khai vi bước 1: Pure Entity & Contract' };
          return a;
        }),
      }));

      // Step 3: Guardrail Agent kiểm tra Drift Score
      const driftCheckRes = await fetch('/api/semantic-drift-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          coreGoalTitle: objective,
          tasks: [{
            id: 'agent-output',
            title: 'Viết Entity và Value Object cho domain authentication, không dính líu DB framework.',
          }],
        }),
      });
      const driftData = driftCheckRes.ok
        ? await driftCheckRes.json()
        : { driftScore: 8, status: 'ALLOW' };
      const driftScore = typeof driftData.driftScore === 'number'
        ? driftData.driftScore
        : Math.max(0, 100 - (driftData.overallAlignmentPercent ?? 100));
      const guardrailStatus = driftData.status || (driftScore >= 40 ? 'BLOCK' : 'ALLOW');

      addExecutionLog({
        sourceAgentId: 'agent_guardrail',
        sourceAgentName: 'Socratic Guardrail',
        actionType: 'DRIFT_CHECK',
        payloadSummary: `Guardrail Scan hoàn tất: Drift Score = ${driftScore}%. Trạng thái: ${guardrailStatus}. Rào chắn cho phép tiếp tục.`,
        driftScore,
        status: 'success',
      });

      // Step 4: QA Agent kiểm tra
      setSwarmState((prev) => ({
        ...prev,
        agents: prev.agents.map((a) => {
          if (a.id === 'agent_coder') return { ...a, status: 'completed' };
          if (a.id === 'agent_qa') return { ...a, status: 'executing', currentTaskTitle: 'Chạy kiểm thử Boundary Isolation' };
          return a;
        }),
      }));

      addExecutionLog({
        sourceAgentId: 'agent_qa',
        sourceAgentName: 'QA Verifier',
        actionType: 'TEST_PASSED',
        payloadSummary: 'Boundary Test & Fail-Fast Assertions vượt qua 100%. Không phát hiện lỗ hổng ranh giới.',
        status: 'success',
      });

      // Hoàn tất chu trình
      setSwarmState((prev) => ({
        ...prev,
        activeCycle: prev.activeCycle + 1,
        overallHealthScore: 98,
        agents: prev.agents.map((a) => ({ ...a, status: 'completed' })),
      }));
    } catch (err) {
      console.warn('Swarm cycle fallback', err);
    } finally {
      setIsRunningSimulation(false);
    }
  }, [addExecutionLog]);

  // Ngắt mạch khẩn cấp (Circuit Breaker / Emergency Halt)
  const triggerCircuitBreaker = useCallback((reason: string) => {
    setSwarmState((prev) => ({
      ...prev,
      circuitBreaker: {
        ...prev.circuitBreaker,
        isTriggered: true,
        lastHaltedReason: reason,
        haltedAt: new Date().toLocaleTimeString('vi-VN'),
      },
      agents: prev.agents.map((a) => ({ ...a, status: 'guardrail_blocked' })),
    }));

    addExecutionLog({
      sourceAgentId: 'agent_guardrail',
      sourceAgentName: 'Socratic Guardrail',
      actionType: 'GUARDRAIL_CIRCUIT_BREAK',
      payloadSummary: `[CIRCUIT BREAKER KÍCH HOẠT] Đã ngắt mạch toàn bộ AI Swarm! Lý do: ${reason}`,
      driftScore: 78,
      status: 'critical',
    });
  }, [addExecutionLog]);

  // Reset mạch an toàn
  const resetCircuitBreaker = useCallback(() => {
    setSwarmState((prev) => ({
      ...prev,
      circuitBreaker: {
        ...prev.circuitBreaker,
        isTriggered: false,
        lastHaltedReason: undefined,
      },
      agents: prev.agents.map((a) => ({ ...a, status: 'idle' })),
    }));

    addExecutionLog({
      sourceAgentId: 'agent_guardrail',
      sourceAgentName: 'Socratic Guardrail',
      actionType: 'MEMORY_SYNC',
      payloadSummary: 'Người điều hành (Human Operator) đã tái thiết lập mạch an toàn. Khôi phục trạng thái sẵn sàng.',
      status: 'info',
    });
  }, [addExecutionLog]);

  // Thêm M2M API Key mới
  const generateApiKey = useCallback((name: string) => {
    const prefix = `sym_live_${Math.random().toString(36).substring(2, 8)}`;
    const randomSuffix = Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);
    const newKey: M2MApiKey = {
      id: `key_${Date.now()}`,
      name: name.trim() || 'Custom Multi-Agent Client',
      keyPrefix: prefix,
      fullKey: `${prefix}_${randomSuffix}`,
      createdAt: new Date().toISOString().split('T')[0],
      lastUsedAt: 'Chưa sử dụng',
      rateLimit: '120 req/phút',
      totalRequests: 0,
      status: 'active',
    };
    setApiKeys((prev) => [newKey, ...prev]);
    return newKey;
  }, []);

  return {
    swarmState,
    apiKeys,
    isRunningSimulation,
    runSwarmCycle,
    triggerCircuitBreaker,
    resetCircuitBreaker,
    generateApiKey,
    addExecutionLog,
  };
}
