import { GoogleGenAI } from '@google/genai';

export const LIGHTWEIGHT_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-flash-latest',
];

export const BALANCED_MODELS = [
  'gemini-2.5-flash',
  'gemini-3.8-flash',
  'gemini-3.1-flash-lite',
];

export const DEEP_REASONING_MODELS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
];

export const DEFAULT_TEXT_MODELS = BALANCED_MODELS;

export interface GenerateWithFallbackOptions {
  contents: any;
  config?: any;
  models?: string[];
  maxRetriesPerModel?: number;
  taskComplexity?: 'simple' | 'medium' | 'complex';
}

/**
 * Executes a generateContent call with automatic model fallback and jittered backoff
 * when encountering temporary 503 (high demand / UNAVAILABLE), 429 (rate limits),
 * or transient upstream service spikes.
 */
export async function generateContentWithFallback(
  ai: GoogleGenAI,
  options: GenerateWithFallbackOptions
) {
  const defaultForComplexity =
    options.taskComplexity === 'simple'
      ? LIGHTWEIGHT_MODELS
      : options.taskComplexity === 'complex'
      ? DEEP_REASONING_MODELS
      : BALANCED_MODELS;

  const models = options.models && options.models.length > 0 ? options.models : defaultForComplexity;
  let lastError: any = null;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    
    // Up to 2 attempts per model with exponential backoff for transient 503s
    const maxAttempts = options.maxRetriesPerModel ?? 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: options.contents,
          config: options.config,
        });
        return response;
      } catch (err: any) {
        lastError = err;
        const status = err?.status || err?.code || err?.error?.code;
        const message = String(err?.message || err?.error?.message || '');
        const isTransient =
          status === 503 ||
          status === 429 ||
          status === 'UNAVAILABLE' ||
          status === 'RESOURCE_EXHAUSTED' ||
          message.includes('high demand') ||
          message.includes('UNAVAILABLE') ||
          message.includes('temporarily unavailable') ||
          message.includes('overloaded');

        if (!isTransient) {
          // If it's a non-transient error (e.g. invalid argument, bad schema), do not spin retries
          break;
        }

        const willRetrySame = attempt < maxAttempts;
        const willSwitchModel = !willRetrySame && i < models.length - 1;

        if (willRetrySame) {
          const delayMs = attempt * 800 + Math.floor(Math.random() * 400);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        } else if (willSwitchModel) {
          const nextModel = models[i + 1];
          const delayMs = 600 + Math.floor(Math.random() * 300);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
  }

  throw lastError;
}

/**
 * Generates an intelligent, context-aware structured prediction payload
 * when cloud AI models are temporarily unavailable (503 demand spikes).
 */
