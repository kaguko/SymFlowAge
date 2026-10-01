import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth.ts';
import {
  getUserNotes,
  insertNoteWithEmbedding,
  deleteNote,
  searchNotesSemantic,
  getOrCreateUserRecord,
  generateEmbedding,
} from '../db/rag.ts';
import { ai } from '../lib/ai.ts';
import { generateContentWithFallback } from '../lib/geminiResilience.ts';
import { Modality } from '@google/genai';

export const notesRouter = Router();

// GET /api/notes - List user notes and documents
notesRouter.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userUid = req.user?.uid || 'guest_user_cogniflow';
    const notesList = await getUserNotes(userUid);
    return res.json({ notes: notesList });
  } catch (err: any) {
    console.error('Error in GET /api/notes:', err);
    return res.status(500).json({ error: 'Failed to fetch notes from database' });
  }
});

// POST /api/notes - Create a new note and compute its vector embedding
notesRouter.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userUid = req.user?.uid || 'guest_user_cogniflow';
    const userEmail = req.user?.email || 'developer@cogniflow.local';
    const { title, category, content, tags } = req.body;

    if (!title || !content) {
      return res.status(400).json({ error: 'Title and content are required' });
    }

    await getOrCreateUserRecord(userUid, userEmail);

    const textToEmbed = `Tiêu đề: ${title}\nThể loại: ${category || 'Ghi chú'}\nNội dung: ${content}\nTừ khóa: ${tags || ''}`;
    const embedding = await generateEmbedding(textToEmbed);

    const createdNote = await insertNoteWithEmbedding(
      userUid,
      title,
      category || 'Ghi chú',
      content,
      tags || '',
      embedding
    );

    return res.status(201).json({ note: createdNote });
  } catch (err: any) {
    console.error('Error in POST /api/notes:', err);
    return res.status(500).json({ error: 'Failed to create note with vector embedding' });
  }
});

// DELETE /api/notes/:id - Delete a note
notesRouter.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userUid = req.user?.uid || 'guest_user_cogniflow';
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid note id' });
    }

    await deleteNote(id, userUid);
    return res.json({ success: true });
  } catch (err: any) {
    console.error('Error in DELETE /api/notes/:id:', err);
    return res.status(500).json({ error: 'Failed to delete note' });
  }
});

// POST /api/notes/search - Semantic vector similarity search via pgvector
notesRouter.post('/search', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userUid = req.user?.uid || 'guest_user_cogniflow';
    const { query, limit = 5, minSimilarity = 0.2 } = req.body;

    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'Search query is required' });
    }

    const queryEmbedding = await generateEmbedding(query);
    const results = await searchNotesSemantic(userUid, queryEmbedding, limit, minSimilarity);

    return res.json({
      query,
      results,
      count: results.length,
    });
  } catch (err: any) {
    console.error('Error in POST /api/notes/search:', err);
    return res.status(500).json({ error: 'Failed to execute semantic search' });
  }
});

