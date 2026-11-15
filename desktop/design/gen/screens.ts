import { Doc, ONBEAM, GLOW } from "./fc";
import { stageTrack, clipRow, clipStage, transport, stateBlock, toast, dialog, palette, STAGES, ICONS } from "./components";
import { NOTES } from "./extra";
import { btn, actionRing, link, inputField, switchRow, panel, head, h3, divider, beamHair, kv, pill, status, screen, verdictMark, scoreBar, ic, fall } from "./ui";

type O = Record<string, any>;
export type Ctx = { d: Doc; c: string; w: number; h: number };
export interface Def { id: string; rail: string | null; sizes: [number, number][]; build: (x: Ctx) => void }

const colRow = (d: Doc, p: string, o: O = {}) => d.row(p, "Kolom", { sh: "fill", sv: "fill", gap: 40, ...o });
const colV = (d: Doc, p: string, o: O = {}) => d.col(p, "Lajur", { gap: 16, sv: "fill", ...o });
const wf = (extra: O = {}) => ({ sh: "fill", ...extra });

// ------------------------------------------------------------------ shell (home with palette + toast)
function shellScreen({ d, c }: Ctx) {
  homeScreen({ d, c, w: 1280, h: 800 });
  const f = c;
  const pl = palette(d, f, {});
  d.set(pl, { absolute: true, x: 330, y: 80 });
  const t = toast(d, f, "success", {});
  d.set(t, { absolute: true, x: 800, y: 560 });
}

// ------------------------------------------------------------------ readiness
function readiness({ d, c }: Ctx) {
  head(d, c, "Persiapan pertama", "Sorot memeriksa mesin ini sebelum memotong. Satu hal belum siap.");
  const list = panel(d, c, "Daftar", { sh: "fill", gap: 0, pad: 0 });
  const rows: [string, string, boolean, string?][] = [
    ["ffmpeg", "Ditemukan di PATH", true],
    ["yt-dlp", "Ditemukan di PATH", true],
    ["Lingkungan Python", "Dibuat di folder data", true],
    ["Model Whisper large-v3-turbo", "Belum diunduh. Unduhan sekitar 1,6 GB dan berjalan sekali.", false, "Unduh model"],
    ["Ruang disk", "Dicek setelah model terunduh", true],
  ];
  rows.forEach(([n, s, ok, act], i) => {
    const r = d.row(list, "Cek " + n, { sh: "fill", pad: [16, 24, 16, 24], gap: 16, cross: "center", fill: !ok ? "raised" : "none" });
    if (!ok) beamHair(d, r, 3, { absolute: true, x: 0, y: 0, h: 3, w: 400 });
    const tx = d.col(r, "teks", { sh: "fill", gap: 2 });
    d.text(tx, n, { size: 13, wt: 600, fillW: true });
    d.text(tx, s, { size: 12, color: "muted", fillW: true });
    status(d, r, ok ? "Siap" : "Belum siap", ok);
    if (act) btn(d, r, act, "primary");
    if (i < rows.length - 1) divider(d, list);
  });
  d.text(c, "Tombol di baris yang belum siap menjalankan perbaikan lewat engine. Tidak ada yang berubah di luar folder data Sorot.", { size: 12, color: "muted", w: 640 });
}

// ------------------------------------------------------------------ welcome / library
function welcome({ d, c }: Ctx) {
  head(d, c, "Pakai data lama, atau mulai baru?", "Sorot menemukan dua pustaka dari versi web di mesin ini.");
  const libs: [string, string][] = [["C:\\Users\\Anda\\Sorot\\data", "Diubah 14 November 2026"], ["D:\\Sorot-lama\\data", "Diubah 2 Oktober 2026"]];
  libs.forEach(([p, m], i) => {
    const r = panel(d, c, "Pustaka " + (i + 1), { sh: "fill", gap: 12, ...(i === 0 ? { stroke: "beamText", sw: 2 } : {}) });
    const top = d.row(r, "atas", { sh: "fill", cross: "center", gap: 16 });
    const tx = d.col(top, "teks", { sh: "fill", gap: 2 });
    d.text(tx, p, { size: 15, wt: 600, fillW: true });
    d.text(tx, m, { size: 12, color: "muted", fillW: true });
    const act = d.row(top, "aksi", { gap: 8 });
    btn(d, act, "Salin ke sini", "secondary");
    btn(d, act, i === 0 ? "Pakai langsung" : "Pakai langsung", i === 0 ? "primary" : "secondary");
    if (i === 0) d.text(r, "Disarankan: pustaka ini terbaru. Memakai langsung tidak menyalin apa pun.", { size: 12, color: "muted", fillW: true });
  });
  switchRow(d, panel(d, c, "Kunci", { sh: "fill" }), "Bawa juga kunci API dari pustaka lama", true, "Kunci tidak ditampilkan. Hanya dipindahkan ke pengaturan yang baru.");
  btn(d, c, "Mulai dengan pustaka kosong", "quiet");
}

