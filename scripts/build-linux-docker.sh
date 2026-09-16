#!/usr/bin/env bash
#
# Сборка AppImage в контейнере.
#
# Запуск с хоста (Windows, Git Bash):
#
#   MSYS_NO_PATHCONV=1 docker run --rm \
#     -e WIREON_GH_OWNER=UnikumM -e WIREON_GH_REPO=wireon1 \
#     -v "C:/Users/rober/Desktop/VireonMusic:/src:ro" \
#     -v "C:/Users/rober/Desktop/VireonMusic/release:/out" \
#     electronuserland/builder:latest bash /src/scripts/build-linux-docker.sh
#
# Две детали, каждая из которых уже стоила сборки:
#
#   • `/src` подключён **только на чтение**, а дерево копируется внутрь. Без
#     этого `npm ci` в контейнере переписывает node_modules и package.json
#     прямо на хосте — один раз он так стёр скрипты сборки.
#
#   • `MSYS_NO_PATHCONV=1` обязателен: Git Bash переписывает `/src/...` в
#     `C:/Program Files/Git/...`, и контейнер не находит файл.
#
#   • канал обновлений передаётся переменными `WIREON_GH_OWNER`/`WIREON_GH_REPO`.
#     Без них `electron-builder.cjs` берёт его из `git remote`, а `.git` в
#     контейнер не копируется — и сборка выходила без `app-update.yml`, то есть
#     без автообновления вовсе. Именно это и было с AppImage до 2.1.1.
set -e

mkdir -p /work
cd /src
tar -c --exclude=node_modules --exclude=release --exclude=dist --exclude=dist-electron \
    --exclude=android --exclude=.git . | (cd /work && tar -x)

cd /work
npm ci --no-audit --no-fund
npm run build:linux

# Проверка на месте, а не после выкладки: сборка без этого файла обновляться не
# умеет, и узнать об этом можно было только по жалобе.
if [ ! -f release/linux-unpacked/resources/app-update.yml ]; then
  echo "ОШИБКА: в сборке нет app-update.yml — автообновления не будет." >&2
  echo "Передайте WIREON_GH_OWNER и WIREON_GH_REPO в docker run." >&2
  exit 1
fi

mkdir -p /out
cp -v release/*.AppImage /out/
# Манифест канала: без него обновляться не от чего.
cp -v release/latest-linux.yml /out/
