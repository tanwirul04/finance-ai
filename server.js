require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const XLSX = require('xlsx');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/chartjs', express.static(path.join(__dirname, 'node_modules/chart.js/dist')));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;

if (!GEMINI_API_KEY) {
  console.warn('\n[PERINGATAN] GEMINI_API_KEY belum diset. Salin .env.example menjadi .env dan isi API key kamu.\n');
}

const BAHASA_RULE = `Aturan bahasa: jangan gunakan sapaan formal seperti "Bapak/Ibu", "Anda yang terhormat", atau basa-basi pembuka. Tulis langsung to the point, gunakan bahasa Indonesia santai tapi profesional, seperti menjelaskan ke rekan sendiri. Hindari istilah akuntansi yang rumit tanpa penjelasan.`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callGeminiRaw(contents) {
  const response = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents, generationConfig: { temperature: 0.3 } })
  });
  const data = await response.json();
  if (!response.ok) {
    const err = new Error(data.error?.message || `Gemini API error (status ${response.status})`);
    err.status = response.status;
    throw err;
  }
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  if (!text) throw new Error('Gemini tidak mengembalikan jawaban. Coba lagi.');
  return text;
}

const MAX_RETRIES = 4;

async function callGemini(contents) {
  let attempt = 0;
  for (;;) {
    try {
      return await callGeminiRaw(contents);
    } catch (err) {
      const isRetryable = err.status === 429 || err.status === 503;
      attempt++;
      if (!isRetryable || attempt > MAX_RETRIES) throw err;
      const delay = Math.min(1000 * 2 ** (attempt - 1), 15000) + Math.random() * 300;
      console.warn(`[Gemini] Server sibuk (percobaan ${attempt}/${MAX_RETRIES}), tunggu ${Math.round(delay)}ms lalu coba lagi...`);
      await sleep(delay);
    }
  }
}

function extractJson(text) {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const candidates = [cleaned.indexOf('['), cleaned.indexOf('{')].filter((i) => i !== -1);
  const start = candidates.length ? Math.min(...candidates) : -1;
  const jsonSlice = start > 0 ? cleaned.slice(start) : cleaned;
  return JSON.parse(jsonSlice);
}

const SPREADSHEET_MIMES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
  'application/csv',
];
const SPREADSHEET_EXT = ['.xlsx', '.xls', '.csv'];
const MEDIA_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.pdf'];

function fileCategory(file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf' || MEDIA_EXT.includes(ext)) {
    return 'media';
  }
  if (SPREADSHEET_MIMES.includes(file.mimetype) || SPREADSHEET_EXT.includes(ext)) {
    return 'table';
  }
  return null;
}