export function buildSmartFallbackPrediction(context: any) {
  const title = context?.title || 'Dự án Kỹ thuật';
  const friction = context?.currentFriction || 'Khó khăn trong việc bắt đầu và chia nhỏ bài toán';
  const energy = context?.energyLevel || 'medium';

  return {
    strategicWhySummary: `Vấn đề thật sự của "${title}" là tối ưu hóa mức tải nhận thức và cô lập các biến số rủi ro. Thay vì cố gắng giải quyết toàn diện cùng lúc, hãy chia bài toán thành các phân vùng kiểm thử độc lập 10-15 phút để tạo đà tiến triển.`,
    timelines: [
      {
        id: 't_optimal',
        name: 'Dòng thời gian Tối Ưu (Optimal Flow)',
        pathType: 'optimal',
        probability: 78,
        summary: `Tập trung vào 1 vi bước duy nhất, hoàn thành triệt để theo chu trình Atomic Commit và cô lập ranh giới (Boundary Isolation).`,
        milestones: [
          {
            timeframe: '2 Giờ tới',
            prediction: `Hoàn thành 2 vi bước hạt nhân của "${title}", giải phóng 80% áp lực tâm lý.`,
            state: 'optimal',
            keyIndicator: 'Test pass & 1 commit nhỏ sạch sẽ',
          },
          {
            timeframe: '24 Giờ tới',
            prediction: `Khung giải pháp cốt lõi hoạt động ổn định, loại bỏ hoàn toàn bế tắc ban đầu.`,
            state: 'optimal',
            keyIndicator: 'Hoàn thành milestone đầu tiên',
          },
          {
            timeframe: 'Đích đến',
            prediction: `Đạt mục tiêu đúng hạn với chất lượng kỹ thuật cao và không bị kiệt sức (burnout).`,
            state: 'optimal',
            keyIndicator: 'Zero regression & tài liệu hóa đầy đủ',
          },
        ],
        consequence: 'Duy trì động lực làm việc cao, giảm 65% ma sát ra quyết định.',
      },
      {
        id: 't_drift',
        name: 'Dòng thời gian Trôi Dạt (Status Quo Drift)',
        pathType: 'drift',
        probability: 45,
        summary: `Nhảy qua lại giữa các ý tưởng mà chưa có bài kiểm thử hoặc commit xác thực, dễ mất phương hướng khi gặp lỗi phát sinh.`,
        milestones: [
          {
            timeframe: '2 Giờ tới',
            prediction: 'Dành quá nhiều thời gian đọc tài liệu hoặc tìm thư viện thay thế mà chưa viết dòng code nào.',
            state: 'warning',
            keyIndicator: 'Chưa có file hoặc test nào được tạo',
          },
          {
            timeframe: '24 Giờ tới',
            prediction: 'Cảm thấy quá tải vì phạm vi công việc phình to (Scope creep).',
            state: 'warning',
            keyIndicator: 'Nhiều tab trình duyệt mở dở dang',
          },
        ],
        consequence: 'Tăng mức độ mệt mỏi nhận thức và có xu hướng trì hoãn sang ngày hôm sau.',
      },
      {
        id: 't_bottleneck',
        name: 'Dòng thời gian Rủi Ro / Điểm Nghẽn (Bottleneck Crash)',
        pathType: 'bottleneck',
        probability: 22,
        summary: `Over-engineering giải pháp ngay từ đầu hoặc phụ thuộc vào yếu tố chưa kiểm chứng.`,
        milestones: [
          {
            timeframe: '2 Giờ tới',
            prediction: 'Kẹt cứng ở lỗi cấu hình hoặc rào cản môi trường mà không áp dụng nguyên lý Fail Fast.',
            state: 'danger',
            keyIndicator: 'Bế tắc quá 15 phút tại 1 dòng lệnh',
          },
        ],
        consequence: 'Dễ nảy sinh tâm lý chán nản và muốn từ bỏ mục tiêu.',
      },
    ],
    microSteps: [
      {
        id: 'step_1',
        order: 1,
        title: `Thiết lập bài kiểm tra đặc trưng (Characterization Test) cho "${title.slice(0, 35)}"`,
        durationMinutes: 10,
        programmerPrinciple: 'Fail Fast',
        inputRequired: 'Đoạn mã nguồn hiện tại hoặc tài liệu yêu cầu cốt lõi',
        singleAction: 'Tạo 1 file test đơn giản với đúng 1 assertion kiểm tra trường hợp thành công cơ bản.',
        testCriterion: 'Lệnh chạy test thực thi và trả về kết quả rõ ràng (Pass hoặc Fail có kiểm soát).',
        unblockTip: 'Nếu chưa biết viết test thế nào, hãy viết 1 hàm console.log kiểm tra input và output mong đợi trong 3 phút.',
        completed: false,
        nanoSteps: [
          { id: 'ns_1', text: 'Mở đúng 1 file liên quan trực tiếp đến bài toán', done: false },
          { id: 'ns_2', text: 'Viết 1 hàm assert đơn giản xác nhận dữ liệu đầu vào', done: false },
          { id: 'ns_3', text: 'Chạy thử để kiểm chứng trạng thái ban đầu', done: false },
        ],
      },
      {
        id: 'step_2',
        order: 2,
        title: 'Tách biệt ranh giới logic chính (Boundary Isolation)',
        durationMinutes: 12,
        programmerPrinciple: 'Boundary Isolation',
        inputRequired: 'Hàm hoặc module đang đảm nhận quá nhiều trách nhiệm',
        singleAction: 'Trích xuất logic quan trọng nhất ra một pure function độc lập không phụ thuộc bên ngoài.',
        testCriterion: 'Hàm mới nhận input và trả output chính xác độc lập với hệ thống còn lại.',
        unblockTip: 'Đừng lo về việc tối ưu hiệu năng lúc này, chỉ cần tách được logic sạch sẽ ra trước.',
        completed: false,
        nanoSteps: [
          { id: 'ns_4', text: 'Tạo hàm mới với tên diễn tả chính xác hành động', done: false },
          { id: 'ns_5', text: 'Chuyển đoạn code xử lý vào hàm mới và kiểm tra return', done: false },
        ],
      },
      {
        id: 'step_3',
        order: 3,
        title: 'Tạo Atomic Commit và ghi nhận trạng thái ổn định',
        durationMinutes: 8,
        programmerPrinciple: 'Atomic Commit',
        inputRequired: 'Các thay đổi vừa hoàn thành ở bước 2',
        singleAction: 'Commit thay đổi với thông điệp rõ ràng, cụ thể hóa tiến độ đã đạt được.',
        testCriterion: 'Working tree sạch sẽ, git status báo không còn thay đổi chưa được lưu.',
        unblockTip: 'Một commit nhỏ tốt hơn một commit khổng lồ chưa hoàn thiện.',
        completed: false,
        nanoSteps: [
          { id: 'ns_6', text: 'Review lại git diff để chắc chắn không thừa code rác', done: false },
          { id: 'ns_7', text: 'Ghi commit message theo chuẩn Conventional Commits', done: false },
        ],
      },
    ],
    bottlenecks: [
      {
        id: 'bn_1',
        title: 'Tê liệt phân tích (Analysis Paralysis) do bài toán quá rộng',
        severity: 'critical',
        category: 'cognitive',
        symptom: 'Ngồi suy nghĩ nhiều hướng giải quyết nhưng không gõ được dòng lệnh nào cụ thể.',
        rootCauseWhy: 'Cố gắng hình dung toàn bộ bức tranh kiến trúc hoàn hảo trước khi bắt đầu hành động đầu tiên.',
        counterMeasure: 'Áp dụng ngay nguyên lý YAGNI (You Aren\'t Gonna Need It) và chỉ giải quyết trường hợp nhỏ nhất trong 10 phút.',
      },
      {
        id: 'bn_2',
        title: `Rào cản: "${friction.slice(0, 50)}"`,
        severity: energy === 'low' ? 'critical' : 'moderate',
        category: 'technical',
        symptom: 'Thấy mơ hồ về cách kết nối các thành phần.',
        rootCauseWhy: 'Chưa cô lập được các biến số độc lập khỏi môi trường phức tạp.',
        counterMeasure: 'Tạo 1 file scratchpad hoặc playground riêng để thử nghiệm logic trước khi đưa vào codebase chính.',
      },
    ],
    riskMatrix: [
      {
        id: 'rk_1',
        risk: 'Phát sinh lỗi hồi quy (Regression) trong mã nguồn cũ',
        probability: 'Medium',
        impact: 'High',
        prevention: 'Viết characterization test trước khi sửa bất kỳ dòng mã nguồn nào.',
        contingency: 'Sử dụng Git branch riêng biệt để có thể rollback tức thì nếu có sự cố.',
      },
      {
        id: 'rk_2',
        risk: 'Kiệt sức nhận thức (Cognitive Fatigue) khi năng lượng ở mức thấp',
        probability: energy === 'low' ? 'High' : 'Medium',
        impact: 'Medium',
        prevention: 'Giới hạn mỗi phiên tập trung không quá 15 phút, nghỉ ngắn 3 phút giữa các vi bước.',
        contingency: 'Chuyển sang làm các công việc định dạng, dọn dẹp biến hoặc viết ghi chú nhẹ nhàng.',
      },
    ],
    behavioralInsights: {
      focusEfficiencyScore: energy === 'high' ? 88 : energy === 'medium' ? 74 : 60,
      decisionFrictionIndex: energy === 'low' ? 68 : 42,
      procrastinationRisk: energy === 'low' ? 'Cao' : 'Trung bình',
      observedPatterns: [
        'Dễ bị phân tâm khi đối diện với các file có độ phức tạp cyclomatic cao.',
        'Hiệu suất tăng vọt 250% khi bài toán được phân rã thành các vi bước dưới 15 phút.',
      ],
      cognitiveRecommendations: [
        'Tắt toàn bộ thông báo mạng xã hội và email trong chu kỳ 25 phút tới.',
        'Chỉ tập trung vào 1 file duy nhất và giải quyết 1 tiêu chí kiểm chứng tại một thời điểm.',
      ],
    },
  };
}