// ------------------------------------------------------------------ home (import)
function homeScreen({ d, c, w }: Ctx) {
  head(d, c, "Potong video baru", "Jatuhkan video atau tempel tautan. Sorot memilih momen terbaik dan membuat klip 9:16 dengan subtitel.");
  const cols = colRow(d, c);
  const left = colV(d, cols, { sh: "fill", gap: 24 });
  const drop = d.col(left, "Area jatuh", { sh: "fill", h: 200, sv: "fixed", main: "center", cross: "center", gap: 8, fill: "surface", stroke: "edge", radius: 10, dashes: [6, 4] });
  d.text(drop, "Jatuhkan video di sini", { size: 19, wt: 600 });
  d.text(drop, "MP4, MKV, MOV, atau WebM. Atau tekan Ctrl+O untuk memilih berkas.", { size: 13, color: "muted" });
  const lr = d.row(left, "Tautan", { sh: "fill", gap: 12, cross: "max" });
  inputField(d, lr, "Tautan video", "Tempel tautan YouTube", { ph: true, fillW: true, focus: true });
  btn(d, lr, "Potong video ini", "primary");
  inputField(d, left, "Arahan untuk pemilihan klip (opsional)", "Contoh: cari momen yang lucu, hindari iklan", { ph: true, area: true, fillW: true, help: "Maksimal 500 karakter. Arahan ini ikut dipakai saat menyaring, memilih, dan menulis teks unggahan." });
  const right = panel(d, cols, "Opsi impor", { w: 340, sh: "fixed", sv: "fill", gap: 16 });
  h3(d, right, "Opsi impor", "Berlaku untuk video ini saja");
  inputField(d, right, "Rentang waktu", "Seluruh video", { select: true, fillW: true });
  inputField(d, right, "Bahasa subtitel", "Indonesia", { select: true, fillW: true });
  switchRow(d, right, "Pangkas jeda hening", false);
  switchRow(d, right, "Ambil subtitel YouTube", true, "Dipakai bila ada, menggantikan transkripsi.");
  inputField(d, right, "Musik latar", "Tanpa musik", { select: true, fillW: true });
  d.text(c, "Terakhir dipotong", { size: 15, wt: 600 });
  const rec = d.row(c, "Terakhir", { sh: "fill", gap: 12 });
  for (const n of ["Wawancara_podcast_ep12.mp4", "Kuliah_umum_bagian2.mp4"]) {
    const r = d.row(rec, "Video " + n, { sh: "fill", pad: [12, 16, 12, 16], cross: "center", gap: 12, fill: "surface", stroke: "divider", radius: 6 });
    d.text(r, n, { size: 13, wt: 500, fillW: true });
    verdictMark(d, r, "PASS", "pass");
    link(d, r, "Buka klip");
  }
}

// ------------------------------------------------------------------ job
function jobScreen({ d, c, w }: Ctx) {
  head(d, c, "Wawancara_podcast_ep12.mp4", "Memotong video ini. Aman menutup jendela, proses tetap berjalan.");
  const hero = d.col(c, "Tahap aktif", { sh: "fill", gap: 24, pad: [40, 0, 0, 0] });
  const big = d.row(hero, "Persen", { gap: 16, cross: "max" });
  d.text(big, "62%", { size: 40, wt: 600, num: true, color: "beamText" });
  const lbl = d.col(big, "teks", { gap: 2 });
  d.text(lbl, "Skor", { size: 19, wt: 600 });
  d.text(lbl, "Menilai kandidat klip. Berjalan 04:12.", { size: 13, color: "muted", num: true });
  stageTrack(d, hero, 4, { w: Math.min(w - 64 - 80, 1100) }, false, 62, 3);
  const log = panel(d, c, "Catatan", { sh: "fill", gap: 6, pad: 16 });
  h3(d, log, "Catatan terakhir");
  for (const l of ["Skor: kandidat 124 dari 200", "Segmen: 48 jendela, 14 lolos penyaringan", "Transkrip: selesai, 64 potongan, bahasa Indonesia", "Audio: dipisah dan dinormalkan"]) d.text(log, l, { size: 12, color: "muted", num: true, fillW: true });
  const act = d.row(c, "Aksi", { sh: "fill", gap: 8, main: "max" });
  btn(d, act, "Batalkan (Ctrl+.)", "secondary");
  btn(d, act, "Lihat klip", "disabled");
  d.text(c, "Lihat klip aktif setelah tahap Subtitel selesai.", { size: 12, color: "muted" });
}

// ------------------------------------------------------------------ clips
function clipsScreen({ d, c, w }: Ctx) {
  const SW = w >= 1600 ? 400 : 270;
  head(d, c, "Klip dari Wawancara_podcast_ep12", "Urutan mengikuti skor. Pilih klip untuk melihat pratinjau dan memutuskan mana yang diposting.");
  const cols = colRow(d, c);
  const left = colV(d, cols, { sh: "fill", gap: 8 });
  const seg = d.row(left, "Filter", { gap: 4 });
  ["Semua", "PASS", "REVIEW", "SKIP"].forEach((t, i) => pill(d, seg, t, i === 0));
  const rows: [string, [string, string], number][] = [
    ["Kenapa orang menunda mulai", ["PASS", "pass"], 0.84], ["Tiga kebiasaan yang diam-diam menguras waktu", ["PASS", "pass"], 0.79],
    ["Jawaban jujur soal gagal", ["REVIEW", "review"], 0.66], ["Cerita pertama kali tampil di depan umum", ["PASS", "pass"], 0.61], ["Salam pembuka dan sponsor", ["SKIP", "skip"], 0.31],
  ];
  rows.forEach(([t, v, p], i) => clipRow(d, left, { st: i === 0 ? "selected" : v[0] === "SKIP" ? "skip" : "default", rank: i + 1, title: t, meta: `00:${42 + i * 3}  ·  hook 0:0${3 + i}`, verdict: v, pct: p, w: Math.min(w - 64 - 80 - 40 - (SW + 30), 1000) }));
  const right = colV(d, cols, { w: SW + 30, sh: "fixed", gap: 12 });
  const st = clipStage(d, right, { w: SW });
  const tb = transport(d, st, { w: SW });
  d.set(tb, { absolute: true, x: 0, y: Math.round(SW * 16 / 9) - 56 });
  const act = d.row(right, "Aksi", { gap: 8, sh: "fill" });
  btn(d, act, "Edit klip", "secondary", { sh: "fill" });
  btn(d, act, "Ekspor (Ctrl+E)", "primary", { sh: "fill" });
  const act2 = d.row(right, "Aksi 2", { gap: 8, sh: "fill" });
  btn(d, act2, "Terbitkan", "secondary", { sh: "fill" });
  btn(d, act2, "Tampilkan di folder", "quiet", { sh: "fill" });
  link(d, right, "Catat hasil unggahan");
}

