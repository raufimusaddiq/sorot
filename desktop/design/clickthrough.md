# Click-through (R-26/R-35)

One tap per interactive control, on Rune's in-process headless runtime against `FakeEngine`.
`cargo test --test suite clickthrough::` writes this file. Controls come from the same accessibility tree that the binary's `--tree` dumps. A tap counts when it moves focus, changes state, opens something or calls the engine; one that changes nothing fails the test (R-26).
Copy is recorded as the app renders it now (T110's rewrite is pending the owner). Native-only inputs — argv forwarding, file dialogs, system menu picks and resize — are not nodes in `--tree`; they stay in the L3 journeys in `headless_flows.rs`.

## `home-empty`

- `shell/menu/file` → (tree changed)
- `shell/menu/edit` → (tree changed)
- `shell/menu/view` → (tree changed)
- `shell/menu/window` → (tree changed)
- `shell/menu/help` → (tree changed)
- `shell/rail/home` → (tree changed)
- `shell/rail/discover` → Engine::candidates(), toast "Belum ada kandidat. Jalankan pencarian, tren, kanal, atau Temukan otomatis di atas."
- `shell/rail/generate` → Engine::settings
- `shell/rail/learning` → Engine::feedback, Engine::weights, Engine::videos, toast "0 dari 5 hasil tercatat"
- `shell/rail/settings` → Engine::settings
- `home/choose-file` → (tree changed)
- `home/link` → (tree changed)
- `home/import` → (tree changed)
- `home/direction` → (tree changed)

## `readiness-missing`

- `shell/menu/file` → (tree changed)
- `shell/menu/edit` → (tree changed)
- `shell/menu/view` → (tree changed)
- `shell/menu/window` → (tree changed)
- `shell/menu/help` → (tree changed)
- `readiness/fix-all` → Engine::fix_readiness(ffmpeg), Engine::jobs, Engine::videos, Engine::readiness
- `readiness/ffmpeg/fix` → Engine::fix_readiness(ffmpeg), Engine::jobs, Engine::videos, Engine::readiness, toast "Note: Dimulai: ffmpeg"

## `engine-failed`

- `shell/menu/file` → (tree changed)
- `shell/menu/edit` → (tree changed)
- `shell/menu/view` → (tree changed)
- `shell/menu/window` → (tree changed)
- `shell/menu/help` → (tree changed)
- `engine/restart` → toast "Menjalankan mesin Ini butuh beberapa detik saat pertama kali."
- `shell/export-diagnostic` → (tree changed)

## `first-run`

- `shell/menu/file` → (tree changed)
- `shell/menu/edit` → (tree changed)
- `shell/menu/view` → (tree changed)
- `shell/menu/window` → (tree changed)
- `shell/menu/help` → (tree changed)
- `welcome/copy` → (tree changed)
- `welcome/use-here` → (tree changed)
- `welcome/fresh` → (tree changed)

## `home-interrupted`

- `shell/menu/file` → (tree changed)
- `shell/menu/edit` → (tree changed)
- `shell/menu/view` → (tree changed)
- `shell/menu/window` → (tree changed)
- `shell/menu/help` → (tree changed)
- `shell/rail/home` → (tree changed)
- `shell/rail/discover` → Engine::candidates(), toast "Belum ada kandidat. Jalankan pencarian, tren, kanal, atau Temukan otomatis di atas."
- `shell/rail/generate` → Engine::settings
- `shell/rail/learning` → Engine::feedback, Engine::weights, Engine::videos, Engine::clips(vnew), toast "0 dari 5 hasil tercatat"
- `shell/rail/settings` → Engine::settings
- `home/choose-file` → (tree changed)
- `home/link` → (tree changed)
- `home/import` → (tree changed)
- `home/direction` → (tree changed)
- `home/interrupted/ji` → Engine::job(ji), toast "Terputus"
- `home/retry/ji` → Engine::retry_job(ji), Engine::job(ji), Engine::jobs, Engine::videos, Engine::readiness, toast "Menunggu giliran"

## `job-running`

- `shell/menu/file` → (tree changed)
- `shell/menu/edit` → (tree changed)
- `shell/menu/view` → (tree changed)
- `shell/menu/window` → (tree changed)
- `shell/menu/help` → (tree changed)
- `shell/rail/home` → toast "Memuat opsi impor / Berjalan"
- `shell/rail/discover` → Engine::candidates(), toast "Belum ada kandidat. Jalankan pencarian, tren, kanal, atau Temukan otomatis di atas."
- `shell/rail/generate` → Engine::settings
- `shell/rail/learning` → Engine::feedback, Engine::weights, Engine::videos, toast "0 dari 5 hasil tercatat"
- `shell/rail/settings` → Engine::settings
- `job/cancel` → Engine::cancel_job(j1), Engine::job(j1), Engine::jobs, Engine::videos, Engine::readiness

## `clips-ranked`

- `shell/menu/file` → (tree changed)
- `shell/menu/edit` → (tree changed)
- `shell/menu/view` → (tree changed)
- `shell/menu/window` → (tree changed)
- `shell/menu/help` → (tree changed)
- `shell/rail/home` → toast "Memuat opsi impor / Belum ada video Tempel tautan atau pilih berkas untuk membuat klip pertama Anda."
- `shell/rail/clips` → Engine::clips(vnew)
- `shell/rail/discover` → Engine::candidates(), toast "Belum ada kandidat. Jalankan pencarian, tren, kanal, atau Temukan otomatis di atas."
- `shell/rail/generate` → Engine::settings
- `shell/rail/learning` → Engine::feedback, Engine::weights, Engine::videos, toast "0 dari 5 hasil tercatat"
- `shell/rail/settings` → Engine::settings
- `clips/tab/all` → (tree changed)
- `clips/tab/pass` → (tree changed)
- `clips/tab/review` → Engine::download_preview(c1)
- `clips/tab/skip` → Engine::download_preview(c3)
- `clips/row/c2` → (tree changed)
- `clips/row/c1` → Engine::download_preview(c1)
- `clips/row/c3` → Engine::download_preview(c3)
- `clips/play` → (tree changed)
- `clips/edit` → Engine::options, Engine::music
- `clips/export` → Engine::export(c2), toast "Done: Terekspor. Berkasnya siap."
- `clips/publish` → Engine::social_accounts, Engine::clip_posts(c2), toast "Tebar belum tersambung. Sambungkan di Setelan, Koneksi, atau unduh klipnya dan posting sendiri."
- `clips/feedback` → (tree changed)

## `clips-publish`

- `shell/menu/file` → (tree changed)
- `shell/menu/edit` → (tree changed)
- `shell/menu/view` → (tree changed)
- `shell/menu/window` → (tree changed)
- `shell/menu/help` → (tree changed)
- `shell/rail/home` → toast "Memuat opsi impor / Belum ada video Tempel tautan atau pilih berkas untuk membuat klip pertama Anda."
- `shell/rail/clips` → Engine::clips(vnew)
- `shell/rail/discover` → Engine::candidates(), toast "Belum ada kandidat. Jalankan pencarian, tren, kanal, atau Temukan otomatis di atas."
- `shell/rail/generate` → Engine::settings
- `shell/rail/learning` → Engine::feedback, Engine::weights, Engine::videos, toast "0 dari 5 hasil tercatat"
- `shell/rail/settings` → Engine::settings
- `clips/tab/all` → (tree changed)
- `clips/tab/pass` → (tree changed)
- `clips/tab/review` → Engine::download_preview(c1)
- `clips/tab/skip` → Engine::download_preview(c3)
- `clips/row/c2` → (tree changed)
- `clips/row/c1` → Engine::download_preview(c1)
- `clips/row/c3` → Engine::download_preview(c3)
- `clips/play` → (tree changed)
- `clips/edit` → Engine::options, Engine::music
- `clips/export` → Engine::export(c2), toast "Done: Terekspor. Berkasnya siap."
- `clips/publish` → Engine::social_accounts, Engine::clip_posts(c2)
- `clips/feedback` → (tree changed)

## `palette-open`

- `palette/input` → no-op — the command palette autofocuses this field; tapping an already-focused field moves nothing
- `palette/item/new` → toast "Memuat opsi impor / Belum ada video Tempel tautan atau pilih berkas untuk membuat klip pertama Anda."
- `palette/item/quit` → toast "PASS / REVIEW / SKIP"
- `palette/item/edit-clip` → Engine::options, Engine::music
- `palette/item/home` → toast "Memuat opsi impor / Belum ada video Tempel tautan atau pilih berkas untuk membuat klip pertama Anda."
- `palette/item/clips` → Engine::clips(vnew), toast "PASS / REVIEW / SKIP"
- `palette/item/discover` → Engine::candidates(), toast "Belum ada kandidat. Jalankan pencarian, tren, kanal, atau Temukan otomatis di atas."
- `palette/item/generate` → Engine::settings
- `palette/item/learning` → Engine::feedback, Engine::weights, Engine::videos, toast "0 dari 5 hasil tercatat"
- `palette/item/settings` → Engine::settings
- `palette/item/theme` → toast "PASS / REVIEW / SKIP"
- `palette/item/hide` → toast "PASS / REVIEW / SKIP"
- `palette/item/diagnostic` → toast "PASS / REVIEW / SKIP"
- `palette/item/restart` → toast "Menjalankan mesin Ini butuh beberapa detik saat pertama kali."

## `clips-reranked`

- `shell/menu/file` → (tree changed)
- `shell/menu/edit` → (tree changed)
- `shell/menu/view` → (tree changed)
- `shell/menu/window` → (tree changed)
- `shell/menu/help` → (tree changed)
- `shell/rail/home` → toast "Memuat opsi impor / Belum ada video Tempel tautan atau pilih berkas untuk membuat klip pertama Anda."
- `shell/rail/clips` → Engine::clips(vnew)
- `shell/rail/discover` → Engine::candidates(), toast "Belum ada kandidat. Jalankan pencarian, tren, kanal, atau Temukan otomatis di atas."
- `shell/rail/generate` → Engine::settings
- `shell/rail/learning` → Engine::feedback, Engine::weights, Engine::videos, toast "0 dari 5 hasil tercatat"
- `shell/rail/settings` → Engine::settings
- `clips/tab/all` → (tree changed)
- `clips/tab/pass` → (tree changed)
- `clips/tab/review` → Engine::download_preview(c1)
- `clips/tab/skip` → Engine::download_preview(c3)
- `clips/row/c1` → Engine::download_preview(c1)
- `clips/row/c2` → (tree changed)
- `clips/row/c3` → Engine::download_preview(c3)
- `clips/play` → (tree changed)
- `clips/edit` → Engine::options, Engine::music
- `clips/export` → Engine::export(c2), toast "Done: Terekspor. Berkasnya siap."
- `clips/publish` → Engine::social_accounts, Engine::clip_posts(c2), toast "Tebar belum tersambung. Sambungkan di Setelan, Koneksi, atau unduh klipnya dan posting sendiri."
- `clips/feedback` → (tree changed)

## `editor-hook`

- `shell/menu/file` → (tree changed)
- `shell/menu/edit` → (tree changed)
- `shell/menu/view` → (tree changed)
- `shell/menu/window` → (tree changed)
- `shell/menu/help` → (tree changed)
- `shell/rail/home` → toast "Belum ada video Tempel tautan atau pilih berkas untuk membuat klip pertama Anda."
- `shell/rail/clips` → Engine::clips(vnew), toast "PASS / REVIEW / SKIP"
- `shell/rail/discover` → Engine::candidates(), toast "Belum ada kandidat. Jalankan pencarian, tren, kanal, atau Temukan otomatis di atas."
- `shell/rail/generate` → Engine::settings
- `shell/rail/learning` → Engine::feedback, Engine::weights, Engine::videos, toast "0 dari 5 hasil tercatat"
- `shell/rail/settings` → Engine::settings
- `editor/style` → (tree changed)
- `editor/reframe` → (tree changed)
- `editor/hook-first` → (tree changed)
- `editor/silence-trim` → (tree changed)
- `editor/music` → (tree changed)
- `editor/back` → toast "PASS / REVIEW / SKIP"
- `editor/rerender` → toast "Note: Belum ada yang berubah sejak render terakhir."

## `connections`

- `shell/menu/file` → (tree changed)
- `shell/menu/edit` → (tree changed)
- `shell/menu/view` → (tree changed)
- `shell/menu/window` → (tree changed)
- `shell/menu/help` → (tree changed)
- `shell/rail/home` → toast "Memuat opsi impor / Belum ada video Tempel tautan atau pilih berkas untuk membuat klip pertama Anda."
- `shell/rail/discover` → Engine::candidates(), toast "Belum ada kandidat. Jalankan pencarian, tren, kanal, atau Temukan otomatis di atas."
- `shell/rail/generate` → Engine::settings, Engine::generate_status
- `shell/rail/learning` → Engine::feedback, Engine::weights, Engine::videos, toast "0 dari 5 hasil tercatat"
- `shell/rail/settings` → Engine::settings
- `settings/tab/general` → (tree changed)
- `settings/tab/connections` → Engine::settings
- `settings/tab/generate` → Engine::settings, Engine::generate_status
- `conn/llm/enabled` → Engine::update_settings(llm, {"enabled":false}), toast "Tersimpan. Aksi berikutnya langsung memakainya; tidak perlu memulai ulang."
- `conn/llm/director` → Engine::update_settings(llm, {"director":true}), toast "Tersimpan. Aksi berikutnya langsung memakainya; tidak perlu memulai ulang."
- `conn/llm/mode-switch` → Engine::kenari_models(llm)
- `conn/llm/endpoint` → (tree changed)
- `conn/llm/model` → (tree changed)
- `conn/llm/key` → (tree changed)
- `conn/llm/test` → Engine::test_connection(llm), toast "Berfungsi: menjawab dalam 120 md, m, OK"
- `conn/llm/env` → Engine::update_settings(llm, {"baseUrl":null}), toast "Tersimpan. Aksi berikutnya langsung memakainya; tidak perlu memulai ulang."
- `conn/jev/enabled` → Engine::update_settings(jev, {"enabled":false}), toast "Tersimpan. Aksi berikutnya langsung memakainya; tidak perlu memulai ulang."
- `conn/jev/director` → Engine::update_settings(jev, {"director":false}), toast "Tersimpan. Aksi berikutnya langsung memakainya; tidak perlu memulai ulang."
- `conn/jev/endpoint` → (tree changed)
- `conn/jev/model` → (tree changed)
- `conn/jev/key` → (tree changed)
- `conn/jev/test` → Engine::test_connection(jev), toast "Berfungsi: menjawab dalam 120 md, m, OK"
- `conn/tebar/enabled` → Engine::update_settings(tebar, {"enabled":false}), toast "Tersimpan. Aksi berikutnya langsung memakainya; tidak perlu memulai ulang."
- `conn/tebar/endpoint` → (tree changed)
- `conn/tebar/key` → (tree changed)
- `conn/tebar/test` → Engine::test_connection(tebar), toast "Berfungsi: menjawab dalam 120 md, m, OK"

## `generate-settings`

- `shell/menu/file` → (tree changed)
- `shell/menu/edit` → (tree changed)
- `shell/menu/view` → (tree changed)
- `shell/menu/window` → (tree changed)
- `shell/menu/help` → (tree changed)
- `shell/rail/home` → toast "Memuat opsi impor / Belum ada video Tempel tautan atau pilih berkas untuk membuat klip pertama Anda."
- `shell/rail/discover` → Engine::candidates(), toast "Belum ada kandidat. Jalankan pencarian, tren, kanal, atau Temukan otomatis di atas."
- `shell/rail/generate` → Engine::settings, Engine::generate_status, Engine::readiness, toast "Generate butuh koneksi AI The browser Generate renders with is missing. Fix it on the first-run checklist. Hubungkan LLM atau Jev di Setelan."
- `shell/rail/learning` → Engine::feedback, Engine::weights, Engine::videos, toast "0 dari 5 hasil tercatat"
- `shell/rail/settings` → Engine::settings, Engine::kenari_models(llm), Engine::kenari_account
- `settings/tab/general` → (tree changed)
- `settings/tab/connections` → Engine::settings, Engine::kenari_models(llm), Engine::kenari_account
- `settings/tab/generate` → Engine::settings, Engine::kenari_voice_models, Engine::kenari_models(image), Engine::generate_status, Engine::generate_models
- `gen/voice/enabled` → Engine::update_settings(voice, {"enabled":false}), toast "Tersimpan. Aksi berikutnya langsung memakainya; tidak perlu memulai ulang."
- `gen/voice/engine/none` → Engine::update_settings(voice, {"engine":""}), toast "Tersimpan. Aksi berikutnya langsung memakainya; tidak perlu memulai ulang."
- `gen/voice/engine/elevenlabs` → Engine::update_settings(voice, {"engine":"elevenlabs"}), toast "Tersimpan. Aksi berikutnya langsung memakainya; tidak perlu memulai ulang."
- `gen/voice/engine/fish` → Engine::update_settings(voice, {"engine":"fish"}), toast "Tersimpan. Aksi berikutnya langsung memakainya; tidak perlu memulai ulang."
- `gen/voice/engine/openai` → Engine::update_settings(voice, {"engine":"openai"}), toast "Tersimpan. Aksi berikutnya langsung memakainya; tidak perlu memulai ulang."
- `gen/voice/mode-custom` → (tree changed)
- `gen/voice/kenari/model/0` → (tree changed)
- `gen/voice/kenari/model/1` → (tree changed)
- `gen/voice/key` → (tree changed)
- `gen/voice/voice/id/default` → (tree changed)
- `gen/voice/voice/id/0` → (tree changed)
- `gen/voice/voice/id/1` → (tree changed)
- `gen/voice/voice/id/2` → (tree changed)
- `gen/voice/voice/id/3` → (tree changed)
- `gen/voice/voice/en/default` → (tree changed)
- `gen/voice/voice/en/0` → (tree changed)
- `gen/voice/voice/en/1` → (tree changed)
- `gen/voice/voice/en/2` → (tree changed)
- `gen/voice/voice/en/3` → (tree changed)
- `gen/voice/test` → Engine::test_connection(voice), toast "Berfungsi: menjawab dalam 120 md, m, OK"
- `gen/image/mode-custom` → (tree changed)
- `gen/image/enabled` → Engine::update_settings(image, {"enabled":false}), toast "Tersimpan. Aksi berikutnya langsung memakainya; tidak perlu memulai ulang."
- `gen/image/kenari/model/0` → (tree changed)
- `gen/image/kenari/model/1` → (tree changed)
- `gen/image/kenari/model/2` → (tree changed)
- `gen/image/size` → (tree changed)
- `gen/image/style` → (tree changed)
- `gen/image/key` → (tree changed)
- `gen/image/test` → Engine::test_connection(image), toast "Berfungsi: menjawab dalam 120 md, m, OK"
- `gen/cmd/0/name` → (tree changed)
- `gen/cmd/0/program` → (tree changed)
- `gen/cmd/0/args` → (tree changed)
- `gen/cmd/0/timeout` → (tree changed)
- `gen/cmd/0/remove` → (tree changed)
- `gen/cmd/1/name` → (tree changed)
- `gen/cmd/1/program` → (tree changed)
- `gen/cmd/1/args` → (tree changed)
- `gen/cmd/1/timeout` → (tree changed)
- `gen/cmd/1/remove` → (tree changed)
- `gen/cmd/add` → (tree changed)
- `gen/cmd/test` → Engine::test_connection(commands), toast "Berfungsi: menjawab dalam 120 md, m, OK"
- `gen/model/0/auto` → Engine::pin_model(qwen2.5, auto), Engine::generate_models
- `gen/model/0/kit` → Engine::pin_model(qwen2.5, kit), Engine::generate_models
- `gen/model/0/compose` → Engine::pin_model(qwen2.5, compose), Engine::generate_models
- `gen/model/0/free` → Engine::pin_model(qwen2.5, free), Engine::generate_models
- `gen/calibrate` → Engine::calibrate, Engine::generate_models
- `gen/field/genMaxTokens` → (tree changed)
- `gen/field/contextTokens` → (tree changed)
- `gen/field/turnTokens` → (tree changed)
- `gen/field/planModel` → (tree changed)
- `gen/field/sceneModel` → (tree changed)
- `gen/field/judgeModel` → (tree changed)

## `generate-no-ai`

- `shell/menu/file` → (tree changed)
- `shell/menu/edit` → (tree changed)
- `shell/menu/view` → (tree changed)
- `shell/menu/window` → (tree changed)
- `shell/menu/help` → (tree changed)
- `shell/rail/home` → toast "Memuat opsi impor / Belum ada video Tempel tautan atau pilih berkas untuk membuat klip pertama Anda."
- `shell/rail/discover` → Engine::candidates(), toast "Belum ada kandidat. Jalankan pencarian, tren, kanal, atau Temukan otomatis di atas."
- `shell/rail/generate` → Engine::settings, Engine::generate_status, Engine::readiness
- `shell/rail/learning` → Engine::feedback, Engine::weights, Engine::videos, toast "0 dari 5 hasil tercatat"
- `shell/rail/settings` → Engine::settings
- `generate/open-settings` → Engine::settings

## `generate`

- `shell/menu/file` → (tree changed)
- `shell/menu/edit` → (tree changed)
- `shell/menu/view` → (tree changed)
- `shell/menu/window` → (tree changed)
- `shell/menu/help` → (tree changed)
- `shell/rail/home` → toast "Memuat opsi impor / Belum ada video Tempel tautan atau pilih berkas untuk membuat klip pertama Anda."
- `shell/rail/discover` → Engine::candidates(), toast "Belum ada kandidat. Jalankan pencarian, tren, kanal, atau Temukan otomatis di atas."
- `shell/rail/generate` → Engine::settings, Engine::generate_status, Engine::readiness, Engine::GET /api/generate/projects, Engine::GET /api/generate/projects/p1, Engine::GET /api/generate/recipes
- `shell/rail/learning` → Engine::feedback, Engine::weights, Engine::videos, toast "0 dari 5 hasil tercatat"
- `shell/rail/settings` → Engine::settings
- `generate/nav/projects` → (tree changed)
- `generate/nav/recipes` → Engine::GET /api/generate/recipes, Engine::GET /api/generate/steps
- `generate/nav/kit` → Engine::GET /api/generate/kit
- `generate/video/p1` → Engine::GET /api/generate/projects/p1
- `generate/video/p2` → Engine::GET /api/generate/projects/p2
- `generate/new` → (tree changed)
- `generate/step/brief` → (tree changed)
- `generate/step/ideas` → Engine::GET /api/generate/ideas
- `generate/step/facts` → (tree changed)
- `generate/step/stories` → (tree changed)
- `generate/step/plan` → (tree changed)
- `generate/step/build` → Engine::GET /api/generate/projects/p1/events?limit=100
- `generate/step/verdict` → toast "Belum ada versi jadi. Bangun draf dulu."

## `generate-flow`

- `shell/menu/file` → (tree changed)
- `shell/menu/edit` → (tree changed)
- `shell/menu/view` → (tree changed)
- `shell/menu/window` → (tree changed)
- `shell/menu/help` → (tree changed)
- `shell/rail/home` → toast "Memuat opsi impor / Belum ada video Tempel tautan atau pilih berkas untuk membuat klip pertama Anda."
- `shell/rail/discover` → Engine::candidates(), toast "Belum ada kandidat. Jalankan pencarian, tren, kanal, atau Temukan otomatis di atas."
- `shell/rail/generate` → Engine::settings, Engine::generate_status, Engine::readiness, Engine::GET /api/generate/projects, Engine::GET /api/generate/projects/p1, Engine::GET /api/generate/recipes
- `shell/rail/learning` → Engine::feedback, Engine::weights, Engine::videos, toast "0 dari 5 hasil tercatat"
- `shell/rail/settings` → Engine::settings
- `generate/nav/projects` → (tree changed)
- `generate/nav/recipes` → Engine::GET /api/generate/recipes, Engine::GET /api/generate/steps
- `generate/nav/kit` → Engine::GET /api/generate/kit
- `generate/new` → (tree changed)

## `learning`

- `shell/menu/file` → (tree changed)
- `shell/menu/edit` → (tree changed)
- `shell/menu/view` → (tree changed)
- `shell/menu/window` → (tree changed)
- `shell/menu/help` → (tree changed)
- `shell/rail/home` → toast "Memuat opsi impor"
- `shell/rail/discover` → Engine::candidates(), toast "Belum ada kandidat. Jalankan pencarian, tren, kanal, atau Temukan otomatis di atas."
- `shell/rail/generate` → Engine::settings
- `shell/rail/learning` → Engine::feedback, Engine::weights, Engine::videos, Engine::clips(v1)
- `shell/rail/settings` → Engine::settings
- `learning/log/c1` → (tree changed)

## `discover`

- `shell/menu/file` → (tree changed)
- `shell/menu/edit` → (tree changed)
- `shell/menu/view` → (tree changed)
- `shell/menu/window` → (tree changed)
- `shell/menu/help` → (tree changed)
- `shell/rail/home` → toast "Memuat opsi impor / Belum ada video Tempel tautan atau pilih berkas untuk membuat klip pertama Anda."
- `shell/rail/discover` → Engine::candidates()
- `shell/rail/generate` → Engine::settings
- `shell/rail/learning` → Engine::feedback, Engine::weights, Engine::videos, toast "0 dari 5 hasil tercatat"
- `shell/rail/settings` → Engine::settings
- `discover/mode/auto` → (tree changed)
- `discover/mode/search` → (tree changed)
- `discover/mode/trending` → (tree changed)
- `discover/mode/channel` → (tree changed)
- `discover/goal` → (tree changed)
- `discover/run` → Engine::discover_auto()
- `discover/filter/all` → Engine::candidates()
- `discover/filter/new` → Engine::candidates(NEW)
- `discover/filter/queued` → Engine::candidates(QUEUED)
- `discover/filter/imported` → Engine::candidates(IMPORTED)
- `discover/filter/skipped` → Engine::candidates(SKIPPED)
- `discover/c/d1/pick` → (tree changed)
- `discover/c/d1/more` → (tree changed)
- `discover/c/d1/yt` → (tree changed)
- `discover/c/d1/import` → Engine::queue_candidates(d1), Engine::drain_queue, Engine::candidates(), toast ""Kenapa orang menunda mulai" dimulai. Ikuti di Beranda."
- `discover/c/d1/status` → Engine::set_candidate_status(d1, SKIPPED), Engine::candidates()
- `discover/c/d2/yt` → (tree changed)
- `discover/c/d3/yt` → (tree changed)
- `discover/c/d3/status` → Engine::set_candidate_status(d3, NEW), Engine::candidates()
- `discover/drain` → Engine::drain_queue, Engine::candidates(), toast "0 pekerjaan dimulai."

## `publish`

- `shell/menu/file` → (tree changed)
- `shell/menu/edit` → (tree changed)
- `shell/menu/view` → (tree changed)
- `shell/menu/window` → (tree changed)
- `shell/menu/help` → (tree changed)
- `shell/rail/home` → toast "Memuat opsi impor / Belum ada video Tempel tautan atau pilih berkas untuk membuat klip pertama Anda."
- `shell/rail/discover` → Engine::candidates(), toast "Belum ada kandidat. Jalankan pencarian, tren, kanal, atau Temukan otomatis di atas."
- `shell/rail/generate` → Engine::settings
- `shell/rail/learning` → Engine::feedback, Engine::weights, Engine::videos, toast "0 dari 5 hasil tercatat"
- `shell/rail/settings` → Engine::settings
- `publish/tab/0` → (tree changed)
- `publish/tab/1` → toast "Catatan: shortened to the 5000-character limit"
- `publish/0/text` → (tree changed)
- `publish/0/direct` → (tree changed)
- `publish/0/draft` → (tree changed)
- `publish/0/privacy/0` → (tree changed)
- `publish/0/privacy/1` → (tree changed)
- `publish/schedule/day` → (tree changed)
- `publish/schedule/month` → (tree changed)
- `publish/schedule/year` → (tree changed)
- `publish/schedule/hour` → (tree changed)
- `publish/schedule/minute` → (tree changed)
- `publish/schedule/now` → (tree changed)
- `publish/account/tt` → (tree changed)
- `publish/account/yt` → (tree changed)
- `publish/write` → Engine::publish_draft(c1, tt,yt)
- `publish/post/p1/refresh` → Engine::refresh_post(p1)
- `publish/post/p1/retry` → Engine::retry_post(p1)

## Explicit no-ops

| Control | Reason |
|---|---|
| `palette-open/palette/input` | the command palette autofocuses this field; tapping an already-focused field moves nothing |

377 controls, 0 disabled, 0 dead. Wall time 109.1s.