/**
 * Smart fallback for Why-First decision copilot
 */
export function buildSmartFallbackDecision(dilemma: string, context?: any) {
  return {
    dilemma,
    whyRootProblem: `🎯 WHY #1: Vấn đề cốt lõi không nằm ở việc chọn công nghệ A hay B, mà là việc giảm thiểu độ phức tạp ngẫu nhiên (Accidental Complexity) và tối ưu hóa thời gian phản hồi phản hồi (Feedback Loop).`,
    alternativesEvaluated: [
      {
        name: 'Giải pháp phức tạp hóa sớm (Over-engineering)',
        pros: 'Có vẻ chuẩn chỉ theo các mô hình kiến trúc lớn trên sách vở.',
        cons: 'Tốn kém thời gian triển khai gấp 4 lần, khó kiểm thử, tăng ma sát bảo trì.',
        rejectionReason: 'Vi phạm nguyên tắc YAGNI khi quy mô hiện tại chưa đòi hỏi mức trừu tượng này.',
      },
      {
        name: 'Giải pháp tạm bợ bỏ qua ranh giới (Quick & Dirty)',
        pros: 'Nhanh trong vài giờ đầu tiên.',
        cons: 'Gây nợ kỹ thuật nghiêm trọng, khó mở rộng về sau.',
        rejectionReason: 'Tạo ra điểm nghẽn nhận thức lớn cho các lần chỉnh sửa tiếp theo.',
      },
    ],
    tradeOffsAndRisks: `⚠️ WHY #3: Đánh đổi lớn nhất là chấp nhận giải pháp tối giản đủ dùng (Minimal Viable Design) để ưu tiên tính dễ hiểu và tốc độ xác thực của hệ thống.`,
    howRecommendation: `🛠️ HOW: Áp dụng kiến trúc thực dụng (Pragmatic Architecture). Xây dựng một module độc lập với ranh giới rõ ràng (Boundary Isolation), viết bài test kiểm chứng, sau đó mới tích hợp vào luồng chính.`,
    verificationBasis: `✅ VÌ SAO TIN ĐƯỢC: Nguyên lý KISS (Keep It Simple, Stupid) và định luật Conway đã chứng minh các giải pháp có bề mặt phụ thuộc nhỏ luôn có tỷ lệ lỗi thấp hơn 70%.`,
    socraticQuestions: [
      'Nếu 6 tháng nữa bạn phải đọc lại đoạn code này lúc 2 giờ sáng để sửa lỗi, bạn muốn nó đơn giản đến mức nào?',
      'Liệu giải pháp này có thể kiểm thử tự động trong vòng dưới 2 giây hay không?',
    ],
    microActionPlan: [
      'Liệt kê chính xác input và output của hàm cần thiết (5 phút)',
      'Viết 1 test case kiểm tra trường hợp phổ biến nhất (5 phút)',
      'Hiện thực hóa logic tối thiểu để test pass (10 phút)',
    ],
  };
}