// ------------------------------------------------------------------ editor
function waveform(d: Doc, p: string, w: number, h: number) {
  const f = d.frame(p, "Gelombang", { w, h, sh: "fixed", sv: "fixed", fill: "surface", stroke: "divider", radius: 6, clip: true });
  const n = Math.floor((w - 16) / 6);
  for (let i = 0; i < n; i++) {
    const a = Math.abs(Math.sin(i * 0.37) * Math.cos(i * 0.11)) * 0.8 + 0.12;
    const bh = Math.round(h * 0.7 * a);
    d.rect(f, "bar", { x: 8 + i * 6, y: Math.round((h - bh) / 2), w: 3, h: bh, fill: "steel" });
  }
  return f;
}
function editorScreen({ d, c, w }: Ctx) {
  head(d, c, "Edit klip: Kenapa orang menunda mulai", "Ubah apa yang perlu diubah, lalu render ulang. Pratinjau tidak menyentuh berkas asli.");
  const cols = colRow(d, c);
  const stageW = 220, stageH = Math.round(stageW * 16 / 9);
  const left = colV(d, cols, { w: stageW, sh: "fixed" });
  clipStage(d, left, { w: stageW });
  const mid = colV(d, cols, { sh: "fill", gap: 12 });
  h3(d, mid, "Linimasa", "Tarik gagang untuk memotong awal atau akhir. Penanda terang adalah momen hook.");
  const tl = d.frame(mid, "Linimasa", { sh: "fill", h: 200, sv: "fixed", fill: "none" });
  const tw = Math.min(w - 64 - 80 - stageW - 40 - 340 - 40, 900);
  const wv = waveform(d, tl, tw, 120);
  d.set(wv, { x: 0, y: 48 });
  // hook marker (beam) with head glow
  const hx = Math.round(tw * 0.22);
  d.node("rectangle", tl, "beam hook", { x: hx, y: 24, w: 2, h: 160, fills: [{ type: "linearGradient", from: [0.5, 0], to: [0.5, 1], stops: [{ position: 0, color: "#F0B44C" }, { position: 1, color: "#F0B44C00" }] }] });
  d.node("ellipse", tl, "beam hook head", { x: hx - 5, y: 18, w: 12, h: 12, fill: "beam", effects: GLOW });
  d.text(tl, "Hook 0:09", { size: 12, wt: 600, num: true, color: "beamText", x: hx + 12, y: 14 });
  d.text(tl, "0:00", { size: 12, num: true, color: "muted", x: 0, y: 176 });
  d.text(tl, "0:42", { size: 12, num: true, color: "muted", x: tw - 28, y: 176 });
  d.text(mid, "Hook diputar dulu sebagai teaser, lalu klip dimulai dari awal.", { size: 12, color: "muted", fillW: true });
  const opt = panel(d, cols, "Opsi klip", { w: 340, sh: "fixed", sv: "fill", gap: 16 });
  h3(d, opt, "Opsi klip");
  inputField(d, opt, "Gaya subtitel", "Karaoke", { select: true, fillW: true });
  inputField(d, opt, "Pembingkaian", "Ikuti wajah", { select: true, fillW: true });
  switchRow(d, opt, "Putar hook dulu", true);
  switchRow(d, opt, "Pangkas jeda hening", false);
  inputField(d, opt, "Musik latar", "Tanpa musik", { select: true, fillW: true });
  const act = d.row(c, "Aksi", { sh: "fill", gap: 8, main: "max" });
  btn(d, act, "Batal", "quiet");
  btn(d, act, "Render ulang klip", "primary");
}

// ------------------------------------------------------------------ publish
function publishScreen({ d, c }: Ctx) {
  head(d, c, "Terbitkan: Kenapa orang menunda mulai", "Tulis teks per platform, putuskan pilihan Anda, lalu posting. Tidak ada yang terkirim otomatis.");
  const cols = colRow(d, c);
  const left = colV(d, cols, { sh: "fill", gap: 12 });
  const tabs = d.row(left, "Platform", { gap: 4 });
  pill(d, tabs, "TikTok", true); pill(d, tabs, "YouTube", false);
  inputField(d, left, "Teks unggahan", "Ternyata bukan malas, tapi takut mulai. Ini yang saya pelajari.", { area: true, fillW: true, help: "0 dari 2.200 karakter terpakai di TikTok. Teks ditulis dari arahan dan transkrip klip." });
  inputField(d, left, "Tagar", "#produktif #mulaisekarang", { fillW: true });
  const choices = panel(d, left, "Pilihan Anda", { sh: "fill", gap: 12, stroke: "beamText", sw: 2 });
  h3(d, choices, "Pilihan Anda", "Kolom ini kosong sampai Anda mengisinya. Sorot tidak mengisikan apa pun.");
  const g = d.row(choices, "baris", { sh: "fill", gap: 16 });
  inputField(d, g, "Privasi TikTok", "Pilih privasi", { select: true, ph: true, fillW: true, error: "Pilih privasi atau mode draf sebelum memposting." });
  inputField(d, g, "Judul YouTube", "Isi judul", { ph: true, fillW: true, help: "Wajib, maksimal 100 karakter." });
  const post = d.row(choices, "Posting", { sh: "fill", gap: 12, cross: "center" });
  d.text(post, "Dibuat untuk anak-anak (YouTube): belum dijawab", { size: 13, color: "muted", fillW: true });
  btn(d, post, "Posting sekarang", "disabled");
  const right = panel(d, cols, "Akun", { w: 340, sh: "fixed", sv: "fill", gap: 12 });
  h3(d, right, "Akun tersambung", "Satu ruang kerja Tebar per posting");
  const a = d.row(right, "TikTok", { sh: "fill", gap: 8, cross: "center" });
  d.text(a, "TikTok: @akunanda", { size: 13, wt: 500, fillW: true }); status(d, a, "Siap", true);
  const b2 = d.row(right, "YouTube", { sh: "fill", gap: 8, cross: "center" });
  d.text(b2, "YouTube: Kanal Anda", { size: 13, wt: 500, fillW: true }); status(d, b2, "Siap", true);
  divider(d, right);
  h3(d, right, "Posting sebelumnya");
  d.text(right, "Belum ada posting untuk klip ini. Posting muncul di sini setelah Anda mengirim.", { size: 12, color: "muted", fillW: true });
}

