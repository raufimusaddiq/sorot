import { Doc, ONBEAM, GLOW } from "./fc";
import { stageTrack, heatHead, GRAIN, HEAT, Heat } from "./components";
import { panel, btn, h3, divider, fall } from "./ui";

// Empty / loading / error for every data view: each names the cause and the next action (R-27).
const ROWS: [string, [string, string, string][]][] = [
  ["Klip", [
    ["Belum ada klip", "Jatuhkan video atau tempel tautan untuk mulai.", "Potong video ini"],
    ["Memuat klip", "Berjalan 00:03. Engine sedang membaca daftar klip video ini.", "Batalkan"],
    ["Klip tidak bisa dimuat", "Engine menjawab galat 500 untuk video ini. Coba lagi, atau buka log untuk sebabnya.", "Coba lagi"],
  ]],
  ["Pekerjaan", [
    ["Tidak ada pekerjaan berjalan", "Impor video untuk memulai. Pekerjaan yang selesai ada di Klip.", "Potong video baru"],
    ["Menunggu giliran", "Satu pekerjaan berjalan sekarang, Anda berikutnya. Mesin ini memproses satu per satu.", "Lihat pekerjaan berjalan"],
    ["Berhenti di tahap Skor", "ffmpeg keluar dengan kode 1. Hasil tahap sebelumnya aman. Coba lagi dari tahap ini.", "Coba lagi dari Skor"],
  ]],
  ["Editor", [
    ["Pilih klip untuk diedit", "Buka Klip, pilih satu, lalu tekan Edit klip.", "Buka Klip"],
    ["Merender pratinjau", "Berjalan 00:08. Pratinjau tidak menyentuh berkas asli.", "Batalkan"],
    ["Render ulang gagal", "Berkas sumber tidak ada di folder data. Impor ulang video, lalu coba lagi.", "Impor ulang"],
  ]],
  ["Terbitkan", [
    ["Belum ada akun tersambung", "Hubungkan Tebar di Setelan agar bisa memposting.", "Buka Koneksi"],
    ["Menyusun teks unggahan", "Berjalan 00:05. LLM menulis teks untuk tiap platform.", "Tulis sendiri"],
    ["Unggahan ditolak", "TikTok menolak: akun belum terhubung. Posting ini tersimpan, tidak terkirim dua kali.", "Coba kirim lagi"],
  ]],
  ["Belajar dan Temukan", [
    ["Belum ada hasil tercatat", "Catat tayangan dari klip yang sudah diposting. Angka tidak diisi otomatis.", "Catat hasil unggahan"],
    ["Mencari video", "Berjalan 00:06. Bing menjawab, kandidat sedang disaring.", "Batalkan"],
    ["Pencarian gagal", "Bing tidak menjawab dalam 10 detik. Coba lagi, atau impor tautan langsung.", "Coba lagi"],
  ]],
  ["Setelan dan Generate", [
    ["Generate memerlukan koneksi AI", "Belum ada LLM yang terhubung. Memotong video tetap jalan tanpanya. Sambungkan LLM di Setelan.", "Buka Koneksi"],
    ["Menguji koneksi", "Berjalan 00:02. Menunggu jawaban dari endpoint LLM.", "Batalkan"],
    ["Kunci ditolak", "LLM menjawab HTTP 401. Periksa kunci API, lalu uji lagi.", "Ubah kunci"],
  ]],
];

export function statesPage(d: Doc, light: boolean) {
  const name = `states-${light ? "light" : "dark"}-1440x1700`;
  const f = d.col(null, name, { x: 0, y: 0, w: 1440, h: 1700, sh: "fixed", sv: "fixed", fill: "bg", pad: 40, gap: 24, clip: true });
  if (light) d.cmd("variable.setMode", { ids: [d.ref(f)], collection: "color", mode: "light" });
  d.text(f, "Keadaan kosong, memuat, dan galat", { size: 26, wt: 600 });
  d.text(f, "Setiap pandangan data menyebut sebabnya dan langkah berikutnya. Menunggu menampilkan waktu berjalan, bukan spinner.", { size: 13, color: "muted" });
  for (const [screen, cards] of ROWS) {
    d.text(f, screen, { size: 15, wt: 600 });
    const r = d.row(f, "Baris " + screen, { sh: "fill", gap: 16 });
    cards.forEach(([t, b, a], i) => {
      const p = panel(d, r, "Keadaan " + ["kosong", "memuat", "galat"][i], { sh: "fill", gap: 8 });
      d.text(p, ["Kosong", "Memuat", "Galat"][i], { size: 12, wt: 500, color: "muted" });
      d.text(p, t, { size: 15, wt: 600, color: i === 2 ? "skip" : "text", fillW: true });
      d.text(p, b, { size: 13, color: "muted", fillW: true });
      btn(d, p, a, i === 0 ? "primary" : "secondary");
    });
  }
  return { ref: f, name };
}