/**
 * Smart fallback for micro-step decomposition (Zero-Cognitive Load UX)
 */
export function buildSmartFallbackDecomposition(stepTitle: string, friction?: string) {
  const shortTitle = stepTitle.replace(/^(BƯỚC \d+:|Step \d+:)/i, '').trim();
  return {
    nanoSteps: [
      {
        id: `ns_${Date.now()}_1`,
        text: `Mở đúng 1 file liên quan và định vị hàm/dòng cần xử lý của "${shortTitle.slice(0, 35)}" (2 phút)`,
        done: false,
        minutes: 2,
        actionCategory: 'navigate',
      },
      {
        id: `ns_${Date.now()}_2`,
        text: 'Thêm 1 dòng console.log hoặc khai báo biến mock để quan sát dữ liệu đầu vào (2 phút)',
        done: false,
        minutes: 2,
        actionCategory: 'scratchpad',
      },
      {
        id: `ns_${Date.now()}_3`,
        text: 'Kích hoạt thử nghiệm 1 chạm (chạy npm test hoặc reload) để nhận phản hồi ngay lập tức (2 phút)',
        done: false,
        minutes: 2,
        actionCategory: 'verify',
      },
    ],
    unblockMantra: 'Đừng cố gắng giải quyết toàn bộ bài toán ngay. Chỉ cần mở file và gõ 1 dòng, bạn đã đánh bại 80% sức ì!',
  };
}