// ------------------------------------------------------------------ learning
function learningScreen({ d, c }: Ctx) {
  head(d, c, "Belajar dari hasil nyata", "Pemberi skor belajar dari hasil unggahan yang Anda catat. Sorot tidak mengisi angka sendiri.");
  const cols = colRow(d, c);
  const left = panel(d, cols, "Hasil terbaru", { sh: "fill", sv: "fill", gap: 0, pad: 0 });
  const hd = d.row(left, "Kepala", { sh: "fill", pad: [16, 24, 12, 24], gap: 12 });
  for (const [t, w] of [["Klip", 0], ["Platform", 90], ["Diposting", 110], ["Tayangan", 90], ["Skor viral", 90]] as [string, number][]) d.text(hd, t, { size: 12, wt: 500, color: "muted", ...(w ? { w } : { fillW: true }) });
  divider(d, left);
  const data: [string, string, string, string, string][] = [["Kenapa orang menunda mulai", "TikTok", "12 Nov 2026", "4.120", "0,71"], ["Tiga kebiasaan yang diam-diam…", "YouTube", "9 Nov 2026", "1.860", "0,48"], ["Jawaban jujur soal gagal", "TikTok", "5 Nov 2026", "930", "0,33"]];
  data.forEach((r, i) => {
    const row = d.row(left, "Hasil " + (i + 1), { sh: "fill", pad: [14, 24, 14, 24], gap: 12, cross: "center", fill: i === 0 ? "raised" : "none" });
    if (i === 0) d.node("rectangle", row, "beam", { absolute: true, x: 0, y: 0, w: 420, h: 3, fills: fall() });
    d.text(row, r[0], { size: 13, wt: i === 0 ? 600 : 500, fillW: true });
    d.text(row, r[1], { size: 13, w: 90 }); d.text(row, r[2], { size: 13, num: true, w: 110 }); d.text(row, r[3], { size: 13, num: true, w: 90 }); d.text(row, r[4], { size: 13, num: true, wt: 600, w: 90 });
    divider(d, left);
  });
  const right = panel(d, cols, "Latihan", { w: 340, sh: "fixed", sv: "fill", gap: 12 });
  h3(d, right, "Latihan pemberi skor");
  kv(d, right, "Hasil tercatat", "3", { num: true, w: 120 });
  kv(d, right, "Dibutuhkan", "20", { num: true, w: 120 });
  d.text(right, "Belum cukup untuk melatih. Catat hasil dari klip yang sudah diposting. Postingan lewat Tebar disinkronkan otomatis.", { size: 12, color: "muted", fillW: true });
  btn(d, right, "Latih ulang", "disabled", { sh: "fill" });
  link(d, right, "Catat hasil unggahan");
}

// ------------------------------------------------------------------ discover
function discoverScreen({ d, c }: Ctx) {
  head(d, c, "Temukan video sumber", "Cari video yang layak dipotong, lalu impor satu. Pencarian web memakai Bing; LLM menyaring bila terhubung.");
  const q = d.row(c, "Cari", { sh: "fill", gap: 12, cross: "max" });
  inputField(d, q, "Topik atau arahan", "podcast pengembangan diri berbahasa Indonesia", { fillW: true });
  btn(d, q, "Cari video", "primary");
  const list = panel(d, c, "Kandidat", { sh: "fill", sv: "fill", gap: 0, pad: 0 });
  const items: [string, string, string][] = [["Mengapa kita menunda: obrolan 90 menit", "Saluran contoh A  ·  1:31:08", "Cocok dengan topik, pembicara dua orang"], ["Kebiasaan kecil yang mengubah hari", "Saluran contoh B  ·  48:20", "Cocok sebagian, banyak musik latar"], ["Tanya jawab soal karier pertama", "Saluran contoh C  ·  1:02:44", "Cocok dengan topik"]];
  items.forEach(([t, m, why], i) => {
    const r = d.row(list, "Kandidat " + (i + 1), { sh: "fill", pad: [16, 24, 16, 24], gap: 16, cross: "center", fill: i === 0 ? "raised" : "none" });
    if (i === 0) d.node("rectangle", r, "beam", { absolute: true, x: 0, y: 0, w: 480, h: 3, fills: fall() });
    const tx = d.col(r, "teks", { sh: "fill", gap: 2 });
    d.text(tx, t, { size: 13, wt: 600, fillW: true }); d.text(tx, m, { size: 12, color: "muted", num: true, fillW: true }); d.text(tx, why, { size: 12, color: "muted", fillW: true });
    btn(d, r, "Impor video ini", i === 0 ? "primary" : "secondary");
    divider(d, list);
  });
}

