# Wireon — шпаргалка для агента

Музыкальный плеер: Windows/Linux (Electron) и Android (Capacitor). Звук с YouTube и SoundCloud,
медиатека синхронизируется между устройствами через свой сервер (`server/wireon_music`).
Владелец пишет по-русски и коротко; отвечай так же, без длинных инструкций — делай сам.

## Где что лежит

- `src/` — интерфейс (React + zustand): `components/` по экранам, `store/` — состояние,
  `services/` — вся логика (плеер `audioEngine.ts`, поиск источников `streamResolver.ts`,
  синхронизация `cloudSync.ts`/`librarySignal.ts`, сервер `nativeBridge.ts`, Android-обновления
  `androidUpdater.ts`), `data/changelog.ts` — «Что нового», `utils/appInfo.ts` — версия.
- `electron/` — главный процесс ПК: `main.ts`, `updater.ts` (автообновление), `ytdlp*.ts`.
- `android/` — Capacitor-проект; версия в `android/app/build.gradle` (versionName/versionCode).
- `server/` — Python-сервер музыки (`wireon_music/`), тесты `server/tests`, деплой `server/deploy.ps1`.
- `tests/unit` — vitest; `scripts/` — сборка, проверки, `release-prepare.mjs`.
- Подробности: `RELEASE.md` (выпуск), `DESIGN_SYSTEM.md` (вид), `.env.example` (переменные).
- Идеи на потом (разборы конкурентов и планы): `docs/ideas/`.

## Проверки — запускай точечно, чтобы не жечь лимиты

- Один тест: `npx vitest run tests/unit/<файл>`; типы: `npm run typecheck:all`.
- Полный `npm run verify` (типы, тесты, сборка, запуск) — только перед выпуском.
- Сервер: `cd server && python -m pytest -q`.
- Большие файлы не читай целиком: сначала поиск (grep/Grep), потом нужный кусок.

## Ключи — в переменных окружения

- Токен GitHub и ключ от сервера (дедика) уже лежат в переменных окружения этой машины.
  Смотри только **имена**: PowerShell `Get-ChildItem env: | Select-Object Name`, bash `env | cut -d= -f1`.
- Значения никогда не печатай, не пиши в файлы, коммиты и чат — только передавай в команды
  (`$env:GH_TOKEN`, `$env:PTERODACTYL_KEY` и т.п.).
- `gh` берёт токен из `GH_TOKEN`/`GITHUB_TOKEN` сам. Если токен в переменной с другим именем —
  `$env:GH_TOKEN = $env:<ИМЯ>` в этой же сессии.

## Выпуск обновления

1. `node scripts/release-prepare.mjs patch` (или `minor`/`1.2.3`; `--skip-verify`, если нет времени
   на полную проверку) — поднимает версию в package.json, appInfo.ts, build.gradle.
   Допиши запись в `src/data/changelog.ts` и текст `.github/release-notes/<версия>.md`.
2. Коммит, пуш в `main` (или PR и слияние).
3. `gh workflow run release.yml -R UnikumM/wireon1 -f publish=true`, затем `gh run watch`.
   Серверы GitHub сами собирают exe, AppImage и подписанный APK и публикуют релиз, только если
   на месте все 6 файлов. Секреты (ключ Android, адрес и токен сервера) уже заведены в репозитории.
4. Упало — `gh run view --log-failed`, чини причину, запускай снова. Установленные копии
   обновятся сами.

Ключ подписи Android (новый с 3.0.0) — копия в `OneDrive\Wireon-keys`. Не терять и не менять:
APK с другим ключом не встаёт поверх установленного.

## Сервер (дедик)

- Деплой: `server/deploy.ps1` (Pterodactyl, панель `panel.wireon.pro`); берёт `PTERODACTYL_KEY`,
  `PTERODACTYL_SERVER_ID`, `WIREON_API_TOKEN` из окружения. Заливает файлы, но **не перезапускает**:
  перезапуск — простой музыки и VPN, спроси владельца перед ним.
- Токен сервера (`WIREON_API_TOKEN`) должен совпадать с секретом `VITE_WIREON_SERVER_TOKEN`,
  иначе в новых сборках перестанет работать синхронизация.

## Правила

- Коммиты по-русски, коротко, в стиле `fix(плеер): …` / `feat(…): …`.
- Без проверок не пушить; ломающее синхронизацию или обновление — не выпускать.
- Публичный релиз — это то, что сразу прилетит всем пользователям: перед `publish=true` прогони тесты.