// POST /api/notes/rag-ask - Retrieval-Augmented Generation Q&A
notesRouter.post('/rag-ask', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userUid = req.user?.uid || 'guest_user_cogniflow';
    const { question } = req.body;

    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'Question is required' });
    }

    const queryEmbedding = await generateEmbedding(question);
    const retrievedNotes = await searchNotesSemantic(userUid, queryEmbedding, 4, 0.15);

    if (!ai) {
      const topDoc = retrievedNotes[0];
      return res.json({
        answer: topDoc
          ? `(Chế độ cục bộ) Dựa trên tài liệu "${topDoc.title}": ${topDoc.content.slice(0, 300)}...`
          : 'Chưa tìm thấy ghi chú phù hợp để trả lời câu hỏi.',
        sources: retrievedNotes,
        question,
      });
    }

    const contextText = retrievedNotes
      .map(
        (doc, idx) =>
          `[TÀI LIỆU ${idx + 1}]: ${doc.title} (${doc.category})\nĐộ tương đồng ngữ nghĩa: ${(doc.similarity * 100).toFixed(1)}%\nNội dung:\n${doc.content}\n`
      )
      .join('\n---\n');

    const prompt = `Bạn là Trợ lý Kỹ thuật & Quyết định Kiến trúc RAG của CogniFlow.
Bạn là Trợ lý Kỹ thuật & Quyết định Kiến trúc RAG của CogniFlow.
Nhiệm vụ của bạn là trả lời câu hỏi của lập trình viên dựa trên các ghi chú và tài liệu kỹ thuật được trích xuất từ cơ sở dữ liệu pgvector dưới đây:

NGỮ CẢNH TRÍCH XUẤT (GROUNDING CONTEXT):
${contextText || '(Không tìm thấy tài liệu phù hợp trong kho ghi chú của người dùng)'}

CÂU HỎI CỦA NGƯỜI DÙNG:
"${question}"

NGUYÊN TẮC TRẢ LỜI:
1. Trả lời chính xác, mạch lạc, đi thẳng vào giải pháp kỹ thuật, phân tích trade-off nếu có.
2. Trích dẫn rõ ràng nguồn tài liệu đã sử dụng theo định dạng: [Nguồn: <Tên tài liệu>] khi đưa ra thông tin.
3. Nếu tài liệu không chứa đủ thông tin để trả lời trọn vẹn, hãy nói rõ: "Dựa trên các ghi chú hiện có..." và bổ sung kiến thức kỹ thuật lập trình chuẩn xác để hỗ trợ người dùng.
4. Giữ phong thái kỹ sư cấp cao: súc tích, thực chiến, có code snippet minh họa nếu phù hợp.`;

    let answer = 'Không thể tạo câu trả lời từ ngữ cảnh.';
    try {
      const result = await generateContentWithFallback(ai, {
        contents: prompt,
      });
      answer = result.text || answer;
    } catch (aiErr: any) {
      console.warn('[api/notes/rag-ask] Upstream Gemini 503 spike, using top document text as grounded response');
      const topDoc = retrievedNotes[0];
      answer = topDoc
        ? `[Chế độ dự phòng khi mạng tải cao] Dựa trên ghi chú "${topDoc.title}":\n\n${topDoc.content}`
        : 'Hệ thống đang gặp tải cao tạm thời từ mô hình AI. Vui lòng thử lại sau giây lát.';
    }

    return res.json({
      answer,
      sources: retrievedNotes,
      question,
    });
  } catch (err: any) {
    console.error('Error in /api/notes/rag-ask:', err);
    return res.status(500).json({ error: 'Failed to process RAG question' });
  }
});