// ------------------------------------------------------------------ settings
function settingsTabs(d: Doc, c: string, active: number) {
  const tabs = d.row(c, "Tab", { gap: 4 });
  ["Umum", "Koneksi", "Generate"].forEach((t, i) => pill(d, tabs, t, i === active));
}
function settingsGeneral({ d, c }: Ctx) {
  head(d, c, "Setelan");
  settingsTabs(d, c, 0);
  const p = panel(d, c, "Umum", { sh: "fill", gap: 20, w: 720, sv: "hug" });
  const lang = inputField(d, p, "Bahasa", "Indonesia", { select: true, fillW: true, focus: true, help: "Berlaku setelah aplikasi dibuka ulang." });
  const th = d.col(p, "Tema", { gap: 8, sh: "fill" });
  d.text(th, "Tema", { size: 12, wt: 500, color: "muted" });
  const tr = d.row(th, "pilihan", { gap: 4 });
  ["Gelap", "Terang", "Ikuti sistem"].forEach((t, i) => pill(d, tr, t, i === 0));
  switchRow(d, p, "Tutup jendela ke baki sistem", true, "Engine tetap berjalan di latar bila ada pekerjaan.");
  switchRow(d, p, "Notifikasi saat klip selesai", true);
  switchRow(d, p, "Notifikasi saat posting gagal", true);
  divider(d, p);
  h3(d, p, "Pintasan", "Bisa diubah. Ketuk baris, lalu tekan kombinasi baru.");
  for (const [a, k] of [["Palet perintah", "Ctrl+K"], ["Impor berkas", "Ctrl+O"], ["Tempel tautan dan impor", "Ctrl+Shift+V"], ["Ekspor klip terpilih", "Ctrl+E"]] as [string, string][]) {
    const r = d.row(p, "Pintasan " + a, { sh: "fill", cross: "center" });
    d.text(r, a, { size: 13, fillW: true }); d.text(r, k, { size: 13, num: true, wt: 500, color: "muted" });
  }
}
function settingsConnections({ d, c }: Ctx) {
  head(d, c, "Setelan");
  settingsTabs(d, c, 1);
  const rows: [string, string, boolean, string][] = [
    ["LLM (endpoint OpenAI-compatible)", "https://api.contoh.id/v1", true, "••••••••a1f3"],
    ["Jev", "https://jev.contoh.id", true, "••••••••09bc"],
    ["Tebar (posting)", "Belum diisi", false, "Belum ada kunci"],
  ];
  const p = panel(d, c, "Koneksi", { sh: "fill", gap: 0, pad: 0, w: 900, sv: "hug" });
  rows.forEach(([n, u, ok, k], i) => {
    const r = d.col(p, "Koneksi " + n, { sh: "fill", pad: 24, gap: 12, fill: !ok ? "raised" : "none" });
    if (!ok) d.node("rectangle", r, "beam", { absolute: true, x: 0, y: 0, w: 480, h: 3, fills: fall() });
    const t = d.row(r, "atas", { sh: "fill", cross: "center", gap: 12 });
    d.text(t, n, { size: 15, wt: 600, fillW: true });
    status(d, t, ok ? "Siap" : "Belum siap", ok);
    const f = d.row(r, "isian", { sh: "fill", gap: 12, cross: "max" });
    inputField(d, f, "Base URL", u, { fillW: true, ph: !ok });
    inputField(d, f, "Kunci API", k, { fillW: true, ph: !ok, help: ok ? "Nilai tersamar dari engine. Mengetik menggantikannya." : undefined });
    btn(d, f, "Uji koneksi", ok ? "secondary" : "primary");
    if (i < rows.length - 1) divider(d, p);
  });
  d.text(c, "Semua koneksi opsional untuk memotong. Generate memerlukan koneksi LLM.", { size: 12, color: "muted" });
}
function settingsGenerate({ d, c }: Ctx) {
  head(d, c, "Setelan");
  settingsTabs(d, c, 2);
  const p = panel(d, c, "Generate", { w: 900, sh: "fixed", gap: 16, sv: "hug" });
  h3(d, p, "Model per peran", "Kosong berarti memakai model LLM utama.");
  const g = d.row(p, "Model", { sh: "fill", gap: 16 });
  inputField(d, g, "Rencana dan cerita", "Model utama", { select: true, fillW: true });
  inputField(d, g, "Adegan dan perbaikan", "Model utama", { select: true, fillW: true });
  inputField(d, g, "Hakim teks", "Model utama", { select: true, fillW: true });
  divider(d, p);
  h3(d, p, "Suara", "KittenTTS lokal hanya tersedia di instalasi GPU.");
  inputField(d, p, "Mesin suara", "ElevenLabs", { select: true, fillW: true, help: "Mesin online dipakai di semua instalasi." });
  divider(d, p);
  h3(d, p, "Catatan model", "Kemampuan model hanya dicatat, tidak membatasi sutradara.");
  const t = d.row(p, "Catatan", { sh: "fill", gap: 12, cross: "center" });
  d.text(t, "Model utama: tingkat terbukti free", { size: 13, fillW: true });
  btn(d, t, "Kalibrasi model", "secondary");
}