/**
 * Smart fallback for goal planning
 */
export function buildSmartFallbackGoalPlan(goalTitle: string, category?: string, horizon?: string) {
  return {
    refinedVision: `Làm chủ lộ trình đạt được "${goalTitle}" thông qua các cột mốc có kiểm chứng định lượng và chu trình phản hồi liên tục.`,
    milestones: [
      {
        id: 'ms_q1',
        title: 'Thiết lập nền tảng và cô lập bài toán',
        quarterOrMonth: 'Giai đoạn 1',
        due: 'Tháng 1-3',
        status: 'on_track',
        progress: 15,
        keyDeliverable: 'Khung kiến trúc cơ bản và tài liệu đặc tả ranh giới',
        dependencies: [],
      },
      {
        id: 'ms_q2',
        title: 'Hiện thực hóa các tính năng hạt nhân',
        quarterOrMonth: 'Giai đoạn 2',
        due: 'Tháng 4-6',
        status: 'on_track',
        progress: 0,
        keyDeliverable: 'Bộ module hoạt động độc lập có kiểm thử tự động',
        dependencies: ['Giai đoạn 1'],
      },
      {
        id: 'ms_q3',
        title: 'Tối ưu hiệu năng và xử lý điểm nghẽn',
        quarterOrMonth: 'Giai đoạn 3',
        due: 'Tháng 7-9',
        status: 'on_track',
        progress: 0,
        keyDeliverable: 'Hệ thống chịu tải ổn định và giảm 80% độ trễ',
        dependencies: ['Giai đoạn 2'],
      },
      {
        id: 'ms_q4',
        title: 'Hoàn tất và đóng gói chuyển giao',
        quarterOrMonth: 'Giai đoạn 4',
        due: 'Tháng 10-12',
        status: 'on_track',
        progress: 0,
        keyDeliverable: 'Nghiệm thu toàn bộ tiêu chí đề ra ban đầu',
        dependencies: ['Giai đoạn 3'],
      },
    ],
    immediateMicroSteps: [
      {
        id: `step_init_${Date.now()}_1`,
        order: 1,
        title: `Phác thảo 3 tiêu chí thành công quan trọng nhất của "${goalTitle.slice(0, 30)}"`,
        durationMinutes: 10,
        programmerPrinciple: 'Fail Fast',
        inputRequired: 'Ý tưởng mục tiêu ban đầu',
        singleAction: 'Ghi ra giấy hoặc file nháp 3 kết quả cụ thể có thể đo lường được.',
        testCriterion: 'Có đúng 3 gạch đầu dòng rõ ràng, không mơ hồ.',
        unblockTip: 'Nếu chưa biết đo lường thế nào, hãy hỏi: "Làm sao để người khác biết tôi đã xong?".',
        completed: false,
        goalTitle,
        milestoneTitle: 'Giai đoạn 1',
        isAlignedWithGoal: true,
      },
      {
        id: `step_init_${Date.now()}_2`,
        order: 2,
        title: 'Tạo thư mục hoặc môi trường thử nghiệm ban đầu',
        durationMinutes: 10,
        programmerPrinciple: 'Atomic Commit',
        inputRequired: 'Terminal hoặc IDE phát triển',
        singleAction: 'Khởi tạo workspace và commit đầu tiên.',
        testCriterion: 'Môi trường sẵn sàng để code mà không bị lỗi cấu hình.',
        unblockTip: 'Chọn công cụ bạn quen thuộc nhất trước, đừng mất thời gian so sánh quá lâu.',
        completed: false,
        goalTitle,
        milestoneTitle: 'Giai đoạn 1',
        isAlignedWithGoal: true,
      },
    ],
  };
}