export function motionPage(d: Doc) {
  d.cmd("page.setBackground", { color: "#0E0F11" });
  const f = d.col(null, "Motion notes", { x: 0, y: 0, w: 1600, h: 2450, sh: "fixed", sv: "fixed", fill: "bg", pad: 40, gap: 24 });
  d.text(f, "Catatan gerak: MOTION 2, MOTION 3 pada layar Job", { size: 26, wt: 600 });
  d.text(f, "Gerak menjelaskan perubahan, tidak menghias. Layar Job naik ke MOTION 3 (keputusan pemilik, 2026-11-15) karena digerakkan progres nyata, dan rune-fx menggerakkan momen tanda tangan: kepala beam (lampu panas), riak tahap selesai, ledakan percikan pekerjaan selesai, blur gerak saat peringkat berubah, kaca beralur. Semua sekali jalan, tidak ada animasi berulang (R-19).", { size: 13, color: "muted", w: 1100 });
  const rows: [string, string, string, string][] = [
    ["Beam berjalan di stage track", "Kepala beam bergeser ke posisi baru tiap PROGRESS dari engine, 240 ms ease-out. Tahap selesai berubah jadi tanda tetap. Tanpa PROGRESS, beam diam dan waktu berjalan yang bertambah.", "Perpindahan langsung ke posisi baru, tanpa tween.", "Menunjukkan progres nyata dan tahap yang sedang bekerja."],
    ["Kepala beam (lampu panas)", "Kepala menghangat saat PROGRESS datang (serang cepat) dan mendingin pelan saat tahap diam: dingin, menghangat, panas. Fx::glow dengan GlowParams::heat. Butir hanya di badan beam.", "Tiga tingkat panas jadi satu tampilan tetap tanpa pendinginan beranimasi; posisi kepala berpindah langsung.", "Beam berperilaku seperti lampu nyata yang menghangat karena kerja."],
    ["Riak tahap selesai", "Satu riak keluar dari simpul tahap, 0,6 dtk, sekali jalan (OneShots, Fx::pulse), lalu tahap menetap jadi tanda tetap.", "Tanpa riak; tanda tetap muncul dengan memudar 0,15 dtk.", "Menandai serah-terima ke tahap berikutnya."],
    ["Pekerjaan selesai", "Satu ledakan percikan (SparkleParams::burst) pada aksi Lihat klip, 0,5 dtk, sekali. Bukan ikon: partikel yang hilang sendiri.", "Tanpa percikan; aksi Lihat klip menyala dengan memudar 0,15 dtk.", "Satu-satunya momen yang layak dirayakan."],
    ["Klip naik ke peringkat", "Baris klip berpindah ke urutan skor dengan spring (kekakuan 260, redaman 26, mengendap sekitar 320 ms) saat skor masuk, dengan blur gerak sepanjang jalur (MotionSamples::from_track).", "Baris langsung di posisi akhir tanpa blur; ganti memudar 0,15 dtk.", "Urutan berarti skor."],
    ["Klip terpilih ke panggung, lalu editor", "Elemen bersama: miniatur membesar menjadi panggung klip (280 ms spring), lalu linimasa editor muncul di bawahnya.", "Pindah layar langsung, tempat pengguna dipertahankan.", "Menjaga tempat pengguna saat layar berganti."],
    ["Hover dan tekan", "Tint 120 ms linear. Tekan menggeser kontrol 1 px ke bawah, 80 ms.", "Tint langsung, tanpa geser.", "Tanda bahwa kontrol bisa ditekan."],
    ["Toast", "Masuk dari tepi 200 ms ease-out, bertahan 6 detik, jeda saat kursor di atasnya, lalu keluar 150 ms.", "Muncul dan hilang dengan memudar 0,15 dtk; tetap 6 detik dengan jeda saat hover.", "Mengumumkan tanpa memblokir."],
    ["Palet perintah", "Muncul memudar dan naik 8 px, 150 ms. Kaca beralur dengan frost 20 (FlutedGlassParams) sudah ada di permukaannya; bilah transport memakai frost 12.", "Muncul memudar 0,15 dtk tanpa geser; kaca tetap, tidak beranimasi.", "Layar di belakang tetap terbaca. Hanya dua permukaan kaca."],
  ];
  const t = panel(d, f, "Tabel gerak", { sh: "fill", gap: 0, pad: 0 });
  const hd = d.row(t, "Kepala", { sh: "fill", pad: [16, 24, 12, 24], gap: 24 });
  for (const [h, w] of [["Momen", 240], ["Gerak", 520], ["Gerak dikurangi", 340], ["Tujuan", 280]] as [string, number][]) d.text(hd, h, { size: 12, wt: 500, color: "muted", w });
  divider(d, t);
  for (const r of rows) {
    const row = d.row(t, "Baris " + r[0], { sh: "fill", pad: [16, 24, 16, 24], gap: 24 });
    r.forEach((c, i) => d.text(row, c, { size: 13, wt: i === 0 ? 600 : 400, color: i === 0 ? "text" : "muted", w: [240, 520, 340, 280][i] }));
    divider(d, t);
  }
  d.text(f, "Beam berjalan: tiga PROGRESS berurutan (sketsa)", { size: 15, wt: 600 });
  for (const [a, p] of [[1, 10], [3, 40], [4, 62]] as [number, number][]) stageTrack(d, f, a, { w: 1100 }, false, p, a - 1);
  // ---- rune-fx sketches (static frames of one-shots; never loops)
  d.text(f, "Kepala beam: tiga tingkat panas (cool, warming, hot)", { size: 15, wt: 600 });
  const hr = d.row(f, "Panas", { gap: 40 });
  (["cool", "warming", "hot"] as Heat[]).forEach((h) => {
    const c = d.frame(hr, "Panas " + h, { w: 300, h: 56, sh: "fixed", sv: "fixed", fill: "surface", stroke: "divider", radius: 6 });
    d.rect(c, "track", { x: 16, y: 20, w: 268, h: 2, fill: "divider" });
    d.node("rectangle", c, "falloff", { x: 20, y: 18, w: 250, h: 6, effects: [GRAIN], fills: [{ type: "linearGradient", from: [1, 0.5], to: [0, 0.5], stops: [{ position: 0, color: "#F0B44C" }, { position: 1, color: "#F0B44C00" }] }] });
    heatHead(d, c, h, 270, 21);
    d.text(c, h, { size: 12, wt: 500, color: "muted", x: 16, y: 34 });
  });
  d.text(f, "Riak tahap selesai: empat bingkai dalam 0,6 dtk (sekali jalan)", { size: 15, wt: 600 });
  const rr = d.row(f, "Riak", { gap: 24 });
  [[0, 8, 0.6], [0.2, 16, 0.4], [0.4, 24, 0.2], [0.6, 32, 0.05]].forEach(([t, rad, op]) => {
    const c = d.frame(rr, "Riak " + t, { w: 150, h: 96, sh: "fixed", sv: "fixed", fill: "surface", stroke: "divider", radius: 6 });
    d.rect(c, "tahap selesai", { x: 69, y: 36, w: 12, h: 12, fill: "beam", radius: 2 });
    d.node("ellipse", c, "ring", { x: 75 - rad, y: 42 - rad, w: rad * 2, h: rad * 2, fill: "none", stroke: "#F0B44C", sw: 1.5, opacity: op });
    d.text(c, String(t).replace(".", ",") + " dtk", { size: 12, num: true, color: "muted", x: 12, y: 74 });
  });
  d.text(f, "Pekerjaan selesai: ledakan percikan pada Lihat klip (0,5 dtk, sekali)", { size: 15, wt: 600 });
  const sr = d.row(f, "Percikan", { gap: 24 });
  [[0, 6, 0.9], [0.15, 22, 0.7], [0.3, 38, 0.4], [0.5, 54, 0.1]].forEach(([t, rad, op]) => {
    const c = d.frame(sr, "Percikan " + t, { w: 200, h: 120, sh: "fixed", sv: "fixed", fill: "surface", stroke: "divider", radius: 6 });
    const b = d.frame(c, "Lihat klip", { x: 40, y: 42, w: 120, h: 36, fill: "beam", radius: 6, layout: "horizontal", main: "center", cross: "center", sh: "fixed", sv: "fixed" });
    d.text(b, "Lihat klip", { size: 13, wt: 600, color: "#17191C" });
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2, px = 100 + Math.cos(a) * (rad + 40) * 1.2, py = 60 + Math.sin(a) * (rad + 18);
      if (px < 4 || px > 190 || py < 4 || py > 112) continue;
      d.rect(c, "partikel", { x: px, y: py, w: 4, h: 4, fill: "#F0B44C", opacity: op, rotation: 45 });
    }
    d.text(c, String(t).replace(".", ",") + " dtk", { size: 12, num: true, color: "muted", x: 8, y: 100 });
  });
  d.text(f, "Blur gerak saat peringkat berubah: sampel sepanjang jalur spring", { size: 15, wt: 600 });
  const br = d.frame(f, "Blur", { w: 420, h: 150, sh: "fixed", sv: "fixed", fill: "surface", stroke: "divider", radius: 6 });
  [[0, 0.12], [14, 0.2], [28, 0.35], [44, 0.6], [60, 1]].forEach(([dy, op]) => d.rect(br, "sampel", { x: 20, y: 16 + dy * 1.6 - 0, w: 380, h: 36, fill: "raised", stroke: "edge", radius: 6, opacity: op }));
  d.text(f, "Kerja engine: bila `prefers-reduced-motion` aktif, semua gerak jadi instan dan pudar 0,15 dtk (bawaan Rune). rune::motion_gate di tes menggagalkan gerak yang patah.", { size: 12, color: "muted", w: 1100 });
  return f;
}