// ------------------------------------------------------------------ generate
const GSTEPS = ["Brief", "Ide", "Fakta", "Alur cerita", "Rencana", "Bangun", "Putusan"];
function genHead(d: Doc, c: string, title: string, sub: string, step: number) {
  head(d, c, title, sub);
  const r = d.row(c, "Langkah", { gap: 4 });
  GSTEPS.forEach((s, i) => pill(d, r, s, i === step));
}
function genList({ d, c }: Ctx) {
  head(d, c, "Generate", "Dari brief ke video 2D. Anda menyetujui rencana dulu, lalu menerima atau mengulang versi.");
  const cols = colRow(d, c);
  const left = panel(d, cols, "Proyek", { w: 320, sh: "fixed", sv: "fill", gap: 8 });
  h3(d, left, "Proyek");
  ["Penjelasan alur kerja Sorot", "Video produk 30 detik", "Ringkasan riset kuartal"].forEach((t, i) => {
    const r = d.row(left, "Proyek " + t, { sh: "fill", h: 36, sv: "fixed", pad: [0, 12, 0, 12], cross: "center", fill: i === 0 ? "raised" : "none", radius: 6 });
    d.text(r, t, { size: 13, wt: i === 0 ? 600 : 500, fillW: true });
  });
  btn(d, left, "Proyek baru", "secondary", { sh: "fill" });
  const right = colV(d, cols, { sh: "fill", gap: 0 });
  h3(d, right, "Langkah proyek", "Satu langkah menunggu Anda.");
  const steps: [string, string, string][] = [["Brief", "Selesai", "done"], ["Ide", "Selesai", "done"], ["Fakta", "Selesai", "done"], ["Alur cerita", "Selesai", "done"], ["Rencana", "Menunggu persetujuan Anda", "wait"], ["Bangun", "Belum dimulai", "idle"], ["Putusan", "Belum dimulai", "idle"]];
  steps.forEach(([n, s, k], i) => {
    const r = d.row(right, "Langkah " + n, { sh: "fill", pad: [14, 16, 14, 16], gap: 12, cross: "center", fill: k === "wait" ? "raised" : "none" });
    if (k === "wait") d.node("rectangle", r, "beam", { absolute: true, x: 0, y: 0, w: 480, h: 3, fills: fall() });
    d.text(r, String(i + 1), { size: 15, wt: 600, num: true, color: k === "wait" ? "beamText" : "muted", w: 20 });
    d.text(r, n, { size: 13, wt: 600, fillW: true });
    d.text(r, s, { size: 13, color: k === "wait" ? "beamText" : "muted" });
    if (k === "wait") btn(d, r, "Tinjau rencana", "primary");
    divider(d, right);
  });
}
function genBrief({ d, c }: Ctx) {
  genHead(d, c, "Brief", "Ceritakan videonya. Semakin jelas tujuan dan penonton, semakin sedikit putaran ulang.", 0);
  const cols = colRow(d, c);
  const left = colV(d, cols, { sh: "fill", gap: 16 });
  inputField(d, left, "Judul proyek", "Penjelasan alur kerja Sorot", { fillW: true });
  inputField(d, left, "Tujuan video", "Jelaskan bagaimana Sorot mengubah video panjang menjadi klip pendek.", { area: true, fillW: true, focus: true });
  inputField(d, left, "Penonton", "Kreator konten pemula", { fillW: true });
  const right = panel(d, cols, "Aset", { w: 340, sh: "fixed", sv: "fill", gap: 12 });
  h3(d, right, "Aset", "Gambar, logo, atau musik yang boleh dipakai");
  d.text(right, "Belum ada aset. Jatuhkan berkas di sini. Musik harus berupa unggahan, bukan tautan.", { size: 12, color: "muted", fillW: true });
  inputField(d, right, "Durasi", "30 detik", { select: true, fillW: true });
  const act = d.row(c, "Aksi", { sh: "fill", main: "max", gap: 8 });
  btn(d, act, "Cari ide dari brief", "primary");
}
function genIdeas({ d, c }: Ctx) {
  genHead(d, c, "Ide", "Bank ide dari brief Anda. Pilih satu untuk dilanjutkan, atau tulis sendiri.", 1);
  const g = d.row(c, "Ide", { sh: "fill", gap: 16, sv: "fill" });
  ["Sebelum dan sesudah: satu video panjang jadi lima klip", "Satu jam rekaman, satu menit hasil", "Kenapa momen terbaik sering terlewat"].forEach((t, i) => {
    const p = panel(d, g, "Ide " + (i + 1), { sh: "fill", sv: "fill", gap: 12, ...(i === 0 ? { stroke: "beamText", sw: 2 } : {}) });
    d.text(p, t, { size: 19, wt: 600, fillW: true });
    d.text(p, i === 0 ? "Dibuka dengan hasil akhir, lalu menunjukkan langkahnya satu per satu." : "Sudut pandang dari sisi waktu yang terbuang.", { size: 13, color: "muted", fillW: true });
    btn(d, p, i === 0 ? "Pakai ide ini" : "Pakai", i === 0 ? "primary" : "secondary");
  });
}
function genFacts({ d, c }: Ctx) {
  genHead(d, c, "Fakta", "Klaim di naskah dicek satu per satu. Yang belum terverifikasi tidak ikut ke video.", 2);
  const p = panel(d, c, "Fakta", { sh: "fill", sv: "fill", gap: 0, pad: 0 });
  const rows: [string, string, [string, string]][] = [["Sorot membuat klip 9:16 dari video panjang", "Dokumentasi Sorot", ["PASS", "pass"]], ["Transkripsi berjalan di mesin pengguna", "Dokumentasi Sorot", ["PASS", "pass"]], ["Klip rata-rata lebih singkat dari satu menit", "Belum ada sumber", ["REVIEW", "review"]]];
  rows.forEach(([t, s, v], i) => {
    const r = d.row(p, "Fakta " + (i + 1), { sh: "fill", pad: [16, 24, 16, 24], gap: 16, cross: "center", fill: i === 2 ? "raised" : "none" });
    if (i === 2) d.node("rectangle", r, "beam", { absolute: true, x: 0, y: 0, w: 480, h: 3, fills: fall() });
    const tx = d.col(r, "teks", { sh: "fill", gap: 2 });
    d.text(tx, t, { size: 13, wt: 600, fillW: true }); d.text(tx, s, { size: 12, color: "muted", fillW: true });
    verdictMark(d, r, v[0], v[1]);
    btn(d, r, i === 2 ? "Verifikasi" : "Lihat sumber", i === 2 ? "primary" : "quiet");
    divider(d, p);
  });
}
function genStory({ d, c }: Ctx) {
  genHead(d, c, "Alur cerita", "Tiga alur dari ide yang Anda pilih. Pilih satu untuk dijadikan rencana.", 3);
  const g = d.row(c, "Alur", { sh: "fill", sv: "fill", gap: 24, cross: "min" });
  const a = panel(d, g, "Alur terpilih", { w: 520, sh: "fixed", sv: "fill", gap: 12, stroke: "beamText", sw: 2 });
  d.text(a, "Alur 1: hasil dulu, lalu langkah", { size: 19, wt: 600 }); d.text(a, "Mulai dari klip jadi, mundur ke video panjangnya, lalu tiga langkah: unduh, pilih, potong.", { size: 13, color: "muted", fillW: true });
  btn(d, a, "Pilih alur ini", "primary");
  for (const n of [2, 3]) {
    const p = panel(d, g, "Alur " + n, { sh: "fill", sv: "hug", gap: 8 });
    d.text(p, `Alur ${n}`, { size: 15, wt: 600 }); d.text(p, "Berurutan dari awal sampai akhir, tanpa teaser.", { size: 13, color: "muted", fillW: true });
    btn(d, p, "Pilih", "secondary");
  }
}
function genPlan({ d, c }: Ctx) {
  genHead(d, c, "Rencana", "Adegan, durasi, suara, dan musik. Setujui sebelum membangun: bangun tidak jalan tanpa persetujuan.", 4);
  const cols = colRow(d, c);
  const l = panel(d, cols, "Adegan", { sh: "fill", sv: "fill", gap: 0, pad: 0 });
  [["Pembuka: klip jadi", "4 dtk"], ["Video panjang masuk", "6 dtk"], ["Pemilihan momen", "8 dtk"], ["Hasil akhir", "6 dtk"]].forEach(([t, s], i) => {
    const r = d.row(l, "Adegan " + (i + 1), { sh: "fill", pad: [16, 24, 16, 24], gap: 12, cross: "center" });
    d.text(r, String(i + 1), { size: 15, wt: 600, num: true, color: "muted", w: 20 }); d.text(r, t, { size: 13, wt: 500, fillW: true }); d.text(r, s, { size: 13, num: true, color: "muted" });
    divider(d, l);
  });
  const r = panel(d, cols, "Setelan", { w: 340, sh: "fixed", sv: "fill", gap: 12 });
  h3(d, r, "Suara dan musik");
  inputField(d, r, "Musik", "Belum ada unggahan", { fillW: true, ph: true, help: "Musik harus berupa unggahan." });
  inputField(d, r, "Mesin suara", "ElevenLabs", { select: true, fillW: true });
  const b = btn(d, r, "Setujui rencana", "primary", { sh: "fill" });
}
function genBuild({ d, c, w }: Ctx) {
  genHead(d, c, "Bangun", "Sutradara membangun adegan satu per satu. Anda bisa membatalkan di langkah atau panggilan berikutnya.", 5);
  stageTrack(d, c, 5, { w: Math.min(w - 64 - 80, 1100) }, true);
  const cols = colRow(d, c);
  const log = panel(d, cols, "Catatan sutradara", { sh: "fill", sv: "fill", gap: 6, pad: 16 });
  h3(d, log, "Catatan sutradara");
  for (const l of ["Adegan 3: memeriksa gambar, temuan teks_di_atas_objek", "Adegan 3: dibangun ulang satu tingkat lebih rendah", "Adegan 2: selesai, kedua putusan lolos"]) d.text(log, l, { size: 12, color: "muted", fillW: true });
  const e = panel(d, cols, "Galat", { w: 380, sh: "fixed", sv: "hug", gap: 12 });
  d.text(e, "Versi gagal di langkah Render", { size: 15, wt: 600, color: "skip" });
  d.text(e, "Render adegan 4 melewati batas waktu. Lanjutkan dari langkah yang gagal, tanpa mengulang adegan yang sudah jadi. Jika rencana berubah, mulai versi baru.", { size: 13, color: "muted", fillW: true });
  btn(d, e, "Lanjutkan dari langkah yang gagal", "primary", { sh: "fill" });
  btn(d, e, "Mulai versi baru", "quiet", { sh: "fill" });
}
function genVerdict({ d, c }: Ctx) {
  genHead(d, c, "Putusan", "Dua pemeriksaan: teknis di kode, kreatif oleh hakim yang melihat gambarnya.", 6);
  const cols = colRow(d, c);
  const l = colV(d, cols, { sh: "fill", gap: 12 });
  for (const [t, v, s] of [["Teknis", ["PASS", "pass"], "Gerak, bingkai, dan teks lolos pemeriksaan kode."], ["Kreatif", ["REVIEW", "review"], "Selesai dan gerak baik. Adegan 3 terasa padat, pertimbangkan jeda satu detik."]] as [string, [string, string], string][]) {
    const p = panel(d, l, "Putusan " + t, { sh: "fill", gap: 8 });
    const r = d.row(p, "atas", { sh: "fill", cross: "center", gap: 12 }); d.text(r, t, { size: 15, wt: 600, fillW: true }); verdictMark(d, r, v[0], v[1]);
    d.text(p, s, { size: 13, color: "muted", fillW: true });
  }
  const act = d.row(l, "Aksi", { gap: 8 });
  btn(d, act, "Terima versi ini", "primary"); btn(d, act, "Buat ulang adegan 3", "secondary"); btn(d, act, "Terbitkan", "quiet");
  const frames = d.row(cols, "Bingkai", { gap: 12, sv: "fill" });
  [0, 1, 2].forEach((i) => { const fr = d.frame(frames, "Bingkai " + (i + 1), { w: 150, h: 267, sh: "fixed", sv: "fixed", fill: "surface", stroke: "divider", radius: 6 }); d.text(fr, "Adegan " + (i + 1), { size: 12, color: "muted", x: 12, y: 12 }); });
}
function genVersions({ d, c }: Ctx) {
  head(d, c, "Riwayat versi", "Setiap bangun menjadi satu versi. Pulihkan yang lama tanpa menghapus yang baru.");
  const p = panel(d, c, "Versi", { sh: "fill", sv: "fill", gap: 0, pad: 0 });
  [["Versi 3", "Gagal di Render", "skip"], ["Versi 2", "Diterima", "pass"], ["Versi 1", "Dibatalkan", "muted"]].forEach(([n, s, col], i) => {
    const r = d.row(p, n, { sh: "fill", pad: [16, 24, 16, 24], gap: 16, cross: "center", fill: i === 1 ? "raised" : "none" });
    if (i === 1) d.node("rectangle", r, "beam", { absolute: true, x: 0, y: 0, w: 480, h: 3, fills: fall() });
    d.text(r, n, { size: 13, wt: 600, fillW: true }); d.text(r, s, { size: 13, wt: 600, color: col });
    btn(d, r, "Pulihkan", i === 1 ? "disabled" : "secondary");
    divider(d, p);
  });
}
function genRecipes({ d, c }: Ctx) {
  head(d, c, "Resep", "Resep membeku per proyek. Contoh bawaan hanya bisa dibaca.");
  const cols = colRow(d, c);
  const l = panel(d, cols, "Daftar", { w: 320, sh: "fixed", sv: "fill", gap: 8 });
  h3(d, l, "Resep");
  ["Penjelasan produk (bawaan)", "Ringkasan riset (bawaan)", "Resep saya"].forEach((t, i) => { const r = d.row(l, t, { sh: "fill", h: 36, sv: "fixed", pad: [0, 12, 0, 12], cross: "center", fill: i === 0 ? "raised" : "none", radius: 6 }); d.text(r, t, { size: 13, wt: i === 0 ? 600 : 500, fillW: true }); });
  const r = panel(d, cols, "Isi", { sh: "fill", sv: "fill", gap: 12 });
  h3(d, r, "Penjelasan produk", "Bawaan, hanya baca. Duplikat untuk mengubah.");
  d.text(r, "Rencana sebelum bangun. Dua putusan: teknis dan kreatif. Tidak bisa dimatikan.", { size: 13, color: "muted", fillW: true });
  const act = d.row(r, "Aksi", { gap: 8 }); btn(d, act, "Duplikat jadi resep saya", "primary"); btn(d, act, "Impor", "secondary");
}
function genKit({ d, c }: Ctx) {
  head(d, c, "Kit", "Bagian peramban yang dipakai sutradara. Bagian buatan sendiri harus tampil sama dua kali sebelum diterima.");
  const g = d.row(c, "Kit", { sh: "fill", gap: 16, wrap: true });
  ["iso", "three", "chart", "counter", "timeline", "caption"].forEach((n, i) => {
    const p = panel(d, g, "Bagian " + n, { w: 280, sh: "fixed", gap: 8 });
    d.frame(p, "contoh", { h: 96, sh: "fill", sv: "fixed", fill: "bg", stroke: "divider", radius: 6 });
    d.text(p, n, { size: 15, wt: 600 });
    d.text(p, i < 4 ? "Bawaan" : "Buatan sendiri, contoh tampil sama dua kali", { size: 12, color: "muted", fillW: true });
    btn(d, p, "Ekspor", "quiet");
  });
}

