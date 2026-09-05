export const openScenario = `(async () => {
  const baseline = location.pathname === '/baseline';
  const module = await import(baseline
    ? '/node_modules/ghostty-web/dist/ghostty-web.js'
    : '/dist/xterm/terminal.js');
  if (baseline) await module.init();
  const terminal = new module.Terminal({cols: 80, rows: 24, cursorBlink: false,
    fontFamily: 'monospace', fontSize: 14, theme: {foreground: '#ff0000', background: '#000000'}});
  globalThis.fixture = {terminal, module, data: [], resizes: [], baseline};
  terminal.onData(data => globalThis.fixture.data.push(data));
  terminal.onResize(size => globalThis.fixture.resizes.push(size));
  terminal.open(document.querySelector('main'));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('write callback timed out')), 10000);
    terminal.write('replacement-ready', () => { clearTimeout(timeout); resolve(); });
  });
  terminal.focus();
  return {cols: terminal.cols, rows: terminal.rows};
})()`

export const bufferScenario = `(() => {
  const buffer = globalThis.fixture.terminal.buffer.active;
  const line = buffer.getLine(0);
  return {text: line?.translateToString(true), cell: line?.getCell(0)?.getChars(),
    cursorX: buffer.cursorX, cursorY: buffer.cursorY};
})()`

export const fitScenario = `(() => {
  const {terminal, module} = globalThis.fixture;
  if (!module.FitAddon) throw new Error('No FitAddon export; explicit fitting migration required');
  const addon = new module.FitAddon();
  terminal.loadAddon(addon);
  addon.fit();
  const proposed = addon.proposeDimensions();
  addon.dispose();
  if (!proposed || proposed.cols !== terminal.cols || proposed.rows !== terminal.rows ||
      terminal.cols <= 0 || terminal.rows <= 0) throw new Error('Fit dimensions differ');
  return {proposed, cols: terminal.cols, rows: terminal.rows};
})()`

export const linksScenario = `(() => {
  const {terminal} = globalThis.fixture;
  const registration = terminal.registerLinkProvider({provideLinks(y, callback) {
    callback([{range: {start: {x: 1, y}, end: {x: 17, y}}, text: 'replacement-ready',
      activate() { globalThis.fixture.activated = true; }}]);
  }});
  globalThis.fixture.linkRegistration = registration;
  return {disposable: typeof registration?.dispose === 'function'};
})()`
