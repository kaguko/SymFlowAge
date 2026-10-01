import { db, reportDbFallback } from './index.ts';
import { notes, users } from './schema.ts';
import { eq, desc, sql } from 'drizzle-orm';
import { ai } from '../lib/ai.ts';

export interface NoteItem {
  id: number;
  userUid: string;
  title: string;
  category: string;
  content: string;
  tags: string;
  metadata?: Record<string, any>;
  isActive?: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface SemanticSearchResult extends NoteItem {
  similarity: number; // 0 to 1
  distance: number;
}

export interface JsonbQueryAnalysisResult {
  querySql: string;
  strategyUsed: 'GIN (jsonb_ops)' | 'GIN (jsonb_path_ops)' | 'Expression B-Tree' | 'Partial Index' | 'None (Sequential Scan)';
  isAntiPattern: boolean;
  antiPatternWarning?: string;
  estimatedCost: {
    indexScanType: 'Index Scan' | 'Bitmap Heap Scan' | 'Sequential Scan (Full Table Scan)';
    storageOverheadRelative: string;
    executionTimeMs: number;
    bufferReads: number;
  };
  recommendation: string;
}

// In-Memory store fallback when PostgreSQL is offline or unprovisioned
interface InMemoryNoteRecord extends NoteItem {
  embedding?: number[];
}

const inMemoryNotes = new Map<number, InMemoryNoteRecord>();
let inMemoryNoteIdCounter = 1;
const inMemoryUsers = new Map<string, { id: number; uid: string; email: string }>();

/**
 * Computes cosine similarity between two numeric vectors in [-1, 1] normalized to [0, 1].
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  const rawCos = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Math.max(0, Math.min(1, rawCos));
}

export function projectTo768(rawValues: number[]): number[] {
  const result = new Array(768).fill(0);
  for (let i = 0; i < 768; i++) {
    result[i] = rawValues[i % rawValues.length] || 0;
  }
  const norm = Math.sqrt(result.reduce((sum, v) => sum + v * v, 0)) || 1;
  return result.map((v) => v / norm);
}

export function createDeterministicVector(text: string, dimensions = 768): number[] {
  const vector = new Array(dimensions).fill(0);
  const normalized = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim();

  const words = normalized.split(/\s+/).filter(Boolean);

  // Semantic concept clusters in software development (bilingual EN & VN)
  const conceptClusters: Record<string, string[]> = {
    auth_delivery: ['login', 'auth', 'oauth', 'token', 'jwt', 'session', 'signup', 'user', 'profile', 'password', 'dang nhap', 'dang ky', 'xac thuc', 'tai khoan', 'nguoi dung'],
    db_delivery: ['database', 'db', 'schema', 'migration', 'table', 'drizzle', 'postgres', 'postgresql', 'sql', 'query', 'model', 'crud', 'tao bang', 'du lieu', 'co so du lieu', 'bang'],
    api_delivery: ['api', 'route', 'endpoint', 'rest', 'express', 'handler', 'request', 'response', 'middleware', 'controller', 'dieu huong', 'xu ly'],
    test_delivery: ['test', 'unit', 'spec', 'e2e', 'integration', 'verify', 'validation', 'check', 'smoke', 'playwright', 'jest', 'kiem thu', 'kiem tra', 'xac thuc du lieu'],
    shipping_delivery: ['ship', 'mvp', 'build', 'launch', 'release', 'deploy', 'production', 'feature', 'app', 'product', 'xay dung', 'phat trien', 'ra mat', 'tinh nang'],
    fix_delivery: ['fix', 'bug', 'issue', 'patch', 'error', 'exception', 'refactor', 'clean', 'lint', 'stabilize', 'sua loi', 'toi uu code', 'chuan hoa', 'tai cau truc'],
    commerce_delivery: ['checkout', 'payment', 'stripe', 'cart', 'order', 'billing', 'subscription', 'webhook', 'invoice', 'thanh toan', 'don hang', 'gio hang', 'hoa don'],
    frontend_delivery: ['ui', 'form', 'modal', 'component', 'view', 'page', 'button', 'input', 'giao dien', 'bieu mau'],
  };

  // Base semantic baseline for general software engineering domain
  const engineeringBaseHash = 9973;
  for (let b = 0; b < 32; b++) {
    const idx = (engineeringBaseHash * (b + 1)) % dimensions;
    vector[idx] += 0.05;
  }

  // Activate concept cluster dimensions
  for (const [clusterKey, keywords] of Object.entries(conceptClusters)) {
    const hasMatch = words.some((w) => keywords.some((kw) => w.includes(kw) || kw.includes(w)));
    if (hasMatch) {
      let clusterHash = 17;
      for (let i = 0; i < clusterKey.length; i++) {
        clusterHash = (clusterHash * 37) ^ clusterKey.charCodeAt(i);
      }
      for (let k = 0; k < 16; k++) {
        const idx = Math.abs((clusterHash * (k + 1)) % dimensions);
        vector[idx] += 0.8;
      }
      // General delivery synergy (connecting all productive engineering work)
      for (let k = 0; k < 8; k++) {
        const idx = Math.abs((engineeringBaseHash * (k + 7)) % dimensions);
        vector[idx] += 0.5;
      }
    }
  }

  // Token and n-gram embedding
  words.forEach((word, wIdx) => {
    let wordHash = 5381;
    for (let i = 0; i < word.length; i++) {
      wordHash = (wordHash * 33) ^ word.charCodeAt(i);
    }
    const bucket = Math.abs(wordHash) % dimensions;
    vector[bucket] += 1.0 / (1 + wIdx * 0.05);

    for (let i = 0; i <= word.length - 3; i++) {
      const trigram = word.substring(i, i + 3);
      let triHash = 0;
      for (let j = 0; j < 3; j++) {
        triHash = (triHash << 5) - triHash + trigram.charCodeAt(j);
      }
      const triBucket = Math.abs(triHash) % dimensions;
      vector[triBucket] += 0.35;
    }
  });

  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

export type EmbeddingSource = 'gemini' | 'deterministic-fallback';

/**
 * Generates 768-dimensional normalized embedding vectors with resilient multi-tier fallback.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  return (await generateEmbeddingWithSource(text)).vector;
}

export async function generateEmbeddingWithSource(
  text: string
): Promise<{ vector: number[]; source: EmbeddingSource }> {
  if (ai) {
    // text-embedding-004 / embedding-001 are retired (404 on embedContent); keep as last-resort candidates.
    const candidateModels = ['gemini-embedding-001', 'text-embedding-004'];
    for (const modelName of candidateModels) {
      try {
        const response: any = await ai.models.embedContent({
          model: modelName,
          contents: text,
          config: { outputDimensionality: 768 },
        });
        const values = response?.embedding?.values || response?.embeddings?.[0]?.values;
        if (Array.isArray(values) && values.length > 0) {
          if (values.length === 768) {
            // Truncated (MRL) embeddings are not unit-length; normalise so cosine is well-behaved.
            const norm = Math.sqrt(values.reduce((sum: number, v: number) => sum + v * v, 0)) || 1;
            return { vector: values.map((v: number) => v / norm), source: 'gemini' };
          }
          return { vector: projectTo768(values), source: 'gemini' };
        }
      } catch {
        // Silently try next model candidate or fallback
      }
    }
  }

  // Resilient 768-dim normalized semantic vector generator (L2 Unit Vector)
  return { vector: createDeterministicVector(text, 768), source: 'deterministic-fallback' };
}

export class SemanticUnavailableError extends Error {
  constructor() {
    super('Semantic embeddings unavailable (no Gemini embedding) and SYMFLOWAGE_REQUIRE_SEMANTIC=1.');
    this.name = 'SemanticUnavailableError';
  }
}

// Archetypes of developer rabbit holes. The agent output is compared against these in vector space,
// so paraphrases the keyword list never saw ("set up a cluster orchestrator") are still caught.
const RABBIT_HOLE_PROTOTYPES: Array<{ type: string; text: string; reason: string }> = [
  {
    type: 'over_engineering',
    text: 'Set up kubernetes, microservices, service mesh, multi-region clusters, CQRS, sharding and heavy infrastructure before having any users',
    reason: 'Kiến trúc/hạ tầng quy mô lớn trước khi MVP có người dùng thực tế.',
  },
  {
    type: 'premature_optimization',
    text: 'Micro-optimize latency, build multi-layer custom caches and tune performance before any load test or measured bottleneck',
    reason: 'Tối ưu hiệu năng trước khi có số liệu đo lường.',
  },
  {
    type: 'bike_shedding',
    text: 'Polish logo, theme, dark mode, gradients, animations and landing page visuals instead of building the core feature',
    reason: 'Chỉnh giao diện/thẩm mỹ thay vì hoàn thiện tính năng cốt lõi.',
  },
  {
    type: 'reinventing_wheel',
    text: 'Write our own ORM, auth framework, datepicker or standard library from scratch instead of using an existing well-known library',
    reason: 'Tự viết lại thứ thư viện chuẩn đã có sẵn.',
  },
];

const SEMANTIC_RABBIT_HOLE_MIN_SIM = 0.6;
const SEMANTIC_RABBIT_HOLE_MIN_MARGIN = 0.12;
const prototypeEmbeddingCache = new Map<string, Promise<{ vector: number[]; source: EmbeddingSource }>>();

function embedPrototype(text: string) {
  let cached = prototypeEmbeddingCache.get(text);
  if (!cached) {
    cached = generateEmbeddingWithSource(text);
    prototypeEmbeddingCache.set(text, cached);
    // Do not pin a failed/fallback result forever
    cached.then((r) => r.source !== 'gemini' && prototypeEmbeddingCache.delete(text)).catch(() => prototypeEmbeddingCache.delete(text));
  }
  return cached;
}

export interface SemanticRabbitHole {
  rabbitHoleType: string;
  similarity: number;
  whyItsATrap: string;
}

export interface SemanticDriftCalculationResult {
  driftScore: number;
  cosineSimilarity: number;
  deliveryAlignmentSimilarity: number;
  effectiveSimilarity: number;
  reason: string;
  embeddingSource: EmbeddingSource;
  semanticRabbitHoles: SemanticRabbitHole[];
}

/**
 * Calculates continuous semantic vector drift score using embeddings and cosineSimilarity.
 * Evaluates semantic distance between originalGoal, delivery actions, and agentOutput.
 */
export async function calculateSemanticDriftScore(
  originalGoal: string,
  agentOutput: string,
  options: {
    detectedRabbitHoles?: any[];
    isExempted?: boolean;
  } = {}
): Promise<SemanticDriftCalculationResult> {
  if (options.isExempted) {
    return {
      driftScore: 0,
      cosineSimilarity: 1.0,
      deliveryAlignmentSimilarity: 1.0,
      effectiveSimilarity: 1.0,
      reason: 'Tác vụ đã được người dùng xác nhận là ngoại lệ hợp lệ (Exemption).',
      embeddingSource: 'gemini',
      semanticRabbitHoles: [],
    };
  }

  // 1. Generate 768-dim embeddings in parallel
  const [goalEmb, outputEmb, deliveryEmb] = await Promise.all([
    generateEmbeddingWithSource(originalGoal || 'Software Delivery Goal'),
    generateEmbeddingWithSource(agentOutput || ''),
    generateEmbeddingWithSource(`${originalGoal} software delivery, bug fix, core feature, validation, database, auth, testing, shipping MVP`),
  ]);

  const goalVec = goalEmb.vector;
  const outputVec = outputEmb.vector;
  const deliveryContextVec = deliveryEmb.vector;
  const embeddingSource: EmbeddingSource =
    [goalEmb, outputEmb, deliveryEmb].every((e) => e.source === 'gemini') ? 'gemini' : 'deterministic-fallback';

  // 2. Compute Cosine Similarities
  const directSim = cosineSimilarity(goalVec, outputVec);
  const deliverySim = cosineSimilarity(deliveryContextVec, outputVec);
  const effectiveSim = Math.max(directSim, deliverySim);

  if (process.env.SYMFLOWAGE_REQUIRE_SEMANTIC === '1' && embeddingSource !== 'gemini') {
    throw new SemanticUnavailableError();
  }

  // 3. Rabbit-hole detection in vector space (only meaningful with real embeddings).
  const semanticRabbitHoles: SemanticRabbitHole[] = [];
  if (embeddingSource === 'gemini') {
    const protos = await Promise.all(RABBIT_HOLE_PROTOTYPES.map((p) => embedPrototype(p.text)));
    protos.forEach((p, i) => {
      const sim = cosineSimilarity(p.vector, outputVec);
      if (sim >= SEMANTIC_RABBIT_HOLE_MIN_SIM && sim - directSim >= SEMANTIC_RABBIT_HOLE_MIN_MARGIN) {
        semanticRabbitHoles.push({
          rabbitHoleType: RABBIT_HOLE_PROTOTYPES[i].type,
          similarity: sim,
          whyItsATrap: RABBIT_HOLE_PROTOTYPES[i].reason,
        });
      }
    });
    semanticRabbitHoles.sort((a, b) => b.similarity - a.similarity);
  }

  const keywordHit = !!options.detectedRabbitHoles && options.detectedRabbitHoles.length > 0;
  if (keywordHit || semanticRabbitHoles.length > 0) {
    // Continuous score driven by how much closer the output is to a rabbit-hole archetype than to the goal.
    // A literal keyword match is corroborating evidence and is treated as at least a 0.15 margin.
    const bestRabbitSim = semanticRabbitHoles[0]?.similarity ?? 0;
    const margin = Math.max(bestRabbitSim - directSim, keywordHit ? 0.15 : 0);
    const calculatedPenalty = Math.min(95, Math.max(60, Math.round(55 + margin * 100 + (1 - directSim) * 10)));
    const labels = [
      ...(options.detectedRabbitHoles || []).map((r) => r.type || r.taskTitle || 'rabbit-hole'),
      ...semanticRabbitHoles.map((r) => `${r.rabbitHoleType} ~${(r.similarity * 100).toFixed(0)}%`),
    ];
    return {
      driftScore: calculatedPenalty,
      cosineSimilarity: directSim,
      deliveryAlignmentSimilarity: deliverySim,
      effectiveSimilarity: effectiveSim,
      embeddingSource,
      semanticRabbitHoles,
      reason: `Phát hiện bẫy kỹ thuật kiến trúc (${labels.join(', ')}).`,
    };
  }

  // 4. Grounded Continuous Semantic Calculation based on Vector Space
  let calculatedDrift: number;
  let reason: string;

  if (effectiveSim >= 0.40) {
    // Strong semantic alignment with goal or goal delivery
    calculatedDrift = Math.round(Math.max(5, Math.min(25, (1 - effectiveSim) * 35)));
    reason = `Tác vụ bám sát trực tiếp mục tiêu phát triển cốt lõi (Cosine Sim: ${(effectiveSim * 100).toFixed(1)}%).`;
  } else if (effectiveSim >= 0.25) {
    // Moderate semantic alignment (supporting / utility task)
    calculatedDrift = Math.round(Math.max(15, Math.min(35, 15 + (1 - effectiveSim) * 30)));
    reason = `Tác vụ có liên kết ngữ nghĩa gián tiếp với mục tiêu (Cosine Sim: ${(effectiveSim * 100).toFixed(1)}%).`;
  } else {
    // Low semantic overlap with both goal and standard delivery
    calculatedDrift = Math.round(Math.min(75, Math.max(50, 50 + (1 - effectiveSim) * 40)));
    reason = `Tác vụ có độ tương đồng ngữ nghĩa thấp với mục tiêu đã định (Cosine Sim: ${(effectiveSim * 100).toFixed(1)}%).`;
  }

  return {
    driftScore: calculatedDrift,
    cosineSimilarity: directSim,
    deliveryAlignmentSimilarity: deliverySim,
    effectiveSimilarity: effectiveSim,
    reason,
    embeddingSource,
    semanticRabbitHoles,
  };
}

export async function getOrCreateUserRecord(uid: string, email: string) {
  try {
    const existing = await db.select().from(users).where(eq(users.uid, uid)).limit(1);
    if (existing.length > 0) return existing[0];

    const inserted = await db.insert(users).values({ uid, email }).returning();
    return inserted[0];
  } catch (error) {
    reportDbFallback('getOrCreateUserRecord', error);
    if (!inMemoryUsers.has(uid)) {
      inMemoryUsers.set(uid, { id: inMemoryUsers.size + 1, uid, email });
    }
    return inMemoryUsers.get(uid)!;
  }
}

export async function getUserNotes(userUid: string): Promise<NoteItem[]> {
  try {
    const results = await db
      .select({
        id: notes.id,
        userUid: notes.userUid,
        title: notes.title,
        category: notes.category,
        content: notes.content,
        tags: notes.tags,
        createdAt: notes.createdAt,
        updatedAt: notes.updatedAt,
      })
      .from(notes)
      .where(eq(notes.userUid, userUid))
      .orderBy(desc(notes.createdAt));
    if (results && results.length > 0) return results;
  } catch (error) {
    reportDbFallback('getUserNotes', error);
  }

  // Return in-memory notes for userUid
  const list: NoteItem[] = [];
  for (const item of inMemoryNotes.values()) {
    if (item.userUid === userUid || !userUid) {
      list.push({
        id: item.id,
        userUid: item.userUid,
        title: item.title,
        category: item.category,
        content: item.content,
        tags: item.tags,
        metadata: item.metadata,
        isActive: item.isActive,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      });
    }
  }
  return list.sort((a, b) => ((b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0)));
}

export async function insertNoteWithEmbedding(
  userUid: string,
  title: string,
  category: string,
  content: string,
  tags: string,
  embedding: number[]
) {
  const newId = inMemoryNoteIdCounter++;
  const now = new Date();
  const memoryNote: InMemoryNoteRecord = {
    id: newId,
    userUid,
    title,
    category,
    content,
    tags,
    embedding,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };
  try {
    const vectorStr = `[${embedding.join(',')}]`;
    const result = await db.execute(
      sql`INSERT INTO notes (user_uid, title, category, content, tags, embedding, created_at, updated_at)
          VALUES (${userUid}, ${title}, ${category}, ${content}, ${tags}, ${vectorStr}::vector, NOW(), NOW())
          RETURNING id, user_uid as "userUid", title, category, content, tags, created_at as "createdAt", updated_at as "updatedAt"`
    );
    if (result.rows && result.rows[0]) {
      return result.rows[0];
    }
  } catch (error) {
    // DB unavailable: keep the note in memory so it is not lost while degraded
    reportDbFallback('insertNoteWithEmbedding', error);
    inMemoryNotes.set(newId, memoryNote);
  }

  return {
    id: memoryNote.id,
    userUid: memoryNote.userUid,
    title: memoryNote.title,
    category: memoryNote.category,
    content: memoryNote.content,
    tags: memoryNote.tags,
    createdAt: memoryNote.createdAt,
    updatedAt: memoryNote.updatedAt,
  };
}

export async function deleteNote(id: number, userUid: string) {
  inMemoryNotes.delete(id);
  try {
    await db.delete(notes).where(sql`${notes.id} = ${id} AND ${notes.userUid} = ${userUid}`);
    return true;
  } catch (error) {
    reportDbFallback('deleteNote', error);
    return true;
  }
}

export async function searchNotesSemantic(
  userUid: string,
  queryEmbedding: number[],
  limit: number = 5,
  minSimilarity: number = 0.25
): Promise<SemanticSearchResult[]> {
  try {
    const vectorStr = `[${queryEmbedding.join(',')}]`;
    const result = await db.execute(
      sql`SELECT 
            id, 
            user_uid as "userUid", 
            title, 
            category, 
            content, 
            tags, 
            created_at as "createdAt", 
            updated_at as "updatedAt",
            (1 - (embedding <=> ${vectorStr}::vector)) AS similarity,
            (embedding <=> ${vectorStr}::vector) AS distance
          FROM notes
          WHERE user_uid = ${userUid} AND embedding IS NOT NULL
          ORDER BY embedding <=> ${vectorStr}::vector ASC
          LIMIT ${limit}`
    );

    if (result.rows && result.rows.length > 0) {
      return result.rows
        .map((row: Record<string, unknown>) => {
          const createdRaw = row.createdAt;
          const updatedRaw = row.updatedAt;
          const createdAt =
            typeof createdRaw === 'string' || typeof createdRaw === 'number' || createdRaw instanceof Date
              ? new Date(createdRaw as string | number | Date)
              : null;
          const updatedAt =
            typeof updatedRaw === 'string' || typeof updatedRaw === 'number' || updatedRaw instanceof Date
              ? new Date(updatedRaw as string | number | Date)
              : null;
          return {
            id: Number(row.id),
            userUid: String(row.userUid),
            title: String(row.title),
            category: String(row.category || 'Ghi chú'),
            content: String(row.content),
            tags: String(row.tags || ''),
            metadata: (row.metadata as Record<string, any>) || {},
            isActive: row.isActive !== false,
            createdAt,
            updatedAt,
            similarity: Math.max(0, Math.min(1, Number(row.similarity || 0))),
            distance: Number(row.distance || 0),
          };
        })
        .filter((item: { similarity: number }) => item.similarity >= minSimilarity);
    }
  } catch (error) {
    reportDbFallback('searchNotesSemantic', error);
  }

  // Calculate similarity in memory
  const scored: SemanticSearchResult[] = [];
  for (const item of inMemoryNotes.values()) {
    if (item.userUid === userUid || !userUid) {
      const sim = item.embedding ? cosineSimilarity(queryEmbedding, item.embedding) : 0.3;
      if (sim >= minSimilarity) {
        scored.push({
          id: item.id,
          userUid: item.userUid,
          title: item.title,
          category: item.category,
          content: item.content,
          tags: item.tags,
          metadata: item.metadata,
          isActive: item.isActive,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          similarity: sim,
          distance: 1 - sim,
        });
      }
    }
  }

  return scored.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}

/**
 * Simulates and analyzes PostgreSQL execution plan for JSONB query strategies.
 * Evaluates whether a query leverages GIN (jsonb_ops / jsonb_path_ops), Expression B-Tree,
 * Partial Index, or falls into the Anti-Pattern (Seq Scan).
 */
export function analyzeJsonbQueryPlan(
  operator: '@>' | '?' | '->>' | '->' | 'BETWEEN',
  indexType: 'gin_ops' | 'gin_path_ops' | 'expression_btree' | 'partial_index' | 'none',
  hasPartialCondition: boolean = false,
  sampleKey: string = 'priority',
  sampleValue: string = 'high'
): JsonbQueryAnalysisResult {
  // Case 1: Anti-Pattern Check (GIN Index created, but querying with ->> operator)
  if ((indexType === 'gin_ops' || indexType === 'gin_path_ops') && (operator === '->>' || operator === '->')) {
    return {
      querySql: `SELECT * FROM notes WHERE metadata->>'${sampleKey}' = '${sampleValue}';`,
      strategyUsed: 'None (Sequential Scan)',
      isAntiPattern: true,
      antiPatternWarning:
        'ANTI-PATTERN CẢNH BÁO: Bạn đã tạo GIN index nhưng lại dùng toán tử ->> để truy vấn. PostgreSQL không thể áp dụng GIN index cho biểu thức trích xuất chuỗi ->>, dẫn đến bỏ qua Index và thực hiện Sequential Scan (Full Table Scan) làm chậm toàn bộ hệ thống!',
      estimatedCost: {
        indexScanType: 'Sequential Scan (Full Table Scan)',
        storageOverheadRelative: indexType === 'gin_ops' ? '50-100% Table Size' : '15-25% Table Size',
        executionTimeMs: 42.8,
        bufferReads: 1450,
      },
      recommendation:
        `Giải pháp: Thay vì dùng "metadata->>'${sampleKey}' = '${sampleValue}'", hãy chuyển sang toán tử bao hàm "metadata @> '{"${sampleKey}": "${sampleValue}"}'::jsonb" để kích hoạt GIN Index, hoặc tạo một Expression B-Tree index trên (metadata->>'${sampleKey}').`,
    };
  }

  // Case 2: Expression B-Tree with ->> operator
  if (indexType === 'expression_btree' && (operator === '->>' || operator === 'BETWEEN')) {
    return {
      querySql: `SELECT * FROM notes WHERE metadata->>'${sampleKey}' = '${sampleValue}';`,
      strategyUsed: 'Expression B-Tree',
      isAntiPattern: false,
      estimatedCost: {
        indexScanType: 'Index Scan',
        storageOverheadRelative: 'Rất nhỏ (~5% Table Size, chỉ lưu 1 scalar key)',
        executionTimeMs: 0.14,
        bufferReads: 4,
      },
      recommendation:
        `Tối ưu hoàn hảo: Expression B-Tree Index trên (metadata->>'${sampleKey}') được kích hoạt trực tiếp với chi phí thấp nhất cho các phép so sánh =, <, >, BETWEEN, IN.`,
    };
  }

  // Case 3: GIN (jsonb_path_ops) with @> operator
  if (indexType === 'gin_path_ops' && operator === '@>') {
    return {
      querySql: `SELECT * FROM notes WHERE metadata @> '{"${sampleKey}": "${sampleValue}"}'::jsonb;`,
      strategyUsed: 'GIN (jsonb_path_ops)',
      isAntiPattern: false,
      estimatedCost: {
        indexScanType: 'Bitmap Heap Scan',
        storageOverheadRelative: 'Nhỏ (Chỉ 1/3 - 1/4 so với jsonb_ops)',
        executionTimeMs: 0.28,
        bufferReads: 12,
      },
      recommendation:
        'Tối ưu đỉnh cao: GIN jsonb_path_ops băm toàn bộ đường dẫn JSON thành 32-bit hash, mang lại tốc độ truy vấn bao hàm (@>) siêu tốc và tiết kiệm 70% dung lượng đĩa so với GIN mặc định.',
    };
  }

  // Case 4: GIN (jsonb_ops) with key existence ? or containment @>
  if (indexType === 'gin_ops') {
    const query =
      operator === '?'
        ? `SELECT * FROM notes WHERE metadata ? '${sampleKey}';`
        : `SELECT * FROM notes WHERE metadata @> '{"${sampleKey}": "${sampleValue}"}'::jsonb;`;
    return {
      querySql: query,
      strategyUsed: 'GIN (jsonb_ops)',
      isAntiPattern: false,
      estimatedCost: {
        indexScanType: 'Bitmap Heap Scan',
        storageOverheadRelative: 'Rất lớn (50-100% Table Size)',
        executionTimeMs: 0.45,
        bufferReads: 28,
      },
      recommendation:
        'Linh hoạt tối đa: GIN jsonb_ops lập chỉ mục cho mọi key và value, hỗ trợ đầy đủ toán tử @>, ?, ?|, ?& khi bạn không biết trước cấu trúc schema.',
    };
  }

  // Case 5: Partial Index
  if (indexType === 'partial_index' || hasPartialCondition) {
    return {
      querySql: `SELECT * FROM notes WHERE is_active = true AND metadata @> '{"${sampleKey}": "${sampleValue}"}'::jsonb;`,
      strategyUsed: 'Partial Index',
      isAntiPattern: false,
      estimatedCost: {
        indexScanType: 'Bitmap Heap Scan',
        storageOverheadRelative: 'Cực kỳ nhỏ (< 2% Table Size, chỉ lọc bản ghi active)',
        executionTimeMs: 0.09,
        bufferReads: 3,
      },
      recommendation:
        'Tối ưu dung lượng tuyệt đối: Partial Index chỉ lập chỉ mục cho các bản ghi thỏa mãn điều kiện tĩnh (is_active = true), loại bỏ hoàn toàn chi phí lưu trữ cho dữ liệu rác/lưu trữ cũ.',
    };
  }

  // Default Fallback
  return {
    querySql: `SELECT * FROM notes WHERE metadata->>'${sampleKey}' = '${sampleValue}';`,
    strategyUsed: 'None (Sequential Scan)',
    isAntiPattern: false,
    estimatedCost: {
      indexScanType: 'Sequential Scan (Full Table Scan)',
      storageOverheadRelative: '0% (Không có Index)',
      executionTimeMs: 38.5,
      bufferReads: 1200,
    },
    recommendation: 'Chưa có Index phù hợp: Cần lập chỉ mục theo 1 trong 4 chiến lược để tăng tốc truy vấn.',
  };
}
