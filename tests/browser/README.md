# Browser journeys

These checks use controlled tracks, recommendations, and a local browser database.
They check UI layout and interactions; they do not claim to verify network audio
or synchronization between physical devices. Real audio is checked separately in
the Android emulator.

Start the development server, then run in order:

```powershell
npm run dev -- --host 0.0.0.0
playwright-cli -s=wireon open http://127.0.0.1:3000
playwright-cli -s=wireon run-code --filename=tests/browser/app-journeys.playwright.js
playwright-cli -s=wireon run-code --filename=tests/browser/layout-variants.playwright.js
playwright-cli -s=wireon run-code --filename=tests/browser/overlay-responsiveness.playwright.js
```

`layout-variants` reuses the fixtures from `app-journeys`. `overlay-responsiveness`
also sends real touch events through the browser debugger to check native sheet
scrolling and dismissal. A successful result contains a `passed` count; check the
output for `### Error` as the CLI can finish with exit code zero on script errors.