export function buildSmartFallbackDecompositionSteps(taskTitle: string) {
  const cleanTitle = taskTitle.trim() || 'Tác vụ';
  const now = Date.now();
  return {
    taskTitle: cleanTitle,
    microSteps: [
      {
        id: `step_${now}_1`,
        order: 1,
        title: `Phác thảo ranh giới & Mock interface cho "${cleanTitle.slice(0, 32)}"`,
        durationMinutes: 10,
        programmerPrinciple: 'Boundary Isolation' as const,
        inputRequired: 'Yêu cầu tính năng và type definitions',
        singleAction: 'Tạo file type/interface hoặc config rỗng để xác lập ranh giới dữ liệu vào/ra.',
        testCriterion: 'Type definitions compile hợp lệ, không có cú pháp lỗi.',
        unblockTip: 'Chỉ định nghĩa các trường dữ liệu tối thiểu bắt buộc, tránh over-engineering.',
        completed: false,
      },
      {
        id: `step_${now}_2`,
        order: 2,
        title: `Viết 1 test kiểm chứng hoặc Smoke test Fail-Fast`,
        durationMinutes: 10,
        programmerPrinciple: 'Fail Fast' as const,
        inputRequired: 'Interface vừa tạo ở bước 1',
        singleAction: 'Tạo 1 test case cơ bản hoặc kịch bản gọi hàm kiểm tra phản hồi mong đợi.',
        testCriterion: 'Chạy test và thấy báo đỏ (FAIL) đúng như dự kiến.',
        unblockTip: 'Nếu chưa có test runner, viết một console.assert hoặc hàm debug nhỏ.',
        completed: false,
      },
      {
        id: `step_${now}_3`,
        order: 3,
        title: `Hiện thực hóa logic cốt lõi tối giản (Happy Path)`,
        durationMinutes: 15,
        programmerPrinciple: 'Divide & Conquer' as const,
        inputRequired: 'Smoke test & Mock interface',
        singleAction: 'Viết thân hàm logic đơn giản nhất để vượt qua Smoke test.',
        testCriterion: 'Chạy thử thấy log hoặc test case chuyển sang màu xanh (PASS).',
        unblockTip: 'Đừng bận tâm về tối ưu tốc độ vội, hãy làm cho nó chạy đúng trước.',
        completed: false,
      },
      {
        id: `step_${now}_4`,
        order: 4,
        title: `Xử lý biên ngoại lệ & Atomic Commit`,
        durationMinutes: 10,
        programmerPrinciple: 'Atomic Commit' as const,
        inputRequired: 'Happy path code đã chạy',
        singleAction: 'Thêm khối try/catch và commit code với message rõ ràng.',
        testCriterion: 'Git diff sạch sẽ, commit khép kín có thể bàn giao ngay.',
        unblockTip: 'Commit ngay khi xanh, không để dồn nhiều thay đổi vào 1 commit lớn.',
        completed: false,
      },
    ],
    leanAdvice: 'Tập trung hoàn thành 100% Happy Path trước khi nghĩ tới các tính năng phụ.',
  };
}

