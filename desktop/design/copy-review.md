# Copy review (antislop AFTER, session override)

Mode: AFTER. Audit only; no wording changed in T109. Findings below wait for owner approval (T110).

## Findings

1. Key `welcome.continue` / id `Lanjut` / en `Continue`. Issue: R-15 generic CTA; does not say what continues. Proposed id `Lanjutkan impor`, en `Continue import`.
2. Key `discover.go` / id `Temukan` / en `Discover`. Issue: R-15 generic label on the main action; duplicates the tab name. Proposed id `Cari videonya`, en `Find videos`.
3. Key `discover.type-query` / id `Ketik yang dicari, lalu tekan Temukan.` / en `Type what to search for, then press Discover.`. Issue: R-15 points at a generic label; vague "what to search for". Proposed id `Ketik topik, lalu tekan Cari videonya.`, en `Type a topic, then press Find videos.`
4. Key `discover.paste-channel` / id `Tempel tautan kanal, lalu tekan Temukan.` / en `Paste a channel link, then press Discover.`. Issue: R-15 same generic label. Proposed id `Tempel tautan kanal, lalu tekan Cari videonya.`, en `Paste a channel link, then press Find videos.`
5. Key `home.sub` / id `Jatuhkan video atau tempel tautan. Sorot memilih momen terbaik dan membuat klip 9:16 dengan subtitel.` / en `Drop a video or paste a link. Sorot picks the best moments and makes 9:16 clips with subtitles.`. Issue: R-16 "best moments" is an unevidenced claim about output quality. Proposed en `Drop a video or paste a link. Sorot scores moments and makes 9:16 clips with subtitles.`; id `Jatuhkan video atau tempel tautan. Sorot menilai momen dan membuat klip 9:16 dengan subtitel.`
6. Key `clips.list` / id `Klip, terbaik dulu` / en `Clips, best first`. Issue: R-16 "best" asserts quality the score does not guarantee. Proposed id `Klip, urut menurut skor`, en `Clips, ranked by score`.
7. Key `clips.empty.next` / id `Setelah proses selesai, klipnya tampil di sini, terbaik di atas.` / en `When a job finishes, its clips show here, best first.`. Issue: R-16 same "best" claim. Proposed id `Setelah proses selesai, klipnya tampil di sini, urut menurut skor.`, en `When a job finishes, its clips show here, ranked by score.`
8. Key `generate.step.build.sub` / id `Sutradara membangun adegan satu per satu. Anda bisa membatalkan di langkah atau panggilan berikutnya.` / en `The director builds scene by scene. You can cancel at the next step or call.`. Issue: R-31 unexplained metaphor "director" for a model; name the actor. Proposed en `The model builds scene by scene. You can cancel at the next step or call.`; id `Model membangun adegan satu per satu. Anda bisa membatalkan di langkah atau panggilan berikutnya.`
9. Key `generate.build.log` / id `Catatan sutradara` / en `Director notes`. Issue: R-31 same actorless metaphor. Proposed id `Catatan model`, en `Model notes` (also `generate.build.log.show`, `.hide`, and the `generate.verdict.*` notes that say "director").
10. Key `generate.verdict.creative.about` / id `Hakim terpisah yang hanya melihat brief, rencana, dan hasilnya. Memandu perbaikan, tidak pernah menahan.` / en `A separate judge who only saw the brief, the plan and the result. It guides the next fix and never blocks.`. Issue: R-31 "judge" has no named mechanism; say what it is. Proposed en `A second model reviews the brief, the plan and the result. Its notes guide the next fix and never block export.`; id `Model kedua meninjau ringkasan, rencana, dan hasil. Catatannya memandu perbaikan berikutnya dan tidak pernah memblokir ekspor.`
11. Key `publish.ready` / id `Siap. Tidak ada yang terkirim sebelum Anda menekan tombolnya.` / en `Ready. Nothing is sent until you press the button.`. Issue: C-1 "the button" points nowhere; name the action. The button label is `publish.post` = id `Posting sekarang` / en `Post now` (see `publish.rs:392`). Proposed id `Siap. Tidak ada yang terkirim sebelum Anda menekan Posting sekarang.`, en `Ready. Nothing is sent until you press Post now.`
12. Key `general.shortcut.invalid` / id `Kombinasi tombol itu tidak bisa dipakai di sini.` / en `That key combination cannot be used here.`. Issue: R-02 actorless passive; a conflict already says which action owns it in `general.shortcut.taken`. Proposed id `Sorot tidak bisa memakai kombinasi tombol ini.`, en `Sorot cannot use this key combination.`