export const SCREENS: Def[] = [
  { id: "shell", rail: "Beranda", sizes: [[1280, 800]], build: shellScreen },
  { id: "readiness", rail: null, sizes: [[1280, 800]], build: readiness },
  { id: "welcome-library", rail: null, sizes: [[1280, 800]], build: welcome },
  { id: "home", rail: "Beranda", sizes: [[1280, 800], [1920, 1080]], build: homeScreen },
  { id: "job", rail: "Beranda", sizes: [[1280, 800], [1920, 1080]], build: jobScreen },
  { id: "clips", rail: "Klip", sizes: [[1280, 800], [1920, 1080]], build: clipsScreen },
  { id: "editor", rail: "Klip", sizes: [[1280, 800], [1920, 1080]], build: editorScreen },
  { id: "publish", rail: "Klip", sizes: [[1280, 800]], build: publishScreen },
  { id: "learning", rail: "Belajar", sizes: [[1280, 800]], build: learningScreen },
  { id: "discover", rail: "Temukan", sizes: [[1280, 800]], build: discoverScreen },
  { id: "settings-general", rail: "Setelan", sizes: [[1280, 800]], build: settingsGeneral },
  { id: "settings-connections", rail: "Setelan", sizes: [[1280, 800]], build: settingsConnections },
  { id: "settings-generate", rail: "Setelan", sizes: [[1280, 800]], build: settingsGenerate },
  { id: "generate", rail: "Generate", sizes: [[1280, 800]], build: genList },
  { id: "generate-brief", rail: "Generate", sizes: [[1280, 800]], build: genBrief },
  { id: "generate-ideas", rail: "Generate", sizes: [[1280, 800]], build: genIdeas },
  { id: "generate-facts", rail: "Generate", sizes: [[1280, 800]], build: genFacts },
  { id: "generate-storylines", rail: "Generate", sizes: [[1280, 800]], build: genStory },
  { id: "generate-plan", rail: "Generate", sizes: [[1280, 800]], build: genPlan },
  { id: "generate-build", rail: "Generate", sizes: [[1280, 800]], build: genBuild },
  { id: "generate-verdict", rail: "Generate", sizes: [[1280, 800]], build: genVerdict },
  { id: "generate-versions", rail: "Generate", sizes: [[1280, 800]], build: genVersions },
  { id: "generate-recipes", rail: "Generate", sizes: [[1280, 800]], build: genRecipes },
  { id: "generate-kit", rail: "Generate", sizes: [[1280, 800]], build: genKit },
];

export function screensPage(d: Doc, light: boolean) {
  const out: { ref: string; name: string }[] = [];
  let x = 0, y = 0, rowH = 0;
  const modeName = light ? "light" : "dark";
  for (const s of SCREENS) {
    for (const [w, h] of s.sizes) {
      if (x + w > 4400) { x = 0; y += rowH + 120; rowH = 0; }
      const name = `${s.id}-${modeName}-${w}x${h}`;
      const sc = screen(d, name, w, h, s.rail, x, y, light);
      s.build({ d, c: sc.content, w, h });
      d.cmd("annotation.add", { id: d.ref(sc.frame), label: NOTES[s.id] ?? "" });
      out.push({ ref: sc.frame, name });
      x += w + 120; rowH = Math.max(rowH, h);
    }
  }
  (out as any).bottom = y + rowH;
  return out;
}