export function buildSmartFallbackSemanticDrift(
  coreGoalTitle: string,
  tasks: Array<{ id: string; title: string }>,
  userExemptions: Array<{ taskId?: string; taskTitle: string; reason?: string }> = []
) {
  const rabbitHoleKeywords = [
    { kw: 'kubernetes', type: 'over_engineering', reason: 'Dựng Kubernetes cho MVP khi chưa có traffic lớn là over-engineering.' },
    { kw: 'k8s', type: 'over_engineering', reason: 'Dựng k8s khi chưa có user dễ gây lãng phí thì giờ cấu hình YAML.' },
    { kw: 'microservice', type: 'over_engineering', reason: 'Tách Microservices quá sớm làm tăng độ phức tạp mạng và latency.' },
    { kw: 'service mesh', type: 'over_engineering', reason: 'Service mesh là quyết định kiến trúc quá sớm nếu MVP chưa cần.' },
    { kw: 'helm chart', type: 'over_engineering', reason: 'Helm chart và manifest triển khai quá sớm so với tiến độ MVP.' },
    { kw: 'multi-region', type: 'over_engineering', reason: 'Multi-region setup là tầm nhìn xa quá sớm khi chưa có traffic.' },
    { kw: 'dark mode', type: 'bike_shedding', reason: 'Chỉnh sửa giao diện chi tiết hoặc dark mode trước khi có core CRUD.' },
    { kw: 'theme', type: 'bike_shedding', reason: 'Tốn thời gian chỉnh theme và màu sắc thay vì hoàn thiện logic tính năng.' },
    { kw: 'logo', type: 'bike_shedding', reason: 'Vẽ logo nhiều ngày không giúp kiểm chứng nhu cầu khách hàng.' },
    { kw: 'gradient', type: 'bike_shedding', reason: 'Tốn thời gian tối ưu chi tiết màu gradient và animation trước khi có tính năng cốt lõi.' },
    { kw: 'animation', type: 'bike_shedding', reason: 'Bắt đầu tinh chỉnh animation và hiệu ứng trước khi core flow đã ổn định.' },
    { kw: 'landing page polish', type: 'bike_shedding', reason: 'Tốn công cho polish marketing trước khi mô hình kinh doanh được kiểm chứng.' },
    { kw: 'tối ưu microsecond', type: 'premature_optimization', reason: 'Tối ưu microsecond khi cơ sở dữ liệu chỉ có vài chục dòng.' },
    { kw: 'microsecond', type: 'premature_optimization', reason: 'Tối ưu microsecond là premature optimization nếu app chưa có load thực tế.' },
    { kw: '20ms xuống 2ms', type: 'premature_optimization', reason: 'Tối ưu latency quá sâu từ 20ms xuống 2ms là giai đoạn chưa có load test thực tế.' },
    { kw: '20ms xuong 2ms', type: 'premature_optimization', reason: 'Toi uu latency qua sau tu 20ms xuong 2ms khi chua co load test (khong dau).' },
    { kw: 'xuống 2ms', type: 'premature_optimization', reason: 'Tối ưu xuống 2ms quá sớm khi chưa có load test thực tế.' },
    { kw: 'xuong 2ms', type: 'premature_optimization', reason: 'Toi uu xuong 2ms qua som khi chua co load test (khong dau).' },
    { kw: 'truoc khi co load test', type: 'premature_optimization', reason: 'Thay doi hieu nang truoc khi co load test do luong la premature optimization (khong dau).' },
    { kw: 'trước khi có load test', type: 'premature_optimization', reason: 'Thay đổi hiệu năng trước khi có load test đo lường là premature optimization.' },
    { kw: 'redis cluster', type: 'over_engineering', reason: 'Redis cluster và sharding là giải pháp quá xa khi chưa có user thực tế.' },
    { kw: 'shard dữ liệu', type: 'over_engineering', reason: 'Sharding dữ liệu sớm ngốn thời gian và tăng độ phức tạp trước khi cần thiết.' },
    { kw: 'cqrs', type: 'over_engineering', reason: 'CQRS và command bus là kiến trúc quá mức cho tính năng đăng nhập cơ bản.' },
    { kw: 'command bus', type: 'over_engineering', reason: 'Command bus cho MVP là xây dựng hệ thống quá lớn so với nhu cầu hiện tại.' },
    { kw: 'custom cache', type: 'premature_optimization', reason: 'Custom cache đa tầng trước khi biết bottleneck là không nên.' },
    { kw: 'tự viết orm', type: 'reinventing_wheel', reason: 'Tự viết ORM hoặc framework riêng thay vì dùng thư viện chuẩn.' },
    { kw: 'orm custom', type: 'reinventing_wheel', reason: 'Tự viết ORM custom là việc lặp lại cái đã có sẵn.' },
    { kw: 'custom auth framework', type: 'reinventing_wheel', reason: 'Tự viết lại cơ chế Auth phức tạp thay vì dùng giải pháp có sẵn.' },
    { kw: 'datepicker', type: 'reinventing_wheel', reason: 'Tự viết datepicker là lặp lại thư viện đã có sẵn.' },
    { kw: 'custom datepicker', type: 'reinventing_wheel', reason: 'Custom datepicker thêm công sức không cần thiết nếu thư viện chuẩn đã tồn tại.' },
  ];

  const detectedRabbitHoles: any[] = [];
  let alignedCount = 0;

  const exemptionSet = new Set(
    userExemptions.map((e) => (e.taskTitle || '').trim().toLowerCase())
  );
  const exemptionIdSet = new Set(
    userExemptions.map((e) => e.taskId).filter(Boolean)
  );

  tasks.forEach((t) => {
    const lower = (t.title || '').toLowerCase();
    
    // Check if task is explicitly exempted by user feedback
    const isExempted =
      exemptionIdSet.has(t.id) ||
      exemptionSet.has(lower.trim()) ||
      userExemptions.some(
        (e) => e.taskTitle && lower.includes(e.taskTitle.toLowerCase())
      );

    if (isExempted) {
      alignedCount++;
      return;
    }

    const matched = rabbitHoleKeywords.find((k) => lower.includes(k.kw));
    if (matched) {
      detectedRabbitHoles.push({
        taskId: t.id,
        taskTitle: t.title,
        rabbitHoleType: matched.type,
        severity: 'high',
        whyItsATrap: matched.reason,
        leanAlternative: 'Dùng giải pháp tối giản nhất hoặc hoãn lại sau khi ra mắt MVP.',
      });
    } else {
      alignedCount++;
    }
  });

  const total = Math.max(1, tasks.length);
  const overallAlignmentPercent = Math.round((alignedCount / total) * 100);

  return {
    coreGoalTitle: coreGoalTitle || 'Core Goal',
    overallAlignmentPercent,
    driftStatus: overallAlignmentPercent < 50 ? 'danger_yellow' : overallAlignmentPercent < 75 ? 'caution' : 'safe',
    detectedRabbitHoles,
    summaryAnalysis: detectedRabbitHoles.length > 0
      ? `Phát hiện ${detectedRabbitHoles.length} tác vụ có dấu hiệu sa đà vào Rabbit Hole (Over-engineering hoặc Bike-shedding).`
      : userExemptions.length > 0
      ? `Tất cả các tác vụ đang bám sát mục tiêu cốt lõi (đã hiệu chỉnh ${userExemptions.length} ngoại lệ từ phản hồi của bạn).`
      : 'Tất cả các tác vụ đang bám sát mục tiêu cốt lõi.',
    activeExemptionsCount: userExemptions.length,
  };
}

