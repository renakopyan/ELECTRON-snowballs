const test = require('node:test');
const assert = require('node:assert/strict');
const { computeSurfaces, computeScene, isCoveredByFullscreenWindow } = require('../dist/main/surfaces.js');

const bounds = { x: 0, y: 0, width: 1440, height: 900 };
const macWorkArea = { x: 0, y: 25, width: 1440, height: 805 }; // меню-бар сверху, Dock снизу
const windows = [
  { id: 1, x: 300, y: 200, width: 400, height: 300 },
  { id: 2, x: 100, y: 300, width: 600, height: 400 }, // сзади, частично закрыто окном 1
];
const byId = (surfaces) => Object.fromEntries(surfaces.map((s) => [s.id, s]));

test('кромки окон: углы срезаны, закрытая часть кромки не видна', () => {
  const s = byId(computeSurfaces(bounds, macWorkArea, { windows, dock: null }, 'darwin'));
  assert.deepEqual(s['window-1'].visible, [[308, 692]]);
  assert.equal(s['window-1'].y, 200);
  // Окно 1 закрывает кромку окна 2 от x=300 до x=700
  assert.deepEqual(s['window-2'].visible, [[108, 300]]);
});

test('без границ Dock на macOS внизу только тонкая полоска', () => {
  const s = byId(computeSurfaces(bounds, macWorkArea, { windows, dock: null }, 'darwin'));
  assert.equal(s.ground.kind, 'ground-thin');
  assert.equal(s.dock, undefined);
});

test('с границами Dock снег ложится на Dock, а «земля» обходит его', () => {
  const dock = { x: 400, y: 835, width: 640, height: 60 };
  const s = byId(computeSurfaces(bounds, macWorkArea, { windows, dock }, 'darwin'));
  assert.equal(s.dock.kind, 'dock');
  assert.equal(s.dock.y, 835);
  assert.equal(s.ground.kind, 'ground');
  assert.deepEqual(s.ground.visible, [[0, 394], [1046, 1440]]);
});

test('на Windows снег ложится на панель задач', () => {
  const s = byId(computeSurfaces(bounds, { x: 0, y: 0, width: 1440, height: 860 }, { windows, dock: null }, 'win32'));
  assert.equal(s.ground.kind, 'ground');
  assert.equal(s.ground.y, 860);
});

test('мелкие окна и окна под меню-баром пропускаются', () => {
  const tiny = [
    { id: 7, x: 10, y: 400, width: 80, height: 300 },
    { id: 8, x: 10, y: 30, width: 500, height: 300 },
  ];
  const s = byId(computeSurfaces(bounds, macWorkArea, { windows: tiny, dock: null }, 'darwin'));
  assert.equal(s['window-7'], undefined);
  assert.equal(s['window-8'], undefined);
});

test('второй монитор: координаты переводятся в локальные', () => {
  const second = { x: 1440, y: 0, width: 1920, height: 1080 };
  const wins = [{ id: 4, x: 1400, y: 100, width: 500, height: 300 }];
  const s = byId(computeSurfaces(second, second, { windows: wins, dock: null }, 'darwin'));
  assert.equal(s['window-4'].x, -32);
  assert.deepEqual(s['window-4'].visible, [[0, 452]]);
});

test('сцена: скрытые окна попадают в keep, окна чужих мониторов отсекаются', () => {
  const second = { x: 1440, y: 0, width: 1920, height: 1080 };
  const wins = [...windows, { id: 9, x: 1500, y: 100, width: 400, height: 300 }];
  const scene = computeScene(bounds, macWorkArea, { windows: wins, dock: null, hidden: [5, 6] }, 'darwin');
  assert.deepEqual(scene.keep, ['window-5', 'window-6']);
  assert.equal(scene.windows.length, 2);
  assert.equal(scene.topInset, 25);

  const other = computeScene(second, second, { windows: wins, dock: null, hidden: [] }, 'darwin');
  assert.deepEqual(other.windows, [{ x: 60, y: 100, width: 400, height: 300 }]);
  assert.equal(other.topInset, 0);
});

test('полноэкранное окно распознаётся', () => {
  assert.equal(isCoveredByFullscreenWindow(bounds, windows), false);
  assert.equal(isCoveredByFullscreenWindow(bounds, [{ x: 0, y: 0, width: 1440, height: 900 }]), true);
});
