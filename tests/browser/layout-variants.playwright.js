// Run after app-journeys in the same session to reuse the controlled fixtures.
async page => {
  const cases = [];
  for (const [width, height] of [[320, 568], [390, 844]]) {
    await page.setViewportSize({ width, height });
    for (const position of ['top', 'bottom', 'left', 'right']) {
      await page.evaluate(position => window.journey.layout.getState().update('mobile', {
        navigationPosition: position === 'left' ? 'right' : 'left', playerPosition: position, hiddenTabs: []
      }), position);
      const navOverlap = await page.getByTestId('mobile-nav').evaluate(nav => [...nav.querySelectorAll('button')].some(button => {
        const label = button.querySelector('span');
        if (getComputedStyle(label).display === 'none') return false;
        const b = button.getBoundingClientRect(), t = label.getBoundingClientRect();
        return t.left < b.left - 1 || t.right > b.right + 1;
      }));
      if (navOverlap) throw new Error(`${width}-${position}: navigation labels overlap`);
      for (const view of ['home', 'search', 'wave', 'library', 'playlist', 'artist', 'collection', 'settings']) {
        await page.evaluate(view => window.journey.ui.setState({ activeView: view, activePlaylistId: 'journey-playlist' }), view);
        await page.waitForTimeout(120);
        const result = await page.getByTestId('main-content').evaluate(main => {
          const rect = main.getBoundingClientRect();
          const overflow = [...main.querySelectorAll('*')].filter(el => {
            const style = getComputedStyle(el);
            return el.clientWidth && !['SVG', 'PATH', 'INPUT', 'CANVAS', 'IMG'].includes(el.tagName)
              && el.scrollWidth > el.clientWidth + 2 && el.getBoundingClientRect().left + el.scrollWidth > rect.right + 2
              && style.textOverflow !== 'ellipsis' && !['auto', 'scroll', 'hidden'].includes(style.overflowX);
          }).map(el => ({ tag: el.tagName, testId: el.dataset.testid, className: el.className, width: el.clientWidth, scroll: el.scrollWidth, text: el.innerText?.slice(0, 80) }));
          return { mainWidth: rect.width, mainHeight: rect.height, overflow };
        });
        if (result.overflow.length || result.mainWidth < 90 || result.mainHeight < 90) throw new Error(`${width}-${position}-${view}: ${JSON.stringify(result)}`);
        cases.push({ viewport: `${width}x${height}`, position, view });
      }
    }
  }
  await page.evaluate(() => window.journey.layout.getState().reset('mobile'));
  return { passed: cases.length, cases };
}
