require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// FIX: đảm bảo fetch hoạt động trên mọi phiên bản Node
const fetch = global.fetch || ((...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args)));

// Gemini API config
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'YOUR_GEMINI_API_KEY_HERE';
const GEMINI_URL =`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${GEMINI_API_KEY}`;
// Storage for uploaded docs
const DOCS_DIR = path.join(__dirname, 'documents');
if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });

// In-memory document store (production: dùng database)
let documentStore = [];
const STORE_FILE = path.join(__dirname, 'doc_store.json');
if (fs.existsSync(STORE_FILE)) {
  try {
    documentStore = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
  } catch (err) {
    console.error('Load store error:', err.message);
  }
}

function saveStore() {
  fs.writeFileSync(STORE_FILE, JSON.stringify(documentStore, null, 2));
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Multer setup for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, DOCS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.txt', '.pdf', '.md', '.docx', '.json', '.csv'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Chỉ hỗ trợ file: txt, pdf, md, docx, json, csv'), false);
  }
});

// GET all documents
app.get('/api/documents', (req, res) => {
  res.json(documentStore.map(d => ({
    id: d.id, name: d.name, subject: d.subject,
    size: d.size, uploadedAt: d.uploadedAt
  })));
});

// POST upload document
app.post('/api/documents', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Không có file' });

  let textContent = '';
  const ext = path.extname(req.file.originalname).toLowerCase();

  if (ext === '.txt' || ext === '.md' || ext === '.csv' || ext === '.json') {
    textContent = fs.readFileSync(req.file.path, 'utf-8').slice(0, 50000);
  } else {
    textContent = `[Tài liệu: ${req.file.originalname} - ${Math.round(req.file.size / 1024)}KB. Nội dung đã được lưu trữ.]`;
  }

  const doc = {
    id: uuidv4(),
    name: req.body.name || req.file.originalname,
    subject: req.body.subject || 'Chung',
    filename: req.file.filename,
    size: req.file.size,
    textContent,
    uploadedAt: new Date().toISOString()
  };

  documentStore.push(doc);
  saveStore();

  res.json({ success: true, document: { id: doc.id, name: doc.name, subject: doc.subject } });
});

// DELETE document
app.delete('/api/documents/:id', (req, res) => {
  const idx = documentStore.findIndex(d => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Không tìm thấy' });

  const doc = documentStore[idx];
  const filePath = path.join(DOCS_DIR, doc.filename);

  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  documentStore.splice(idx, 1);
  saveStore();

  res.json({ success: true });
});

// POST add text/link document
app.post('/api/documents/text', (req, res) => {
  const { name, subject, content } = req.body;
  if (!name || !content) return res.status(400).json({ error: 'Thiếu thông tin' });

  const filename = uuidv4() + '.txt';
  fs.writeFileSync(path.join(DOCS_DIR, filename), content, 'utf-8');

  const doc = {
    id: uuidv4(),
    name,
    subject: subject || 'Chung',
    filename,
    size: Buffer.byteLength(content, 'utf-8'),
    textContent: content.slice(0, 50000),
    uploadedAt: new Date().toISOString()
  };

  documentStore.push(doc);
  saveStore();

  res.json({ success: true, document: { id: doc.id, name: doc.name, subject: doc.subject } });
});

// POST chat
app.post('/api/chat', async (req, res) => {
  // FIX: tránh lỗi undefined req.body
  const {
    message,
    history = [],
    useDocuments = true,
    selectedDocs = []
  } = req.body || {};

  if (!message) return res.status(400).json({ error: 'Thiếu câu hỏi' });

  // Build context from selected or all documents
  let docsContext = '';

  if (useDocuments && documentStore.length > 0) {
    const docs = selectedDocs.length > 0
      ? documentStore.filter(d => selectedDocs.includes(d.id))
      : documentStore;

    if (docs.length > 0) {
      docsContext =
        '\n\n=== TÀI LIỆU THAM KHẢO ===\n' +
        docs.map(d =>
          `--- ${d.name} (${d.subject}) ---\n${d.textContent.slice(0, 8000)}`
        ).join('\n\n').slice(0, 30000);
    }
  }

  const systemPrompt = `Bạn là trợ lý giáo dục thông minh và thân thiện, chuyên hỗ trợ học sinh, sinh viên và giáo viên Việt Nam.

Nguyên tắc hoạt động:
- Trả lời bằng tiếng Việt, rõ ràng, dễ hiểu, phù hợp lứa tuổi học sinh
- Giải thích kiên nhẫn, dùng ví dụ cụ thể, so sánh thực tế
- Khuyến khích tư duy phản biện và ham học hỏi
- Nếu có tài liệu tham khảo, ưu tiên dùng thông tin từ đó
- Khi làm bài tập, hướng dẫn từng bước, không chỉ đưa đáp án
- Dùng emoji phù hợp để tạo không khí vui vẻ 📚✨
- Khen ngợi khi học sinh hỏi hay, khích lệ khi học sinh gặp khó khăn
${docsContext}`;

  const contents = [];

  // FIX nhẹ: tránh crash nếu history không phải array
  if (Array.isArray(history)) {
    for (const h of history.slice(-10)) {
      contents.push({
        role: h.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: h.content }]
      });
    }
  }

  contents.push({ role: 'user', parts: [{ text: message }] });

  try {
    const geminiRes = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // FIX CHÍNH: system_instruction -> systemInstruction
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: {
          temperature: 0.7,
          topP: 0.9,
          maxOutputTokens: 2048
        }
      })
    });

    if (!geminiRes.ok) {
      const err = await geminiRes.json();
      console.log('Gemini raw error:', err);
      throw new Error(err.error?.message || 'Gemini API lỗi');
    }

    const data = await geminiRes.json();
    const reply =
      data.candidates?.[0]?.content?.parts?.[0]?.text ||
      'Xin lỗi, tôi không hiểu câu hỏi này.';

    res.json({
      reply,
      docsUsed: documentStore.length > 0 && useDocuments
    });

  } catch (err) {
    console.error('Gemini error:', err.message);
    res.status(500).json({ error: 'Lỗi AI: ' + err.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', docs: documentStore.length, version: '1.0.0' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🌻 EduChat Server đang chạy!`);
  console.log(`📍 Địa chỉ local: http://localhost:${PORT}`);
  console.log(`🌐 Người khác truy cập: http://[IP-của-bạn]:${PORT}`);
  console.log(`\n⚠️  Nhớ đặt GEMINI_API_KEY trước khi chạy!\n`);
});