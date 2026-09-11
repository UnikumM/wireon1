#!/usr/bin/env bash
#
# Сборка AppImage в контейнере.
#
# Запуск с хоста (Windows, Git Bash):
#
#   MSYS_NO_PATHCONV=1 docker run --rm \
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
# Автообновление в такой сборке выключено: канал берётся из `git remote`, а
# `.git` в контейнер не копируется. Для релизной сборки с автообновлением
# используйте `npm run release:linux` на настоящей Linux-машине.
set -e

mkdir -p /work
cd /src
tar -c --exclude=node_modules --exclude=release --exclude=dist --exclude=dist-electron \
    --exclude=android --exclude=.git . | (cd /work && tar -x)

cd /work
npm ci --no-audit --no-fund
npm run build:linux

mkdir -p /out
cp -v release/*.AppImage /out/