export const NOTES: Record<string, string> = {
  shell: "Decision: where to go next. Beam: the command palette input (focus). EN: Home with the command palette open and a toast.",
  readiness: "Decision: fix what is not ready. Beam: the first item that is not ready. EN: First-run readiness checklist.",
  "welcome-library": "Decision: adopt, copy or start fresh. Beam: the recommended library. EN: Existing data libraries found on this machine.",
  home: "Decision: what to clip next. Beam: the link field and its primary action. EN: Import (drop a file or paste a link) with import options.",
  job: "Decision: wait, cancel or move on. Beam: the active stage on the stage track; head is a hot heat light, grain on the beam fill, stage-done pulse ripple caught at 0.2 s of 0.6 s. MOTION 3 on this screen (owner, 2026-11-15). EN: Running job, 62% at Score.",
  clips: "Decision: which clips are worth posting. Beam: the selected clip row and the clip stage. EN: Ranked clips beside the 9:16 stage.",
  editor: "Decision: what to change before export. Beam: the hook marker on the timeline. EN: Clip editor with timeline and options.",
  publish: "Decision: what goes out, where, with which choices. Beam: the user-owned choices block, never auto-filled. EN: Publish draft per platform.",
  learning: "Decision: are posted results teaching the scorer. Beam: the latest real feedback row. EN: Learning from recorded results.",
  discover: "Decision: which source video to import. Beam: the first candidate. EN: Discover source videos.",
  "settings-general": "Decision: how the app behaves. Beam: the language field. EN: General settings (language, theme, tray, notifications, shortcuts).",
  "settings-connections": "Decision: what is connected and working. Beam: the first item that is not ready. EN: Connections (LLM, Jev, Tebar), masked keys.",
  "settings-generate": "Decision: models and voice for Generate. Beam: model fields. EN: Generate settings.",
  generate: "Decision: approve the plan. Beam: the step waiting for the user. EN: Generate projects and steps.",
  "generate-brief": "Decision: what the video is about. Beam: the goal field. EN: Generate brief.",
  "generate-ideas": "Decision: which idea. Beam: the chosen idea. EN: Idea bank.",
  "generate-facts": "Decision: which claims stay. Beam: the claim that needs verification. EN: Facts panel.",
  "generate-storylines": "Decision: which storyline. Beam: the chosen storyline. EN: Storyline cards.",
  "generate-plan": "Decision: approve the plan. Beam: Approve plan. EN: Plan editor.",
  "generate-build": "Decision: continue a failed build. Beam: the failed stage and Continue from the failed step. EN: Build with director log.",
  "generate-verdict": "Decision: accept or redo. Beam: Accept this version. EN: Two verdicts (technical, creative).",
  "generate-versions": "Decision: which version to restore. Beam: the accepted version. EN: Version history.",
  "generate-recipes": "Decision: which recipe. Beam: the selected recipe. EN: Recipes (shipped ones read-only).",
  "generate-kit": "Decision: which kit part. Beam: none needed, a catalogue. EN: Kit parts.",
};
