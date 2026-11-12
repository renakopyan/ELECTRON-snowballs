const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSnapshot } = require('../dist/main/snapshot.js');
const { sanitizeSettings, DEFAULT_SETTINGS } = require('../dist/main/settings-schema.js');

test('строка помощника разбирается целиком', () => {
  const snapshot = parseSnapshot('{"w":[[1,10,20,300,200]],"d":[400,835,640,60],"h":[5,6]}');
  assert.deepEqual(snapshot, {
    windows: [{ id: 1, x: 10, y: 20, width: 300, height: 200 }],
    dock: { x: 400, y: 835, width: 640, height: 60 },
    hidden: [5, 6],
  });
});

test('старый формат без h и битые строки не роняют приложение', () => {
  assert.deepEqual(parseSnapshot('{"w":[],"d":null}'), { windows: [], dock: null, hidden: [] });
  assert.equal(parseSnapshot('мусор'), null);
  assert.equal(parseSnapshot('{"d":null}'), null);
  // Строки с неверным числом полей отбрасываются
  assert.equal(parseSnapshot('{"w":[[1,2,3]],"d":[1,2],"h":["x"]}').windows.length, 0);
});

test('флаг s означает, что набор окон меняется', () => {
  const snapshot = parseSnapshot('{"w":[],"d":null,"h":[],"s":1}');
  assert.equal(snapshot.settling, true);
  assert.equal('settling' in parseSnapshot('{"w":[],"d":null,"h":[]}'), false);
});

test('координаты переводятся через toDip (масштаб экрана в Windows)', () => {
  const half = (r) => ({ x: r.x / 2, y: r.y / 2, width: r.width / 2, height: r.height / 2 });
  const snapshot = parseSnapshot('{"w":[[1,100,200,600,400]],"d":null,"h":[]}', half);
  assert.deepEqual(snapshot.windows[0], { id: 1, x: 50, y: 100, width: 300, height: 200 });
});

test('настройки: неизвестные ключи и значения отбрасываются', () => {
  const settings = sanitizeSettings({ intensity: 'thaw', tool: 'shovel', garland: true, wind: 'ураган', hack: 1 });
  assert.equal(settings.intensity, 'thaw');
  assert.equal(settings.tool, 'shovel');
  assert.equal(settings.garland, true);
  assert.equal(settings.wind, DEFAULT_SETTINGS.wind);
  assert.equal('hack' in settings, false);
  assert.deepEqual(sanitizeSettings(null), DEFAULT_SETTINGS);
});