// POST /api/notes/seed - Seed sample technical dev notes if empty
notesRouter.post('/seed', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userUid = req.user?.uid || 'guest_user_cogniflow';
    const userEmail = req.user?.email || 'developer@cogniflow.local';

    await getOrCreateUserRecord(userUid, userEmail);
    const existing = await getUserNotes(userUid);

    if (existing.length > 0) {
      return res.json({ message: 'User already has notes', count: existing.length, notes: existing });
    }

    const sampleNotes = [
      {
        title: 'ADR-001: Kiến Trúc Xác Thực Hai Lớp (OAuth 2.0 & Firebase Token Verification)',
        category: 'Quyết định kiến trúc',
        tags: 'auth, security, firebase, oauth, jwt',
        content: `Hệ thống triển khai mô hình xác thực Client-Side Popup OAuth kết hợp Server-Side ID Token Verification:
1. Phía Client: Người dùng đăng nhập qua Google Auth Popup với firebase/auth, lấy JWT token ngắn hạn (1 giờ).
2. Phía Server: Mọi request API đến tài nguyên cơ sở dữ liệu đều đi qua middleware requireAuth với Firebase Admin SDK (adminAuth.verifyIdToken).
3. Ưu điểm: Loại bỏ hoàn toàn việc lưu trữ mật khẩu tĩnh trên database; bảo vệ hệ thống trước tấn công giả mạo token; giảm rủi ro rò rỉ credential.`,
      },
      {
        title: 'Tối Ưu Hóa Truy Vấn Cơ Sở Dữ Liệu PostgreSQL & Index Vector HNSW',
        category: 'Tài liệu kỹ thuật',
        tags: 'postgresql, pgvector, hnsw, database, performance',
        content: `Các nguyên tắc tối ưu hóa database cho tính năng tìm kiếm ngữ nghĩa và lưu trữ quan hệ:
- Extension pgvector: Sử dụng kiểu dữ liệu vector(768) đồng bộ với model text-embedding-004 của Google Gemini.
- Chỉ mục HNSW (Hierarchical Navigable Small World): Tạo index trên toán tử cosine distance (<=>) giúp tăng tốc độ truy vấn vector gấp 10-20 lần so với scan tuần tự.
- Connection Pooling: Sử dụng pg.Pool với Object Method cấu hình kết nối lười (lazy connection), kiểm soát connectionTimeoutMillis = 15000 để tránh cạn kiệt pool kết nối trên serverless.`,
      },
      {
        title: 'Phương Pháp Luận Chia Nhỏ Vi Bước ≤ 15 Phút (Atomic Steps Protocol)',
        category: 'Quy trình lập trình',
        tags: 'productivity, atomic-steps, divide-and-conquer, flow',
        content: `Triết lý giải quyết vấn đề của kỹ sư cấp cao:
- Bất kỳ bài toán lớn nào gây trì hoãn hay ma sát nhận thức đều có thể chia thành các bước nhỏ ≤ 15 phút.
- Mỗi vi bước phải đạt tiêu chí nguyên tử (Atomic): Có định nghĩa hoàn thành (Definition of Done) rõ ràng, chạy được 1 assertion hoặc kiểm thử nhanh.
- Kỹ thuật Nano-Decomposition: Khi gặp bế tắc (friction), tiếp tục chia nhỏ bước hiện tại thành 3 bước nhỏ hơn (mỗi bước 2-3 phút): (1) Mở đúng 1 file liên quan, (2) Thêm log/assert kiểm tra input, (3) Chạy test cục bộ.`,
      },
      {
        title: 'Chiến Lược Quản Trị Goal Drift & Đồng Bộ Lộ Trình Horizon 6–12 Tháng',
        category: 'Định hướng dài hạn',
        tags: 'horizon, goal-drift, roadmap, milestones',
        content: `Kiến trúc 2.0 quy định mọi vi bước hàng ngày phải truy vết được lên một cột mốc hoặc mục tiêu dài hạn:
- Goal Drift Analyzer tính toán tỷ lệ % các task không gắn liền với mục tiêu neo. Khi driftScore ≥ 20%, hệ thống kích hoạt cảnh báo trôi dạt định hướng.
- Mô hình Zoom In - Zoom Out: Chuyển đổi giữa 3 tầng Macro (Chiến lược 6-12 tháng) -> Meso (Cột mốc tháng/quý) -> Micro (Vi bước hành động hôm nay).
- Khi một vi bước được đánh dấu hoàn thành, tiến độ của Milestone và Goal sẽ tự động được cộng dồn theo thời gian thực.`,
      },
    ];

    const insertedList = [];
    for (const item of sampleNotes) {
      const textToEmbed = `Tiêu đề: ${item.title}\nThể loại: ${item.category}\nNội dung: ${item.content}\nTừ khóa: ${item.tags}`;
      const embedding = await generateEmbedding(textToEmbed);
      const inserted = await insertNoteWithEmbedding(
        userUid,
        item.title,
        item.category,
        item.content,
        item.tags,
        embedding
      );
      insertedList.push(inserted);
    }

    return res.status(201).json({ message: 'Seeded sample notes successfully', count: insertedList.length, notes: insertedList });
  } catch (err: any) {
    console.error('Error in /api/notes/seed:', err);
    return res.status(500).json({ error: 'Failed to seed sample notes' });
  }
});
