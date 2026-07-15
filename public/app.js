let transactions = [];
let lastAnalysis = null;
let chatHistory = [];
let compositionChartInstance = null;
let trendChartInstance = null;

const txBody = document.getElementById('txBody');
const analyzeBtn = document.getElementById('analyzeBtn');
const resultsPanel = document.getElementById('resultsPanel');

const SAMPLE_DATA = [
  { deskripsi: 'Penjualan nasi goreng & es teh', jumlah: 1850000, tipe: 'pemasukan' },
  { deskripsi: 'Beli beras & bahan dapur', jumlah: 420000, tipe: 'pengeluaran' },
  { deskripsi: 'Penjualan online (GoFood)', jumlah: 630000, tipe: 'pemasukan' },
  { deskripsi: 'Bayar listrik & air', jumlah: 310000, tipe: 'pengeluaran' },
  { deskripsi: 'Beli gas LPG', jumlah: 200000, tipe: 'pengeluaran' },
  { deskripsi: 'Penjualan tunai harian', jumlah: 2100000, tipe: 'pemasukan' },
  { deskripsi: 'Transfer tidak dikenal ke rekening pribadi', jumlah: 950000, tipe: 'pengeluaran' },
  { deskripsi: 'Bayar gaji karyawan', jumlah: 1200000, tipe: 'pengeluaran' },
];

function formatRupiah(n) {
  const num = Number(n) || 0;
  return 'Rp ' + num.toLocaleString('id-ID');
}

function chartColors() {
  const styles = getComputedStyle(document.documentElement);
  return {
    ink: styles.getPropertyValue('--ink').trim() || '#1E2A22',
    green: styles.getPropertyValue('--green').trim() || '#2F5D46',
    danger: styles.getPropertyValue('--danger').trim() || '#8A2E22',
    accent: styles.getPropertyValue('--accent').trim() || '#C9931F',
    line: styles.getPropertyValue('--line').trim() || '#D8D4C4',
  };
}

function renderTable() {
  if (transactions.length === 0) {
    txBody.innerHTML = '<tr class="empty-row"><td colspan="4">Belum ada transaksi. Tambahkan manual atau unggah file.</td></tr>';
    analyzeBtn.disabled = true;
    return;
  }
  txBody.innerHTML = transactions
    .map((t, i) => `
      <tr>
        <td>${t.deskripsi}</td>
        <td><span class="tag ${t.tipe === 'pemasukan' ? 'masuk' : 'keluar'}">${t.tipe}</span></td>
        <td class="mono">${formatRupiah(t.jumlah)}</td>
        <td><button class="remove-btn" data-i="${i}">Hapus</button></td>
      </tr>`)
    .join('');
  analyzeBtn.disabled = false;

  txBody.querySelectorAll('.remove-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      transactions.splice(Number(btn.dataset.i), 1);
      renderTable();
    });
  });
}

document.getElementById('sampleBtn').addEventListener('click', () => {
  transactions = [...SAMPLE_DATA];
  renderTable();
});

document.getElementById('manualForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const deskripsi = document.getElementById('deskripsi').value.trim();
  const jumlah = Number(document.getElementById('jumlah').value);
  const tipe = document.getElementById('tipe').value;
  if (!deskripsi || !jumlah) return;
  transactions.push({ deskripsi, jumlah, tipe });
  renderTable();
  e.target.reset();
});

const photoInput = document.getElementById('photoInput');
const uploadStatus = document.getElementById('uploadStatus');

photoInput.addEventListener('change', async () => {
  const file = photoInput.files[0];
  if (!file) return;
  uploadStatus.textContent = 'Agent ekstraksi sedang membaca file...';
  try {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/extract', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal mengekstrak file');
    const extracted = (data.transactions || []).map((t) => ({
      deskripsi: t.deskripsi || 'Tanpa deskripsi',
      jumlah: Number(t.jumlah) || 0,
      tipe: t.tipe === 'pemasukan' ? 'pemasukan' : 'pengeluaran',
    }));
    transactions.push(...extracted);
    renderTable();
    uploadStatus.textContent = `Berhasil menambahkan ${extracted.length} transaksi dari file.`;
  } catch (err) {
    uploadStatus.textContent = 'Gagal: ' + err.message;
  }
});

analyzeBtn.addEventListener('click', async () => {
  analyzeBtn.disabled = true;
  analyzeBtn.textContent = 'Tim AI sedang menganalisis...';
  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal menganalisis');
    lastAnalysis = data;
    renderResults(data);
  } catch (err) {
    alert('Terjadi kesalahan: ' + err.message);
  } finally {
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = 'Analisis dengan AI';
  }
});