// Agent ekstraksi: ubah foto nota/struk, PDF, atau file Excel/CSV jadi data transaksi terstruktur
app.post('/api/extract', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Tidak ada file yang diunggah' });
    const category = fileCategory(req.file);

    let text;
    if (category === 'media') {
      const base64 = req.file.buffer.toString('base64');
      const prompt = `Kamu adalah agent ekstraksi data untuk sistem analisis keuangan UMKM.
Lihat file nota, struk, atau dokumen transaksi ini dan ubah menjadi data transaksi terstruktur.
Balas HANYA dengan JSON array, tanpa teks lain, tanpa markdown, dengan format persis:
[{"tanggal": "YYYY-MM-DD atau null", "deskripsi": "nama barang/transaksi", "jumlah": angka_tanpa_titik_atau_koma, "tipe": "pemasukan" atau "pengeluaran"}]
Jika ada beberapa item, pisahkan jadi beberapa baris transaksi. Jika tidak yakin tipe-nya, asumsikan "pengeluaran".`;
      text = await callGemini([{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: req.file.mimetype, data: base64 } }] }]);
    } else if (category === 'table') {
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' }).slice(0, 300);
      const prompt = `Kamu adalah agent ekstraksi data untuk sistem analisis keuangan UMKM.
Berikut isi file Excel/CSV yang diunggah pengguna, dalam format JSON per baris:
${JSON.stringify(rows).slice(0, 12000)}

Ubah setiap baris yang relevan menjadi transaksi terstruktur. Kolom bisa punya nama berbeda-beda (mis. "keterangan", "nominal", "jenis", dsb), pahami maknanya sendiri.
Balas HANYA dengan JSON array, tanpa teks lain, tanpa markdown, dengan format persis:
[{"tanggal": "YYYY-MM-DD atau null", "deskripsi": "...", "jumlah": angka_tanpa_titik_atau_koma, "tipe": "pemasukan" atau "pengeluaran"}]
Abaikan baris yang bukan transaksi (baris kosong, header, subtotal).`;
      text = await callGemini([{ role: 'user', parts: [{ text: prompt }] }]);
    } else {
      return res.status(400).json({ error: 'Format file tidak didukung. Gunakan foto (jpg/png), PDF, Excel (.xlsx/.xls), atau CSV.' });
    }

    const transactions = extractJson(text);
    res.json({ transactions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Tim agent analisis: analis, prediktor, detektor risiko, advisor -- dalam satu panggilan terstruktur
app.post('/api/analyze', async (req, res) => {
  try {
    const { transactions } = req.body;
    if (!Array.isArray(transactions) || transactions.length === 0) {
      return res.status(400).json({ error: 'Data transaksi kosong' });
    }

    const prompt = `Kamu adalah tim AI analis keuangan untuk pelaku usaha kecil, terdiri dari 4 peran yang bekerja bersama:
1. Agent analis - menghitung total pemasukan, pengeluaran, laba bersih, margin laba, dan rasio pengeluaran terhadap pemasukan.
2. Agent prediktor - memproyeksikan arus kas 3 bulan ke depan berdasarkan tren dari data yang ada.
3. Agent detektor risiko - menemukan transaksi yang janggal, pengeluaran tidak wajar, atau pola yang berisiko.
4. Agent advisor - merangkum insight bisnis dan memberi rekomendasi/tindakan yang konkret dan bisa langsung dilakukan.

${BAHASA_RULE}

Data transaksi (JSON):
${JSON.stringify(transactions)}

Balas HANYA dengan JSON, tanpa teks lain, tanpa markdown, dengan struktur PERSIS seperti ini:
{
  "hasil_analisis": {
    "total_pemasukan": angka,
    "total_pengeluaran": angka,
    "laba_bersih": angka,
    "margin_laba_persen": angka_satu_desimal,
    "rasio_pengeluaran_persen": angka_satu_desimal
  },
  "skor_kesehatan": {"nilai": angka_0_sampai_100, "penjelasan": "1-2 kalimat, tanpa sapaan formal"},
  "insight_bisnis": ["array berisi insight singkat"],
  "prediksi_cashflow": [{"label": "Bulan depan", "proyeksi": angka}, {"label": "2 bulan lagi", "proyeksi": angka}, {"label": "3 bulan lagi", "proyeksi": angka}],
  "prediksi_narasi": "2-4 kalimat menjelaskan kenapa proyeksinya begitu (tren naik/turun/stabil, faktor pendorongnya) dan apa artinya buat usaha ke depan, tanpa sapaan formal",
  "anomali": [{"transaksi": "deskripsi transaksi", "alasan": "kenapa janggal"}],
  "rekomendasi": ["array berisi tindakan konkret yang bisa dilakukan untuk memperbaiki keuangan atau mengurangi risiko"]
}
Aturan jumlah item "insight_bisnis" dan "rekomendasi": JANGAN selalu dipaksakan 3. Sesuaikan dengan kondisi data nyata -- kalau cuma ada 2 hal yang benar-benar relevan, kembalikan 2 saja; kalau ada 4-5 temuan penting, kembalikan semuanya (maksimal 6 per kategori supaya tidak kepanjangan). Jangan menambah item mengada-ada hanya supaya jumlahnya genap 3.
Jika tidak ada transaksi janggal, kembalikan array kosong untuk "anomali". Angka jangan pakai titik ribuan atau simbol Rp, cukup angka murni (kecuali field yang memang persen, tetap angka murni juga tanpa simbol %).`;

    const text = await callGemini([{ role: 'user', parts: [{ text: prompt }] }]);
    const result = extractJson(text);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Chatbot: tanya jawab bebas seputar data keuangan & hasil analisis
app.post('/api/chat', async (req, res) => {
  try {
    const { question, transactions, analysis, history } = req.body;
    if (!question || !question.trim()) {
      return res.status(400).json({ error: 'Pertanyaan kosong' });
    }

    const context = `Kamu adalah asisten AI keuangan untuk usaha kecil ini. Jawab pertanyaan pengguna berdasarkan data transaksi dan hasil analisis di bawah ini. Jawab singkat, jelas, dan praktis (maksimal 4-5 kalimat kecuali diminta detail).
${BAHASA_RULE}

Data transaksi saat ini (JSON):
${JSON.stringify(transactions || [])}

Hasil analisis terakhir (JSON, bisa kosong jika belum pernah dianalisis):
${JSON.stringify(analysis || null)}`;

    const contents = [{ role: 'user', parts: [{ text: context }] }, { role: 'model', parts: [{ text: 'Siap, saya paham datanya. Silakan tanya apa saja soal keuangan usaha ini.' }] }];

    (history || []).slice(-8).forEach((h) => {
      contents.push({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.text }] });
    });

    contents.push({ role: 'user', parts: [{ text: question }] });

    const answer = await callGemini(contents);
    res.json({ answer });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nUMKM Finance AI jalan di http://localhost:${PORT}\n`);
});
