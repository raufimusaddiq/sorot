//! Every word the Generate screens show, by key: Indonesian by default, English second. This is a
//! local stand-in for the app's i18n layer (T-16); its callers only ever use `t` and `tf`, so
//! moving to the real layer is a change in this file alone. What the engine sends (errors, titles,
//! findings) is shown as it comes and is not here.

use std::sync::atomic::{AtomicBool, Ordering};

static ENGLISH: AtomicBool = AtomicBool::new(false);

/// Switches the language (Indonesian is the default).
pub fn set_english(on: bool) {
    ENGLISH.store(on, Ordering::Relaxed);
}

/// The text for `key` in the current language; an unknown key shows as itself.
pub fn t(key: &str) -> String {
    CATALOG.iter().find(|(k, _, _)| *k == key).map(|(_, id, en)| if ENGLISH.load(Ordering::Relaxed) { *en } else { *id }).unwrap_or(key).to_string()
}

/// `t(key)` with `{0}`, `{1}` ... replaced by `args`.
pub fn tf(key: &str, args: &[&str]) -> String {
    args.iter().enumerate().fold(t(key), |s, (i, a)| s.replace(&format!("{{{i}}}"), a))
}

/// `(key, Indonesian, English)`.
pub const CATALOG: &[(&str, &str, &str)] = &[
    ("title", "Generate", "Generate"),
    ("sub", "Dari brief ke video 2D. Anda menyetujui rencana dulu, lalu menerima atau mengulang versi.", "From a brief to a 2D video. You approve the plan first, then accept or redo a version."),
    ("ready", "Siap · render di {0}", "Ready · rendering on the {0}"),
    ("unavailable.cause", "Generate butuh koneksi AI", "Generate needs an AI connection"),
    ("unavailable.next", "{0} Hubungkan LLM atau Jev di Setelan.", "{0} Connect an LLM or Jev in Settings."),
    ("unavailable.open", "Buka koneksi", "Open connections"),
    ("opening.cause", "Membuka Generate", "Opening Generate"),
    ("opening.next", "Memeriksa apa yang bisa dijalankan komputer ini.", "Checking what this computer can run."),
    ("failed.cause", "Generate tidak bisa dibuka.", "Could not open Generate."),
    ("failed.next", "{0}. Coba lagi.", "{0}. Try again."),
    ("retry", "Coba lagi", "Try again"),
    ("nav.projects", "Proyek", "Projects"),
    ("nav.recipes", "Resep", "Recipes"),
    ("nav.kit", "Kit", "Kit"),
    ("projects.title", "Proyek", "Projects"),
    ("projects.new", "Proyek baru", "New project"),
    ("projects.empty", "Belum ada proyek.", "No projects yet."),
    ("steps.title", "Langkah proyek", "Project steps"),
    ("steps.waiting", "Satu langkah menunggu Anda.", "One step is waiting for you."),
    ("steps.none", "Pilih proyek, atau mulai yang baru.", "Pick a project, or start a new one."),
    ("steps.open", "Buka", "Open"),
    ("steps.loading.cause", "Membuka proyek", "Opening the project"),
    ("steps.loading.next", "Sebentar.", "One moment."),
    ("step.brief", "Brief", "Brief"),
    ("step.ideas", "Ide", "Ideas"),
    ("step.facts", "Fakta", "Facts"),
    ("step.stories", "Alur cerita", "Storylines"),
    ("step.plan", "Rencana", "Plan"),
    ("step.build", "Bangun", "Build"),
    ("step.verdict", "Putusan", "Verdict"),
    ("step.brief.sub", "Ceritakan videonya. Semakin jelas tujuan dan penonton, semakin sedikit putaran ulang.", "Tell us about the video. The clearer the goal and the viewer, the fewer rounds."),
    ("step.ideas.sub", "Bank ide: brief yang dijajarkan untuk nanti. Jalankan satu, atau tulis sendiri.", "The idea bank: briefs lined up for later. Run one, or write your own."),
    ("step.facts.sub", "Klaim di naskah dicek satu per satu. Yang belum terverifikasi tidak ikut ke video.", "The claims in the script are checked one by one. What is not verified does not go in the video."),
    ("step.stories.sub", "Pilih satu alur untuk dijadikan rencana.", "Pick one storyline to turn into the plan."),
    ("step.plan.sub", "Adegan, durasi, suara, dan musik. Setujui sebelum membangun: bangun tidak jalan tanpa persetujuan.", "Scenes, timing, voice and music. Approve before building: nothing is built without approval."),
    ("step.build.sub", "Sutradara membangun adegan satu per satu. Anda bisa membatalkan di langkah atau panggilan berikutnya.", "The director builds scene by scene. You can cancel at the next step or call."),
    ("step.verdict.sub", "Dua pemeriksaan: teknis di kode, kreatif oleh hakim yang melihat gambarnya.", "Two checks: technical in code, creative by a judge who sees the picture."),
    ("state.done", "Selesai", "Done"),
    ("state.waiting", "Menunggu persetujuan Anda", "Waiting for your approval"),
    ("state.pick", "Menunggu pilihan Anda", "Waiting for your pick"),
    ("state.working", "Sedang berjalan", "Working"),
    ("state.failed", "Gagal", "Failed"),
    ("state.idle", "Belum dimulai", "Not started"),
    ("state.skipped", "Dilewati", "Skipped"),
    ("state.review", "Tinjau", "Review"),
    ("brief.text", "Tujuan video", "What the video is about"),
    ("brief.count", "{0} / {1}", "{0} / {1}"),
    ("brief.length", "Durasi (detik, 5 sampai 90)", "Length (seconds, 5 to 90)"),
    ("brief.style", "Catatan gaya (opsional)", "Style notes (optional)"),
    ("brief.style.hint", "tenang, warna hangat", "calm, warm colours"),
    ("brief.format", "Format", "Format"),
    ("brief.language", "Bahasa", "Language"),
    ("brief.settings", "Durasi dan format", "Length and format"),
    ("brief.settings.sub", "Berkas aset (logo, gambar, musik) diunggah dari mesin saat ini.", "Asset files (logo, images, music) are uploaded from the engine for now."),
    ("brief.problem", "Tulis tujuan videonya, dan durasi 5 sampai 90 detik.", "Write what the video is about, and a length of 5 to 90 seconds."),
    ("brief.create", "Rencanakan video saya", "Plan my video"),
    ("brief.starting", "Memulai", "Starting"),
    ("lang.id", "Indonesia", "Indonesian"),
    ("lang.en", "Inggris", "English"),
    ("brief.readonly", "Brief proyek ini tidak diubah setelah dibuat.", "This project's brief is not changed once it is made."),
    ("ideas.run_next", "Jalankan ide berikutnya ({0} menunggu)", "Run the next idea ({0} waiting)"),
    ("ideas.none_new", "Tidak ada ide baru untuk dijalankan", "No new ideas to run"),
    ("ideas.empty.cause", "Belum ada ide.", "No ideas yet."),
    ("ideas.empty.next", "Tambahkan satu di bawah.", "Add one below."),
    ("ideas.note", "Satu proses membawa ide baru berikutnya sampai video diekspor; langkah yang menunggu Anda menghentikannya di situ. Menerbitkan selalu Anda yang lakukan.", "A run takes the next new idea to an exported video; a step that waits for you stops it there. Publishing is always yours to do."),
    ("ideas.run", "Pakai", "Use"),
    ("ideas.resume", "Lanjutkan", "Resume"),
    ("ideas.open", "Buka", "Open"),
    ("ideas.delete", "Hapus", "Delete"),
    ("ideas.slug", "Nama ide", "Idea name"),
    ("ideas.brief", "Brief ide", "Idea brief"),
    ("ideas.add", "Tambah ide", "Add idea"),
    ("facts.note", "Setiap fakta dicek ke halaman yang Anda sebut; hanya kutipan yang benar-benar ada di halaman itu yang dihitung.", "Each fact is checked against the page you name; only a passage really on that page counts."),
    ("facts.empty", "Belum ada fakta.", "No facts yet."),
    ("facts.was", "Sebelumnya: {0}", "Was: {0}"),
    ("facts.source", "Sumber: {0}", "Source: {0}"),
    ("facts.why", "Alasan", "Why"),
    ("facts.evidence", "Bukti", "Evidence"),
    ("facts.delete", "Hapus", "Delete"),
    ("facts.verify", "Verifikasi", "Verify"),
    ("facts.verify_n", "Periksa {0} ke sumbernya", "Check {0} against their sources"),
    ("facts.verify_again", "Periksa lagi ke sumbernya", "Check again against the sources"),
    ("facts.working", "Memeriksa", "Checking"),
    ("facts.claim", "Klaim baru", "New claim"),
    ("facts.value", "Nilai baru", "New value"),
    ("facts.url", "Alamat sumber baru", "New source address"),
    ("facts.add", "Tambah fakta", "Add fact"),
    ("fact.unverified", "belum dicek", "not checked"),
    ("fact.verified", "terverifikasi", "verified"),
    ("fact.corrected", "dikoreksi", "corrected"),
    ("fact.unverifiable", "tak bisa diverifikasi", "unverifiable"),
    ("stories.picked", "dipilih", "picked"),
    ("stories.recommended", "disarankan", "recommended"),
    ("stories.bold", "berani", "bold"),
    ("stories.opening", "2 detik pertama: {0}", "First 2 s: {0}"),
    ("stories.beats", "Alur: {0}", "Beats: {0}"),
    ("stories.look", "Tampilan: {0} · Suara: {1}", "Look: {0} · Sound: {1}"),
    ("stories.pick", "Pilih alur ini", "Use this storyline"),
    ("stories.note", "Catatan untuk sutradara (opsional)", "A note for the director (optional)"),
    ("stories.note.hint", "lebih tenang, tanpa karakter", "calmer, no characters"),
    ("stories.more", "Tampilkan yang lain", "Show me different ones"),
    ("plan.revision", "Rencana, revisi {0}", "Plan, revision {0}"),
    ("plan.status", "{0} · {1} dtk dari {2} dtk", "{0} · {1} s of {2} s"),
    ("plan.approved", "disetujui", "approved"),
    ("plan.pending", "menunggu persetujuan Anda", "waiting for your approval"),
    ("plan.off_target", "Total adegan harus {0} dtk, lebih atau kurang 10%.", "The shots should add up to {0} s, give or take 10%."),
    ("plan.locked", "Rencana disetujui dan dikunci: perubahan membuat revisi baru yang perlu disetujui lagi.", "Plan approved and locked: a change makes a new revision that needs approving again."),
    ("plan.title", "Judul", "Title"),
    ("plan.message", "Satu hal yang diingat penonton", "The one thing the viewer remembers"),
    ("plan.secs", "{0} dtk", "{0} s"),
    ("plan.shot_seconds", "Adegan {0} detik", "Shot {0} seconds"),
    ("plan.shot_see", "Adegan {0}: yang terlihat", "Shot {0}: what we see"),
    ("plan.shot_move", "Adegan {0}: geraknya", "Shot {0}: how it moves"),
    ("plan.assumed", "Sutradara berasumsi (tidak ada di brief): {0}", "The director assumed (not in your brief): {0}"),
    ("plan.effects", "Efek pilihan sutradara: {0}", "Effects the director chose: {0}"),
    ("plan.save", "Simpan perubahan saya", "Save my edits"),
    ("plan.approve", "Setujui rencana", "Approve this plan"),
    ("plan.request", "Minta sutradara mengubah", "Ask the director for a change"),
    ("plan.revise", "Minta sutradara", "Ask the director"),
    ("plan.history", "Revisi {0}{1}{2}", "Revision {0}{1}{2}"),
    ("plan.asked", " · Anda minta: \u{201c}{0}\u{201d}", " · you asked: \u{201c}{0}\u{201d}"),
    ("plan.panel", "Suara dan musik", "Voice and music"),
    ("plan.panel.sub", "Musik harus berupa unggahan, bukan tautan. Rencana disetujui sebelum membangun.", "Music must be an upload, not a link. The plan is approved before building."),
    ("build.start", "Bangun draf", "Build a draft"),
    ("build.again", "Bangun lagi", "Build again"),
    ("build.gate", "Setujui rencana dulu: tidak ada yang dibangun dari rencana yang belum disetujui.", "Approve the plan first: nothing is built from a plan that is not approved."),
    ("build.progress", "{0}… {1}%", "{0}… {1}%"),
    ("build.queued", "Menunggu antrean", "Waiting in the queue"),
    ("build.author", "Menulis adegan", "Writing the scenes"),
    ("build.check", "Memeriksa adegan", "Checking them"),
    ("build.render", "Merender video", "Rendering the video"),
    ("build.technical", "Mengukur", "Measuring it"),
    ("build.creative", "Menilai", "Judging it"),
    ("build.building", "Membangun", "Building"),
    ("build.cancel", "Batalkan bangun", "Cancel the build"),
    ("build.failed", "Versi gagal. {0} Adegan yang sudah jadi tetap tersimpan.", "The build stopped. {0} The scenes already written are kept."),
    ("build.failed.panel", "Versi gagal di langkah ini", "The version failed at this step"),
    ("build.continue", "Lanjutkan dari langkah yang gagal", "Continue from the failed step"),
    ("build.plan_changed", "Rencana berubah sejak proses ini. Mulai versi baru.", "The plan changed since this run. Start a new version."),
    ("build.cancelled", "Bangun terakhir dibatalkan.", "The last build was cancelled."),
    ("build.estimate", "{0}", "{0}"),
    ("build.log", "Catatan sutradara", "Director notes"),
    ("build.log.show", "Tampilkan catatan sutradara", "Show director log"),
    ("build.log.hide", "Sembunyikan catatan sutradara", "Hide director log"),
    ("build.log.empty", "Belum ada.", "Nothing yet."),
    ("build.log.ok", "berhasil", "ok"),
    ("build.log.failed", "gagal", "failed"),
    ("build.versions", "Riwayat versi", "Version history"),
    ("about.secs", "sekitar {0} dtk", "about {0} s"),
    ("about.mins", "sekitar {0} menit", "about {0} min"),
    ("verdict.version", "Versi {0}", "Version {0}"),
    ("verdict.technical", "Teknis", "Technical"),
    ("verdict.creative", "Kreatif", "Creative"),
    ("verdict.technical.about", "Diukur di kode: ukuran, panjang, teks, keterbacaan, suara. FAIL menahan ekspor.", "Measured by code: size, length, text, readability, sound. A FAIL blocks the export."),
    ("verdict.creative.about", "Hakim terpisah yang hanya melihat brief, rencana, dan hasilnya. Memandu perbaikan, tidak pernah menahan.", "A separate judge who only saw the brief, the plan and the result. It guides the next fix and never blocks."),
    ("verdict.not_judged", "belum dinilai", "not judged yet"),
    ("verdict.judged_by", "Dinilai oleh {0}.", "Judged by {0}."),
    ("verdict.nothing", "Tidak ada yang perlu diperbaiki.", "Nothing to fix."),
    ("verdict.kept", "Dipertahankan dengan sengaja", "Kept on purpose"),
    ("verdict.no_reason", "tanpa alasan", "no reason given"),
    ("verdict.fix_hint", "Perbaikan: {0}", "Fix: {0}"),
    ("verdict.fix_this", "Perbaiki ini", "Fix this"),
    ("verdict.fix_must", "Perbaiki yang wajib ({0})", "Fix the must-fix items ({0})"),
    ("verdict.note", "Atau katakan ke sutradara apa yang diubah", "Or tell the director what to change"),
    ("verdict.fix_note", "Perbaiki dengan catatan ini", "Fix with this note"),
    ("verdict.accept", "Terima versi ini", "Accept this version"),
    ("verdict.accepted", "Diterima", "Accepted"),
    ("verdict.blocked", "TEKNIS gagal: perbaiki temuan wajib dulu.", "TECHNICAL failed: fix the must-fix findings first."),
    ("verdict.needs_approval", "{0}. Kata atau waktu rencana berubah, jadi perlu persetujuan Anda lagi sebelum dibangun.", "{0}. The plan's words or timing changed, so it needs your approval again before anything is built."),
    ("verdict.export", "Ekspor video", "Export the video"),
    ("verdict.exported", "Terekspor: {0}", "Exported: {0}"),
    ("verdict.reveal", "Tampilkan di folder", "Show in folder"),
    ("verdict.draft", "Draf: {0}", "Draft: {0}"),
    ("verdict.reveal_draft", "Tampilkan draf di folder", "Show the draft in its folder"),
    ("verdict.empty.cause", "Belum ada versi jadi.", "No finished version yet."),
    ("verdict.empty.next", "Bangun draf dulu.", "Build a draft first."),
    ("versions.title", "Riwayat versi", "Version history"),
    ("versions.sub", "Setiap bangun menjadi satu versi. Pulihkan yang lama tanpa menghapus yang baru.", "Every build is kept as a version. Restore an old plan without deleting the new."),
    ("versions.version", "Versi {0}", "Version {0}"),
    ("versions.view", "Lihat", "View"),
    ("versions.showing", "Ditampilkan", "Showing"),
    ("versions.restore", "Pulihkan", "Restore"),
    ("versions.current", "Rencana saat ini", "Current plan"),
    ("versions.fixed_from", "diperbaiki dari versi {0}", "fixed from version {0}"),
    ("versions.removed", "video dihapus untuk hemat ruang", "video removed to save space"),
    ("versions.none", "Belum ada versi.", "No versions yet."),
    ("status.QUEUED", "menunggu", "waiting"),
    ("status.BUILDING", "membangun", "building"),
    ("status.BUILT", "jadi", "built"),
    ("status.FAILED", "gagal", "failed"),
    ("status.CANCELLED", "dibatalkan", "cancelled"),
    ("project.working", "Sutradara sedang mengerjakan rencana…", "The director is working on the plan…"),
    ("project.stories", "Menulis alur cerita…", "Writing storylines…"),
    ("project.plan_from", "Menulis rencana dari pilihan Anda…", "Writing the plan from your pick…"),
    ("project.failed", "Gagal: {0}. Yang sudah tersimpan tetap ada; Coba lagi melanjutkan dari langkah yang gagal.", "That did not work: {0}. Everything saved so far is kept; Retry picks up at the step that failed."),
    ("project.no_reason", "tanpa alasan", "no reason given"),
    ("project.delete", "Hapus proyek ini", "Delete this project"),
    ("recipes.title", "Resep", "Recipes"),
    ("recipes.sub", "Resep membeku per proyek. Contoh bawaan hanya bisa dibaca.", "Recipes freeze per project. Shipped examples are read-only."),
    ("recipes.builtin", "{0} (bawaan)", "{0} (built in)"),
    ("recipes.unavailable", "{0} — tidak tersedia", "{0} — unavailable"),
    ("recipes.readonly", "Bawaan, hanya baca. Duplikat untuk mengubah.", "Built in, read-only. Make a copy to change it."),
    ("recipes.copy_mine", "Duplikat jadi resep saya", "Make my copy"),
    ("recipes.copy", "Duplikat", "Copy"),
    ("recipes.text", "Resep (JSON)", "Recipe (JSON)"),
    ("recipes.validate", "Periksa", "Check it"),
    ("recipes.save", "Simpan", "Save"),
    ("recipes.delete", "Hapus", "Delete"),
    ("recipes.export", "Ekspor sebagai JSON", "Export as shareable JSON"),
    ("recipes.valid", "Resep valid.", "The recipe is valid."),
    ("recipes.warning", "Peringatan: {0}", "Warning: {0}"),
    ("recipes.import_text", "Tempel resep bersama (JSON)", "Paste a shared recipe (JSON)"),
    ("recipes.import", "Impor", "Import"),
    ("recipes.empty.cause", "Belum ada resep.", "No recipes."),
    ("recipes.empty.next", "Impor satu di bawah.", "Import one below."),
    ("recipes.bad_json", "Resep bukan JSON yang valid: {0}", "The recipe is not valid JSON: {0}"),
    ("recipes.bad_import", "Itu bukan JSON yang valid: {0}", "That is not valid JSON: {0}"),
    ("kit.title", "Kit", "Kit"),
    ("kit.sub", "Bagian peramban yang dipakai sutradara. Bagian buatan sendiri harus tampil sama dua kali sebelum diterima.", "Browser parts the director uses. Your own parts must render the same twice before they are accepted."),
    ("kit.builtin", "Bawaan", "Built in"),
    ("kit.own", "Buatan sendiri", "Yours"),
    ("kit.export", "Ekspor", "Export"),
    ("kit.remove", "Hapus {0}", "Remove {0}"),
    ("kit.removed", "Dihapus.", "Removed."),
    ("kit.saved", "Tersimpan di {0}", "Saved to {0}"),
    ("kit.empty.cause", "Belum ada bagian.", "No parts."),
    ("kit.empty.next", "Mesin belum memasang satu pun.", "The engine has none installed."),
    ("kit.loading", "Memuat", "Loading"),
];