function renderResults(data) {
  resultsPanel.hidden = false;

  const r = data.hasil_analisis || {};
  document.getElementById('sumMasuk').textContent = formatRupiah(r.total_pemasukan);
  document.getElementById('sumKeluar').textContent = formatRupiah(r.total_pengeluaran);
  document.getElementById('sumLaba').textContent = formatRupiah(r.laba_bersih);
  document.getElementById('marginLaba').textContent = `${r.margin_laba_persen ?? 0}%`;

  const skor = data.skor_kesehatan || {};
  const nilai = Math.max(0, Math.min(100, Number(skor.nilai) || 0));
  document.getElementById('scoreNumber').textContent = nilai;
  document.getElementById('scoreExplain').textContent = skor.penjelasan || '';
  const circumference = 2 * Math.PI * 52;
  const arc = document.getElementById('scoreArc');
  arc.style.strokeDasharray = `${circumference}`;
  arc.style.strokeDashoffset = `${circumference * (1 - nilai / 100)}`;

  renderCompositionChart(r);
  renderTrendChart(transactions);
  renderCashflowText(data.prediksi_cashflow || [], data.prediksi_narasi || '');

  const insights = data.insight_bisnis || [];
  document.getElementById('insightList').innerHTML = insights.map((i) => `<li>${i}</li>`).join('');

  const recs = data.rekomendasi || [];
  document.getElementById('recommendList').innerHTML = recs.map((r) => `<li>${r}</li>`).join('');

  const anomalies = data.anomali || [];
  const anomalyEl = document.getElementById('anomalyList');
  anomalyEl.innerHTML = anomalies.length
    ? anomalies.map((a) => `<div class="anomaly-item"><b>${a.transaksi}</b> — ${a.alasan}</div>`).join('')
    : '<div class="anomaly-empty">Tidak ada transaksi janggal terdeteksi.</div>';

  resultsPanel.scrollIntoView({ behavior: 'smooth' });
}

function renderCompositionChart(r) {
  if (typeof Chart === 'undefined') {
    document.getElementById('compositionChart').replaceWith(
      Object.assign(document.createElement('p'), { textContent: 'Grafik gagal dimuat (cek koneksi internet).', style: 'font-size:13px;color:var(--ink-soft)' })
    );
    return;
  }
  const colors = chartColors();
  const ctx = document.getElementById('compositionChart');
  if (compositionChartInstance) compositionChartInstance.destroy();
  compositionChartInstance = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Pemasukan', 'Pengeluaran'],
      datasets: [{
        data: [Number(r.total_pemasukan) || 0, Number(r.total_pengeluaran) || 0],
        backgroundColor: [colors.green, colors.danger],
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'bottom', labels: { color: colors.ink, font: { size: 12 } } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${formatRupiah(ctx.raw)}` } },
      },
    },
  });
}

function renderTrendChart(txs) {
  if (typeof Chart === 'undefined') {
    document.getElementById('trendChart').replaceWith(
      Object.assign(document.createElement('p'), { textContent: 'Grafik gagal dimuat (cek koneksi internet).', style: 'font-size:13px;color:var(--ink-soft)' })
    );
    return;
  }
  const colors = chartColors();
  const ctx = document.getElementById('trendChart');
  if (trendChartInstance) trendChartInstance.destroy();

  let saldo = 0;
  const labels = [];
  const dataPoints = [];
  txs.forEach((t, i) => {
    saldo += t.tipe === 'pemasukan' ? Number(t.jumlah) || 0 : -(Number(t.jumlah) || 0);
    labels.push(`#${i + 1}`);
    dataPoints.push(saldo);
  });

  trendChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Saldo kas berjalan',
        data: dataPoints,
        borderColor: colors.green,
        backgroundColor: colors.green,
        tension: 0.3,
        pointRadius: 3,
        fill: false,
      }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => txs[items[0].dataIndex]?.deskripsi || '',
            label: (ctx) => `Saldo: ${formatRupiah(ctx.raw)}`,
          },
        },
      },
      scales: {
        y: { ticks: { color: colors.ink, callback: (v) => (Math.abs(v) >= 1000000 ? v / 1000000 + 'jt' : v) }, grid: { color: colors.line } },
        x: { ticks: { color: colors.ink }, grid: { display: false } },
      },
    },
  });
}

function renderCashflowText(forecast, narasi) {
  const el = document.getElementById('cashflowText');
  if (!el) return;

  if (!forecast.length) {
    el.innerHTML = '<p class="card-sub">Belum ada proyeksi.</p>';
    return;
  }

  const rows = forecast.map((f, i) => {
    const prev = i > 0 ? Number(forecast[i - 1].proyeksi) || 0 : null;
    const curr = Number(f.proyeksi) || 0;
    let trendLabel = '';
    if (prev !== null) {
      if (curr > prev) trendLabel = ' — naik dibanding bulan sebelumnya';
      else if (curr < prev) trendLabel = ' — turun dibanding bulan sebelumnya';
      else trendLabel = ' — stabil';
    }
    return `<p class="prediksi-item"><b>${f.label}:</b> ${formatRupiah(curr)}${trendLabel}</p>`;
  }).join('');

  const narasiHtml = narasi ? `<p class="prediksi-narasi">${narasi}</p>` : '';
  el.innerHTML = `<p class="prediksi-subhead">Prediksi arus kas 3 bulan ke depan:</p>` + rows + narasiHtml;
}

// Chatbot
const chatLog = document.getElementById('chatLog');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');

function appendChatBubble(role, text) {
  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  div.textContent = text;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return div;
}

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const question = chatInput.value.trim();
  if (!question) return;
  appendChatBubble('user', question);
  chatInput.value = '';
  const pending = appendChatBubble('assistant pending', 'Sedang berpikir...');

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, transactions, analysis: lastAnalysis, history: chatHistory }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal mendapat jawaban');
    pending.textContent = data.answer;
    pending.className = 'chat-msg assistant';
    chatHistory.push({ role: 'user', text: question });
    chatHistory.push({ role: 'assistant', text: data.answer });
  } catch (err) {
    pending.textContent = 'Gagal: ' + err.message;
    pending.className = 'chat-msg assistant';
  }
});

renderTable();
