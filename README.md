# Wireon Sounds

Музыкальный плеер: Windows (Electron) и Android (Capacitor). Звук берётся с
YouTube и SoundCloud, медиатека сходится между устройствами по входу через
Discord.

## Сборка

```
npm install
npm run verify          # проверки, типы и запуск собранной сборки
npm run build:win       # установщик и портативная сборка под Windows
npx cap sync android && android/gradlew assembleRelease
```

Готовые сборки — на [странице релизов](https://github.com/UnikumM/wireon1/releases).

## Настройка

Адрес и токен сервера, а также адрес брокера задаются переменными окружения —
см. `.env.example`. Без них приложение собирается и играет музыку на компьютере;
на телефоне без сервера не работают поиск, радио и синхронизация.

Ключ подписи Android и свойства подписи в репозитории не хранятся.
