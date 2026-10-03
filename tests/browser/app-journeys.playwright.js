// Uses controlled playback/recommendation fixtures; Android playback is checked separately.
async page => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:3000/');
  await page.evaluate(() => localStorage.setItem('wireon_auth_intro_seen', '1'));
  await page.reload();
  await page.getByTestId('mobile-app').waitFor();
  await page.evaluate(async () => {
    const module = async path => {
      const entry = performance.getEntriesByType('resource').find(item => new URL(item.name).pathname === path);
      return import(entry?.name ?? path);
    };
    const [ui, player, layout, library, auth, engine, recommendations, artist, similar] = await Promise.all([
      module('/src/store/useUIStore.ts'), module('/src/store/usePlayerStore.ts'), module('/src/store/useAppLayoutStore.ts'),
      module('/src/store/useLibraryStore.ts'), module('/src/store/useAuthStore.ts'), module('/src/services/audioEngine.ts'), module('/src/services/recommendationEngine.ts'),
      module('/src/services/artistService.ts'), module('/src/services/similarArtists.ts')
    ]);
    const tracks = Array.from({ length: 12 }, (_, index) => ({ id: `journey-${index}`, originalId: `journey-${index}`,
      source: 'youtube', title: `Очень длинное название песни номер ${index}`, artist: 'Тестовый исполнитель', duration: 200, artworkUrl: '' }));
    window.journey = { ui: ui.useUIStore, player: player.usePlayerStore, layout: layout.useAppLayoutStore, tracks };
    layout.useAppLayoutStore.getState().reset('mobile');
    layout.useAppLayoutStore.getState().reset('desktop');
    engine.audioEngine.load = async () => {};
    engine.audioEngine.play = async () => {};
    recommendations.recommendationEngine.getRecommendationsForWave = async () => tracks.slice(1);
    recommendations.recommendationEngine.getTrackRadio = async () => tracks.slice(1);
    artist.artistService.getArtistProfile = async () => ({ name: 'Исполнитель с очень длинным именем', topTracks: tracks, albums: [], similarArtists: [] });
    artist.artistService.getAlbumTracks = async () => tracks;
    similar.similarArtistsService.getSimilarArtists = async () => ({ artists: [], status: 'empty' });
    auth.useAuthStore.setState({ isAuthenticated: true });
    library.useLibraryStore.setState({ history: tracks, favorites: tracks.slice(0, 3), playlists: [{ id: 'journey-playlist', title: 'Проверка плейлиста', tracks, createdAt: 1, updatedAt: 1 }] });
    player.usePlayerStore.setState({ currentTrack: tracks[0], currentTime: 47, duration: 200, currentIndex: 0,
      sourceQueue: tracks, playbackState: 'playing', isPlaying: true, isLoading: false, waveSeedKind: 'track' });
    ui.useUIStore.setState({ activeView: 'home', activePlaylistId: 'journey-playlist', selectedArtistName: 'Artist',
      activeCollection: { kind: 'album', source: 'youtube', ref: 'fixture-album', title: 'Очень длинное название альбома', subtitle: 'Artist' } });
  });
  const results = [];
  const measure = async name => {
    await page.waitForTimeout(120);
    const result = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="main-content"]');
      const rootRect = root.getBoundingClientRect();
      const overflow = [...root.querySelectorAll('*')].filter(el => {
        const style = getComputedStyle(el);
        if (!el.clientWidth || ['SVG', 'PATH', 'INPUT', 'CANVAS', 'IMG'].includes(el.tagName)) return false;
        return el.scrollWidth > el.clientWidth + 2 && el.getBoundingClientRect().left + el.scrollWidth > rootRect.right + 2
          && style.textOverflow !== 'ellipsis' && !['auto', 'scroll', 'hidden'].includes(style.overflowX);
      }).map(el => ({ tag: el.tagName, testId: el.dataset.testid, className: el.className, width: el.clientWidth, scroll: el.scrollWidth }));
      const rect = root.getBoundingClientRect();
      return { viewport: `${innerWidth}x${innerHeight}`, main: { width: rect.width, height: rect.height }, overflow };
    });
    if (result.overflow.length || result.main.width < 90 || result.main.height < 90) throw new Error(`${name}: ${JSON.stringify(result)}`);
    results.push({ name, ...result });
  };
  for (const [width, height] of [[320, 568], [390, 844], [640, 360]]) {
    await page.setViewportSize({ width, height });
    for (const view of ['home', 'search', 'library', 'foryou', 'wave', 'settings', 'playlist', 'artist', 'collection', 'offline']) {
      await page.evaluate(view => window.journey.ui.setState({ activeView: view }), view);
      await measure(view);
    }
    await page.evaluate(() => window.journey.ui.setState({ isFullscreenPlayerOpen: true }));
    const fullscreen = page.getByTestId('mobile-fullscreen-player');
    await page.getByTestId('mobile-fullscreen-tempo').scrollIntoViewIfNeeded();
    await page.getByTestId('mobile-fullscreen-tempo').click();
    await page.getByTestId('tempo-preset-1.25').click();
    await page.keyboard.press('Escape');
    await fullscreen.waitFor();
    await page.getByTestId('mobile-fullscreen-queue').click();
    await page.getByTestId('queue-drawer-close').click();
    await page.getByTestId('mobile-fullscreen-actions').click();
    await page.getByTestId('track-actions-playlists').click();
    await page.getByTestId('track-playlists-item-journey-playlist').waitFor();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.getByTestId('mobile-fullscreen-close').click();
    results.push({ name: `fullscreen-tempo-queue-playlists-${width}x${height}`, passed: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.journey.ui.setState({ activeView: 'wave' }));
  await page.getByTestId('mobile-wave-start').click();
  if (await page.evaluate(() => window.journey.player.getState().currentTime) !== 47) throw new Error('Stream reset song position');
  await page.getByTestId('mobile-wave-new-start').click();
  if (await page.evaluate(() => window.journey.player.getState().currentTrack.id) !== 'journey-1') throw new Error('New stream did not change song');
  await page.getByTestId('mobile-wave-source-row').click();
  await page.getByTestId('wave-source-chip-artist').click();
  if (await page.evaluate(() => window.journey.player.getState().waveSeedKind) !== 'artist') throw new Error('Artist source reverted');
  await page.keyboard.press('Escape');
  await page.getByTestId('mobile-wave-tune-row').click();
  await page.getByTestId('wave-genre-chip-rock').click();
  await page.keyboard.press('Escape');
  results.push({ name: 'stream-continue-new-artist-genre', passed: true });
  await page.evaluate(() => window.journey.ui.setState({ activeView: 'home' }));
  await page.getByRole('button', { name: 'Настроить главную' }).click();
  await page.getByRole('button', { name: 'Поток: выше' }).click();
  await page.getByRole('button', { name: 'Готово', exact: true }).click();
  await page.getByTestId('mobile-home-settings').click();
  await page.getByTestId('mobile-settings-row-layout').click();
  await page.getByTestId('layout-navigationPosition-left').click();
  await page.getByTestId('layout-playerPosition-right').click();
  await measure('phone-left-nav-right-player');
  await page.getByTestId('layout-navigationPosition-top').click();
  await page.getByTestId('layout-playerPosition-top').click();
  await measure('phone-top-panels');
  await page.getByRole('button', { name: 'Сбросить раскладку телефона' }).click();
  await page.getByTestId('mobile-settings-back').click();
  for (const section of ['playback', 'player', 'appearance', 'design', 'library', 'offline', 'account', 'shortcuts', 'about']) {
    const entry = page.getByTestId(`mobile-settings-row-${section}`);
    if (!await entry.count()) continue;
    await entry.click();
    await measure(`settings-${section}`);
    await page.getByTestId('mobile-settings-back').click();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const position of ['top', 'bottom', 'left', 'right']) {
    await page.evaluate(position => {
      window.journey.layout.getState().update('desktop', { navigationPosition: position, playerPosition: position });
      window.journey.ui.setState({ activeView: 'home' });
    }, position);
    await measure(`desktop-${position}`);
  }
  await page.evaluate(() => { window.journey.layout.getState().reset('desktop'); window.journey.layout.getState().reset('mobile'); });
  return { passed: results.length, cases: results };
}
