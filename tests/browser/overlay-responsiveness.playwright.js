// Run against the existing Vite server in a separate playwright-cli session:
// playwright-cli -s=overlays-mobile run-code --filename=tests/browser/overlay-responsiveness.playwright.js
async page => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:3000');
  await page.evaluate(() => localStorage.setItem('wireon_auth_intro_seen', '1'));
  await page.reload();
  await page.getByRole('navigation', { name: 'Основная навигация' }).waitFor();

  // Vite adds timestamps to imports during concurrent development. Reuse the
  // modules loaded by the application, otherwise a second store gets created.
  await page.evaluate(async () => {
    const module = async name => {
      const resources = performance.getEntriesByType('resource');
      const entry = resources.find(item => new URL(item.name).pathname === `/src/store/${name}.ts`);
      return import(entry?.name ?? `/src/store/${name}.ts`);
    };
    const { useGroupListenStore } = await module('useGroupListenStore');
    const { useUIStore } = await module('useUIStore');
    const { useLibraryStore } = await module('useLibraryStore');
    window.overlayTestStores = { useGroupListenStore, useUIStore, useLibraryStore };
    useGroupListenStore.setState({
      isModalOpen: true, isConnected: true, roomId: 'ABC123', isHost: true,
      connectionStatus: 'local', connectionError: 'error'.repeat(60),
      participants: [{ id: 'host', username: 'A'.repeat(100), isHost: true }],
      chatMessages: [{ id: 'message', senderName: 'B'.repeat(80), text: 'C'.repeat(300), timestamp: 1 }]
    });
  });
  await page.getByTestId('group-listen-chat-toggle').click();

  const results = [];
  const measure = async testId => {
    const result = await page.getByTestId(testId).evaluate(dialog => {
      const rect = dialog.getBoundingClientRect();
      const overflowing = [...dialog.querySelectorAll('*')].filter(el => {
        const style = getComputedStyle(el);
        return el.scrollWidth > el.clientWidth + 1 && style.textOverflow !== 'ellipsis'
          && !['INPUT', 'SVG', 'PATH'].includes(el.tagName.toUpperCase());
      }).map(el => ({ tag: el.tagName, testId: el.dataset.testid, width: el.clientWidth, scroll: el.scrollWidth }));
      return { viewport: `${innerWidth}x${innerHeight}`, left: rect.left, right: rect.right,
        top: rect.top, bottom: rect.bottom, overflowing };
    });
    const viewport = page.viewportSize();
    if (result.left < -1 || result.right > viewport.width + 1 || result.top < -1
      || result.bottom > viewport.height + 1 || result.overflowing.length) {
      throw new Error(`${testId}: ${JSON.stringify(result)}`);
    }
    results.push({ testId, ...result });
  };

  for (const [width, height] of [[320, 568], [360, 640], [390, 844], [430, 932], [640, 360]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(250);
    await measure('group-listen-modal');
    await page.getByTestId('group-listen-chat-input').fill('message');
    await page.getByTestId('group-listen-send-chat-btn').scrollIntoViewIfNeeded();
    if (!await page.getByTestId('group-listen-send-chat-btn').isVisible()) throw new Error('Chat submit inaccessible');
  }

  await page.setViewportSize({ width: 360, height: 640 });
  await page.evaluate(() => {
    const { useGroupListenStore, useUIStore, useLibraryStore } = window.overlayTestStores;
    useGroupListenStore.setState({ isModalOpen: false });
    const tracks = [1, 2].map(id => ({ id: `overlay-${id}`, source: 'youtube', originalId: `${id}`,
      title: 'Track', artist: 'Artist', duration: 200, artworkUrl: '' }));
    const playlist = (id, tracks) => ({ id, title: `Playlist ${id} ${'L'.repeat(100)}`, tracks,
      createdAt: 1, updatedAt: 1, isSynced: false });
    useLibraryStore.setState({ playlists: [playlist('source', tracks), ...Array.from({ length: 30 }, (_, i) => playlist(`target-${i}`, []))],
      addTrackToPlaylist: async () => true });
    useUIStore.setState({ activeView: 'playlist', activePlaylistId: 'source', selectedTrackIds: tracks.map(track => track.id) });
  });
  await page.getByTestId('mobile-playlist-selection-move').click();
  await page.waitForTimeout(250);
  await measure('mobile-playlist-move-sheet');
  const sheet = page.getByTestId('mobile-playlist-move-sheet');
  const scroller = sheet.locator('.wireon-sheet-content');
  const before = await scroller.evaluate(el => el.scrollTop);
  await scroller.hover();
  await page.mouse.wheel(0, 1500);
  await page.waitForTimeout(250);
  if (await scroller.evaluate(el => el.scrollTop) <= before) throw new Error('Playlist list does not scroll');
  await scroller.evaluate(el => { el.scrollTop = 0; });
  const box = await scroller.boundingBox();
  const touch = await page.context().newCDPSession(page);
  await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 60, y: box.y + box.height - 60 }] });
  for (let distance = 20; distance <= 180; distance += 20) {
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + 60, y: box.y + box.height - 60 - distance }] });
    await page.waitForTimeout(20);
  }
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(250);
  if (await scroller.evaluate(el => el.scrollTop) <= 0) throw new Error('Native touch scrolling blocked');
  await touch.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await touch.detach();
  await page.getByTestId('mobile-playlist-move-target-29').scrollIntoViewIfNeeded();
  await page.getByTestId('mobile-playlist-move-target-29').click();
  await sheet.waitFor({ state: 'detached' });

  // Landscape safe areas must constrain content while the sheet stays fixed.
  await page.setViewportSize({ width: 640, height: 360 });
  await page.evaluate(() => {
    const root = document.documentElement.style;
    root.setProperty('--safe-left', '44px'); root.setProperty('--safe-right', '44px');
    root.setProperty('--safe-top', '24px'); root.setProperty('--safe-bottom', '20px');
    window.overlayTestStores.useUIStore.setState({ selectedTrackIds: ['overlay-1'] });
  });
  await page.getByTestId('mobile-playlist-selection-move').click();
  await page.waitForTimeout(250);
  await measure('mobile-playlist-move-sheet');
  const safeRow = await page.getByTestId('mobile-playlist-move-target-0').boundingBox();
  if (safeRow.x < 44 || safeRow.x + safeRow.width > 596) throw new Error('Landscape safe area ignored');
  await page.getByTestId('mobile-playlist-move-target-29').scrollIntoViewIfNeeded();
  await page.getByTestId('mobile-playlist-move-target-29').click();

  await page.evaluate(() => window.overlayTestStores.useUIStore.setState({ selectedTrackIds: ['overlay-1'] }));
  await page.getByTestId('mobile-playlist-selection-move').click();
  await page.waitForTimeout(300);
  const header = await page.getByTestId('mobile-playlist-move-sheet').locator('h2').boundingBox();
  const swipe = await page.context().newCDPSession(page);
  await swipe.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await swipe.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: header.x + 60, y: header.y + 20 }] });
  await swipe.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: header.x + 60, y: header.y + 160 }] });
  await swipe.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.getByTestId('mobile-playlist-move-sheet').waitFor({ state: 'detached' });
  await swipe.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await swipe.detach();

  await page.evaluate(() => window.overlayTestStores.useGroupListenStore.setState({ isModalOpen: true }));
  await page.waitForTimeout(250);
  await measure('group-listen-modal');
  await page.evaluate(() => {
    window.overlayTestStores.useGroupListenStore.setState({ isModalOpen: false });
    const root = document.documentElement.style;
    for (const key of ['--safe-left', '--safe-right', '--safe-top', '--safe-bottom']) root.removeProperty(key);
  });

  // The common picker is also mounted by track rows with transforms and
  // clipping. Render that exact component inside a deliberately narrow row.
  await page.evaluate(async () => {
    const dependency = async name => {
      const entry = performance.getEntriesByType('resource').find(item => new URL(item.name).pathname.endsWith(`/${name}.js`));
      return import(entry.name);
    };
    const React = (await dependency('react')).default;
    const { createRoot } = (await dependency('react-dom_client')).default;
    const { AddToPlaylistModal } = await import('/src/components/library/AddToPlaylistModal.tsx');
    const parent = document.createElement('div');
    parent.style.cssText = 'width:120px;height:200px;transform:translate(40px,80px);overflow:hidden';
    document.body.append(parent);
    const root = createRoot(parent);
    window.overlayTestFixture = { root, parent };
    root.render(React.createElement(AddToPlaylistModal, {
      track: { id: 'fixture', source: 'youtube', title: 'T'.repeat(200), artist: 'A'.repeat(100) },
      isOpen: true, onClose: () => {},
      tracks: [{ id: 'fixture-1', title: 'First' }, { id: 'fixture-2', title: 'Second' }]
    }));
  });
  await page.getByTestId('add-to-playlist-new-btn').click();
  for (const [width, height] of [[320, 568], [360, 640], [640, 360]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(250);
    await measure('add-to-playlist-modal');
    await page.getByTestId('add-to-playlist-new-input').fill('Playlist title');
    await page.getByTestId('add-to-playlist-new-submit').scrollIntoViewIfNeeded();
  }
  await page.evaluate(() => {
    window.overlayTestFixture.root.unmount();
    window.overlayTestFixture.parent.remove();
  });

  return { passed: results.length, cases: results };
}