No em dash found in either catalog (R-02 PASS). No fabricated numbers, testimonials or claims (R-17, R-18, R-36 PASS). "Discover" on the discovery screen names the feature, not a generic CTA; kept.

## New translations (T109)

Faithful Indonesian for the 77 literals that were previously hardcoded English in `welcome.rs`, `readiness.rs`, `shell.rs`, `app.rs`, `learning.rs` and the engine-failure / starting blocks. English values are the exact original strings.

| Key | id | en |
| --- | --- | --- |
| `welcome.title` | Pakai data lama Anda, atau mulai dari awal? | Use your old data, or start fresh? |
| `welcome.summary` | Sorot menemukan {n} pustaka dari versi web di komputer ini. | Sorot found {n} library(ies) from the web version on this machine. |
| `welcome.facts` | {videos} video, {clips} klip{keys} | {videos} video(s), {clips} clip(s){keys} |
| `welcome.facts.keys` | , punya kunci API | , has API keys |
| `welcome.problem` | Tidak bisa dipakai apa adanya: {why}. Menyalin mungkin tetap berhasil. | Cannot be used as it is: {why}. Copying may still work. |
| `welcome.suggested` | Disarankan: klipnya paling banyak. Memakainya di sini tidak menyalin apa pun. | Suggested: it has the most clips. Using it here copies nothing. |
| `welcome.copy` | Salin | Copy it |
| `welcome.use-here` | Pakai di sini | Use it here |
| `welcome.skipped.title` | Tersalin, kecuali {n} berkas yang tidak bisa dibaca mesin. Berkas asli tidak berubah. | Copied, except {n} file(s) the engine could not read. The original is untouched. |
| `welcome.skipped.label` | {n} berkas tidak tersalin | {n} files were not copied |
| `welcome.continue` | Lanjut | Continue |
| `welcome.copying` | Menyalin {percent}% | Copying {percent}% |
| `welcome.retry` | Coba lagi, atau mulai dari awal. | Try again, or start fresh. |
| `welcome.keys.title` | Bawa kunci API juga | Bring the API keys too |
| `welcome.keys.about` | Kunci tidak pernah ditampilkan. Kunci hanya dipindahkan ke setelan baru. | Keys are never shown. They are only moved into the new settings. |
| `welcome.keys.on` | Kunci: aktif | Keys: on |
| `welcome.keys.off` | Kunci: nonaktif | Keys: off |
| `welcome.fresh` | Mulai dengan pustaka kosong | Start with an empty library |
| `readiness.name.python` | Lingkungan Python | Python environment |
| `readiness.name.whisperModel` | Model suara (Whisper) | Speech model (Whisper) |
| `readiness.name.gpu` | Kartu grafis | Graphics card |
| `readiness.name.generateBrowser` | Peramban untuk Generate | Browser for Generate |
| `readiness.failure.offline` | Perlu internet sekali. Hubungkan, lalu coba lagi. | Needs internet once. Connect, then try again. |
| `readiness.failure.checksum` | Unduhan rusak (checksum tidak cocok). Coba lagi. | The download was damaged (checksum mismatch). Try again. |
| `readiness.failure.other` | Perbaikan gagal: {other}. Coba lagi. | The fix failed: {other}. Try again. |
| `readiness.ready` | Siap | Ready |
| `readiness.working` | Bekerja | Working |
| `readiness.not-ready` | Belum siap | Not ready |
| `readiness.needs-attention` | Perlu perhatian | Needs attention |
| `readiness.retry` | Coba lagi | Retry |
| `readiness.fix` | Perbaiki | Fix |
| `readiness.fix-all` | Perbaiki semua | Fix all |
| `readiness.title` | Sorot butuh beberapa hal dulu | Sorot needs a few things first |
| `readiness.summary` | Sorot memeriksa komputer ini sebelum memotong. {pending} item wajib belum siap. | Sorot checks this machine before it clips. {pending} required item(s) are not ready. |
| `readiness.footnote` | Setiap perbaikan lewat mesin. Tidak ada yang berubah di luar folder data Sorot. | Each fix runs through the engine. Nothing changes outside the Sorot data folder. |
| `shell.banner.lost` | Sambungan ke mesin terputus. Sorot menyambung ulang; proses yang berjalan tetap menyimpan keadaannya. | Lost the connection to the engine. Sorot is reconnecting; running jobs keep their state. |
| `shell.banner.failed` | Mesin tidak berjalan. Mulai ulang, atau ekspor laporan untuk bantuan. | The engine is not running. Restart it, or export a report for support. |
| `shell.restart-engine` | Mulai ulang mesin | Restart engine |
| `shell.export-diagnostic` | Ekspor laporan diagnostik | Export diagnostic report |
| `shell.close.title` | Tutup Sorot? | Close Sorot? |
| `shell.close.label` | Tutup Sorot? {n} proses masih berjalan. | Close Sorot? {n} job(s) are still running. |
| `shell.close.body` | {n} proses masih berjalan. Pilih yang terjadi pada proses itu. | {n} job(s) are still running. Pick what happens to them. |
| `shell.close.background` | Tetap berjalan di latar belakang | Keep running in the background |
| `shell.close.wait` | Tunggu proses selesai, lalu tutup | Wait for the jobs, then close |
| `shell.close.cancel-quit` | Batalkan proses dan keluar | Cancel the jobs and quit |
| `learning.untitled-clip` | Klip {n} | Clip {n} |
| `app.failure.before-ready` | Mesin berhenti sebelum siap. | The engine stopped before it was ready. |
| `app.failure.early` | Mesin berhenti tepat setelah mulai. | The engine stopped right after it started. |
| `app.failure.timeout` | Mesin tidak siap setelah 30 detik. | The engine was not ready after 30 seconds. |
| `app.failure.too-new` | Mesin ini lebih baru daripada aplikasi. Perbarui Sorot. | This engine is newer than the app. Update Sorot. |
| `app.failure.restarting` | Mesin terus berhenti. | The engine keeps stopping. |
| `app.failure.unauthorized` | Mesin menolak token sambungan aplikasi. | The engine refused the app's connection token. |
| `app.toast.read-options` | Tidak bisa membaca opsi: {e} | Could not read the options: {e} |
| `app.toast.cancel` | Tidak bisa membatalkan: {e} | Could not cancel: {e} |
| `app.toast.retry` | Tidak bisa mencoba lagi: {e} | Could not retry: {e} |
| `app.toast.read-clips` | Tidak bisa membaca klip: {e} | Could not read the clips: {e} |
| `app.toast.render` | Tidak bisa merender lagi: {e} | Could not render again: {e} |
| `app.toast.export` | Tidak bisa mengekspor: {e} | Could not export: {e} |
| `app.toast.saved-to` | Tersimpan di {path} | Saved to {path} |
| `app.toast.save-clip` | Tidak bisa menyimpan klip: {e} | Could not save the clip: {e} |
| `app.toast.fix` | Tidak bisa memperbaiki {id}: {e} | Could not fix {id}: {e} |
| `app.toast.started` | Dimulai: {id} | Started: {id} |
| `app.toast.find-libraries` | Tidak bisa mencari pustaka lama: {e} | Could not look for older libraries: {e} |
| `app.toast.copy-failed` | Menyalin gagal: {e} | Copying failed: {e} |
| `app.toast.keys-not-brought` | Kunci API tidak ikut terbawa: {e} | The API keys were not brought over: {e} |
| `app.toast.save-choice` | Tidak bisa menyimpan pilihan Anda: {e} | Could not save your choice: {e} |
| `app.toast.saved-report` | Laporan tersimpan di {path} | Saved the report to {path} |
| `app.toast.save-report` | Tidak bisa menyimpan laporan: {e} | Could not save the report: {e} |
| `app.toast.no-log` | Belum ada log mesin untuk diekspor. | There is no engine log to export yet. |
| `app.notify.ready.title` | Klip Anda sudah siap | Your clips are ready |
| `app.notify.ready.body` | Buka Sorot untuk melihat urutannya. | Open Sorot to see them ranked. |
| `app.notify.stopped.title` | Sebuah proses berhenti | A job stopped |
| `app.notify.stopped.body` | Buka Sorot untuk mencoba lagi. | Open Sorot to retry it. |
| `app.preview-error` | Tidak bisa membuka pemutar video Anda: {e} | Could not open your video player: {e} |
| `app.starting.cause` | Menjalankan mesin | Starting the engine |
| `app.starting.next` | Ini butuh beberapa detik saat pertama kali. | This takes a few seconds the first time. |
| `app.engine-failed.rest` | Mulai ulang, atau ekspor laporan diagnostik. | Restart it, or export a diagnostic report. |