#[cfg(test)]
mod tests {
    use super::*;

    /// Every `t("key")` and `tf("key", ..)` in the Generate sources names a catalog entry, the
    /// keys built at run time (steps, states, statuses, verdicts) exist too, and both languages
    /// carry the same `{n}` slots.
    #[test]
    fn every_key_in_use_is_in_the_catalog_in_both_languages() {
        let sources = [
            include_str!("mod.rs"), include_str!("brief.rs"), include_str!("build.rs"), include_str!("facts.rs"), include_str!("ideas.rs"), include_str!("kit.rs"),
            include_str!("plan.rs"), include_str!("recipes.rs"), include_str!("storylines.rs"), include_str!("verdict.rs"), include_str!("versions.rs"),
        ];
        let mut used: Vec<String> = vec![];
        for src in sources {
            for call in ["t(\"", "tf(\""] {
                for (at, _) in src.match_indices(call) {
                    // a call of `t`/`tf` itself, not the end of another name such as `get(`
                    if src[..at].chars().next_back().is_some_and(|c| c.is_alphanumeric() || c == '_') {
                        continue;
                    }
                    used.push(src[at + call.len()..].split('"').next().unwrap_or_default().to_string());
                }
            }
        }
        used.extend(["lang.id", "lang.en"].map(String::from));
        let steps = ["brief", "ideas", "facts", "stories", "plan", "build", "verdict"];
        used.extend(steps.iter().flat_map(|s| [format!("step.{s}"), format!("step.{s}.sub")]));
        used.extend(["QUEUED", "BUILDING", "BUILT", "FAILED", "CANCELLED"].map(|s| format!("status.{s}")));
        used.extend(["unverified", "verified", "corrected", "unverifiable"].map(|s| format!("fact.{s}")));
        used.extend(["technical", "creative"].iter().flat_map(|k| [format!("verdict.{k}"), format!("verdict.{k}.about")]));
        used.extend(["author", "check", "render", "technical", "creative"].map(|k| format!("build.{k}")));
        let missing: Vec<&String> = used.iter().filter(|k| !CATALOG.iter().any(|(c, _, _)| c == k)).collect();
        assert!(missing.is_empty(), "keys used but not in the catalog: {missing:?}");

        let slots = |s: &str| (0..4).filter(|i| s.contains(&format!("{{{i}}}"))).collect::<Vec<_>>();
        for (key, id, en) in CATALOG {
            assert!(!id.is_empty() && !en.is_empty(), "{key}");
            assert_eq!(slots(id), slots(en), "{key}: the slots differ between languages");
        }
        set_english(true);
        let english = tf("ready", &["CPU"]);
        set_english(false);
        assert_eq!((english, tf("ready", &["CPU"]), t("no.such.key")), ("Ready · rendering on the CPU".to_string(), "Siap · render di CPU".to_string(), "no.such.key".to_string()));
    }
}
