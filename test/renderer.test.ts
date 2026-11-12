import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRenderer, SETTINGS, twoWindowsScene, type DriftProbe, type Renderer } from './helpers/renderer';
import { must } from './helpers/must';

function setup(settings: Partial<SnowSettings> = {}, scene: SnowScene = twoWindowsScene()): Renderer {
  const r = loadRenderer();
  r.bridge.settings({ ...SETTINGS, ...settings });
  r.bridge.scene(scene);
  return r;
}

const volume = (r: Renderer, id: string): number => r.snowfall.drifts.get(id)?.volume ?? 0;
const driftOf = (r: Renderer, id: string): DriftProbe => must(r.snowfall.drifts.get(id), `нет сугроба ${id}`);

/** Равномерно засыпать кромку снегом */
function fill(drift: DriftProbe, from: number, to: number, area = 400): void {
  for (let x = from; x < to; x += 20) drift.deposit(x, area);
}

test('снег копится на окнах и внизу экрана', () => {
  const r = setup();
  r.run(45);
  assert.ok(volume(r, 'window-1') > 2000, `на окне ${volume(r, 'window-1')}`);
  assert.ok(volume(r, 'window-2') > 2000);
  assert.ok(volume(r, 'ground') > 2000);
});

test('варежка: сметённый с верхнего окна снег падает на нижнее', () => {
  const r = setup({ intensity: 'thaw' });
  driftOf(r, 'window-1').deposit(500, 6000);
  r.run(1);
  const upper = volume(r, 'window-1');
  const lower = volume(r, 'window-2');
  r.drag(300, 700, 196);
  r.run(3);
  assert.ok(volume(r, 'window-1') < upper * 0.2, 'снег с окна сметён');
  assert.ok(volume(r, 'window-2') > lower + upper * 0.3, 'и упал на окно ниже');
});

test('закрытое окно: сугроб обрушивается на землю', () => {
  const r = setup({ intensity: 'light' });
  fill(driftOf(r, 'window-2'), 120, 880);
  const ground = volume(r, 'ground');
  const scene = twoWindowsScene();
  scene.surfaces = scene.surfaces.filter((s) => s.id !== 'window-2');
  r.bridge.scene(scene);
  r.run(5);
  assert.equal(r.snowfall.drifts.has('window-2'), false);
  assert.ok(volume(r, 'ground') > ground + 4000);
});

test('свёрнутое окно или другой рабочий стол: сугроб ждёт возвращения окна', () => {
  const r = setup({ intensity: 'light' });
  fill(driftOf(r, 'window-2'), 120, 880);
  r.run(0.5);
  const before = volume(r, 'window-2');
  assert.ok(before > 5000);
  const ground = volume(r, 'ground');

  const away = twoWindowsScene({ keep: ['window-2'] });
  away.surfaces = away.surfaces.filter((s) => s.id !== 'window-2');
  r.bridge.scene(away);
  r.run(3);
  assert.equal(r.snowfall.drifts.has('window-2'), false, 'сугроб не рисуется');
  // Снег продолжает идти, но обрушения (+5000 и больше) не было
  assert.ok(volume(r, 'ground') - ground < before * 0.3, 'и не обрушился');

  r.bridge.scene(twoWindowsScene());
  assert.ok(Math.abs(volume(r, 'window-2') - before) < 1, 'снег вернулся вместе с окном');
});

test('окно закрыли на другом рабочем столе — его снег пропадает без обрушения', () => {
  const r = setup({ intensity: 'thaw' });
  fill(driftOf(r, 'window-2'), 120, 880);
  const away = twoWindowsScene({ keep: ['window-2'] });
  away.surfaces = away.surfaces.filter((s) => s.id !== 'window-2');
  r.bridge.scene(away);
  const gone = twoWindowsScene();
  gone.surfaces = gone.surfaces.filter((s) => s.id !== 'window-2');
  r.bridge.scene(gone);
  r.bridge.scene(twoWindowsScene());
  assert.equal(volume(r, 'window-2'), 0);
});

test('оттепель: снег перестаёт идти, сугробы тают', () => {
  const r = setup({ intensity: 'thaw' });
  assert.equal(r.snowfall.flakes.length, 0);
  fill(driftOf(r, 'window-1'), 310, 690);
  r.run(0.2);
  const before = volume(r, 'window-1');
  r.run(30);
  assert.ok(volume(r, 'window-1') < before * 0.7, `${before} → ${volume(r, 'window-1')}`);
  r.run(90);
  assert.equal(volume(r, 'window-1'), 0);
});

test('после паузы сугробы подтаивают', () => {
  const r = setup({ intensity: 'light' });
  fill(driftOf(r, 'window-1'), 310, 690);
  r.run(0.2);
  const before = volume(r, 'window-1');
  r.bridge.melt(20);
  assert.ok(volume(r, 'window-1') < before * 0.8);
});

test('лопата сгребает снег в кучу, лишнее ссыпается вниз', () => {
  const r = setup({ intensity: 'thaw', tool: 'shovel' });
  const drift = driftOf(r, 'window-2');
  fill(drift, 120, 880, 250); // сугроб наполовину
  r.run(0.3);
  const before = drift.volume;
  r.snowfall.config.meltPerSecond = 0; // оттепель без таяния: снег не идёт и не тает — его легко считать
  const ground = volume(r, 'ground');
  r.drag(130, 500, 495, 3);
  r.run(3);
  const heights = Array.from(drift.heights);
  const column = (x: number): number => Math.floor((x - drift.left) / 3);
  const pile = Math.max(...heights.slice(column(480), column(620)));
  const cleared = Math.max(...heights.slice(column(150), column(440)));
  const kept = drift.volume + volume(r, 'ground') - ground;
  assert.ok(pile > 30, `куча выше обычного сугроба: ${pile.toFixed(1)}`);
  assert.ok(cleared < 3, `за лопатой чисто: ${cleared.toFixed(1)}`);
  assert.ok(kept > before * 0.9, `снег не пропал: ${before.toFixed(0)} → ${kept.toFixed(0)}`);
});

test('лопата у края окна сбрасывает снег вниз', () => {
  const r = setup({ intensity: 'thaw', tool: 'shovel' });
  const drift = driftOf(r, 'window-2');
  fill(drift, 700, 880, 500);
  r.run(0.3);
  r.bridge.settings({ ...SETTINGS, intensity: 'light', tool: 'shovel' });
  const ground = volume(r, 'ground');
  r.drag(690, 900, 495, 3);
  r.run(3);
  assert.ok(drift.volume < 500, `на окне осталось ${drift.volume.toFixed(0)}`);
  assert.ok(volume(r, 'ground') > ground + 2000, 'снег упал на землю');
});

test('снежки: скатанный шар растёт, а резкий рывок бросает его', () => {
  const r = setup({ intensity: 'thaw', tool: 'snowball' });
  const drift = driftOf(r, 'window-2');
  for (let x = 120; x < 880; x += 20) drift.deposit(x, 400);
  r.bridge.settings({ ...SETTINGS, intensity: 'light', tool: 'snowball' });
  r.run(0.3);

  r.drag(120, 420, 494, 4);
  const balls = r.snowfall.snowballs;
  assert.equal(balls.pileCount, 1, 'появился один шар');
  const rolled = balls.volume;
  assert.ok(rolled > 300, `шар собрал снег: ${rolled.toFixed(0)}`);

  // Курсор останавливается слева от шара и резко дёргается вправо — через шар
  const ballX = drift.left + must(balls.piles[0]).offset;
  r.pointer(ballX - 25, 494);
  r.pointer(ballX + 15, 494);
  assert.equal(balls.pileCount, 0, 'шар сорвался с окна');
  assert.ok(balls.flyingCount + balls.splatCount >= 1, 'и летит или уже разбился');

  r.run(3);
  assert.equal(balls.flyingCount, 0, 'снежок разбился');
});

test('снеговик: меньший шар встаёт на больший', () => {
  const r = setup({ intensity: 'thaw', tool: 'snowball' });
  const drift = driftOf(r, 'window-2');
  for (let x = 120; x < 880; x += 20) drift.deposit(x, 400);
  r.bridge.settings({ ...SETTINGS, intensity: 'light', tool: 'snowball' });
  r.run(0.3);
  r.drag(120, 500, 494, 4); // большой шар слева направо
  r.drag(880, 700, 494, -4); // маленький справа налево
  r.drag(720, 560, 494, -4); // докатываем маленький до большого
  const stacks = r.snowfall.snowballs.piles.filter((pile) => pile.areas.length >= 2);
  assert.ok(stacks.length >= 1, JSON.stringify(r.snowfall.snowballs.piles));
});

test('украшения, метель и звёздочки рисуются без ошибок', () => {
  const r = setup({ intensity: 'blizzard', wind: 'right', garland: true, frost: true });
  r.run(40);
  assert.ok(r.snowfall.frost.value > 0.5, `иней нарос: ${r.snowfall.frost.value.toFixed(2)}`);
  assert.ok((r.stats['drawImage'] ?? 0) > 1000, 'звёздочки и гирлянда рисуются');
  assert.ok((r.stats['ellipse'] ?? 0) > 0, 'лампочки гирлянды рисуются');

  r.bridge.settings({ ...SETTINGS, intensity: 'light', wind: 'calm', frost: false });
  r.run(25);
  assert.ok(r.snowfall.frost.value < 0.01, 'иней растаял');
});

test('от аккумулятора кадров вдвое меньше', () => {
  const r = setup();
  let drawn = 0;
  const original = r.snowfall.draw.bind(r.snowfall);
  r.snowfall.draw = (time: number): void => {
    drawn++;
    original(time);
  };
  r.bridge.frameRate(30);
  r.run(2);
  assert.ok(drawn >= 55 && drawn <= 65, `кадров за 2 с: ${drawn}`);
});

test('«Смести весь снег» убирает сугробы, шары и спящие сугробы', () => {
  const r = setup();
  r.run(20);
  r.bridge.clear();
  for (const drift of r.snowfall.drifts.values()) assert.equal(drift.volume, 0);
  assert.equal(r.snowfall.dormant.size, 0);
});

test('снегоуборщик: расчищает низ экрана, толкает снег и уезжает', () => {
  const r = setup({ intensity: 'thaw' });
  r.snowfall.config.meltPerSecond = 0;
  const ground = driftOf(r, 'ground');
  fill(ground, 0, 1440, 700);
  r.run(0.2);
  const before = ground.volume;
  assert.equal(r.snowfall.plow.running, false, 'сам не выезжает, пока выключен в настройках');

  r.bridge.plow(); // «Вызвать сейчас» в меню
  assert.equal(r.snowfall.plow.running, true);
  r.run(3);
  assert.ok(r.snowfall.particles.length > 0, 'отвал выбрасывает снег');
  assert.ok(ground.volume < before, 'снег убывает по ходу машины');

  r.run(14);
  assert.equal(r.snowfall.plow.running, false, 'машина уехала за край');
  assert.ok(ground.volume < before * 0.15, `внизу чисто: ${before.toFixed(0)} → ${ground.volume.toFixed(0)}`);
  assert.ok((r.stats['save'] ?? 0) > 0 && (r.stats['rotate'] ?? 0) > 0, 'машина и колёса нарисованы');
});

test('снегоуборщик выезжает сам, только когда внизу намело', () => {
  const r = setup({ intensity: 'thaw', plow: true });
  r.snowfall.config.meltPerSecond = 0;
  r.run(6);
  assert.equal(r.snowfall.plow.running, false, 'пустой низ — незачем выезжать');

  fill(driftOf(r, 'ground'), 0, 1440, 700);
  r.run(3);
  assert.equal(r.snowfall.plow.running, true);

  r.run(16);
  assert.equal(r.snowfall.plow.running, false);
  r.run(20);
  assert.equal(r.snowfall.plow.running, false, 'повторно сразу не выезжает, пока не пройдёт пауза');
});

test('снегоуборщик разбивает снеговика на своём пути', () => {
  const r = setup({ intensity: 'thaw' });
  r.snowfall.config.meltPerSecond = 0;
  r.snowfall.snowballs.piles.push({ driftId: 'ground', offset: 700, areas: [1500, 800, 400] });
  r.run(0.2);
  assert.equal(r.snowfall.snowballs.pileCount, 1);
  r.bridge.plow();
  r.run(18);
  assert.equal(r.snowfall.snowballs.pileCount, 0, 'снеговик рассыпался');
});

function snowman(r: Renderer, areas: number[] = [1500, 800, 400]): { x: number; y: number } {
  // Правее окна-1, чтобы над снеговиком ничего не мешало снежку лететь
  r.snowfall.snowballs.piles.push({ driftId: 'window-2', offset: 700, areas });
  r.run(0.2);
  return { x: 808, y: 470 }; // центр нижнего шара
}

test('над снеговиком оверлей ловит клики, рядом — пропускает сквозь себя', () => {
  const r = setup({ intensity: 'thaw' });
  const { x, y } = snowman(r);
  const lastInteractive = (): boolean | undefined => r.bridge.interactive[r.bridge.interactive.length - 1];
  r.pointer(900, 100);
  assert.notEqual(lastInteractive(), true);

  r.pointer(x, y);
  assert.equal(lastInteractive(), true);
  r.pointer(x + 200, y - 300);
  assert.equal(lastInteractive(), false);
});

test('снеговик отвечает на клик: подпрыгивает, подбрасывает голову, бросается снежком', () => {
  const r = setup({ intensity: 'thaw' });
  const { x, y } = snowman(r);
  const balls = r.snowfall.snowballs;

  for (const [index, kind] of ['hop', 'head', 'throw'].entries()) {
    balls.nextPoke = index;
    const headBefore = must(balls.piles[0]).areas[2] ?? 0;
    r.click(x, y);
    assert.equal(balls.pokeCount, 1, `${kind}: анимация пошла`);
    assert.equal(balls.piles[0]?.poke?.kind, kind);
    r.click(x, y); // пока прыгает, второй клик ничего не меняет
    assert.equal(balls.piles[0]?.poke?.kind, kind);
    if (kind === 'throw') {
      assert.equal(balls.flyingCount >= 1, true, 'снежок вылетел');
      assert.ok((balls.piles[0]?.areas[2] ?? Infinity) < headBefore, 'голова стала чуть меньше');
    }
    r.run(1.5);
    assert.equal(balls.pokeCount, 0, `${kind}: снеговик снова стоит`);
  }
  assert.equal(balls.pileCount, 1, 'снеговик цел');
});

test('клик мимо снеговика и по одиночному шару ничего не делает', () => {
  const r = setup({ intensity: 'thaw' });
  const { x, y } = snowman(r);
  r.click(x - 150, y);
  assert.equal(r.snowfall.snowballs.pokeCount, 0);

  r.snowfall.snowballs.piles.push({ driftId: 'window-2', offset: 450, areas: [900] });
  r.click(558, 470);
  assert.equal(r.snowfall.snowballs.pokeCount, 0, 'одиночный шар — ещё не снеговик');
});

function movedWindow(dx: number): SnowScene {
  const scene = twoWindowsScene();
  const win = must(scene.surfaces[0]);
  scene.surfaces[0] = {
    ...win,
    x: win.x + dx,
    visible: win.visible.map(([a, b]): [number, number] => [a + dx, b + dx]),
  };
  scene.windows[0] = { ...must(scene.windows[0]), x: must(scene.windows[0]).x + dx };
  return scene;
}

test('окно резко дёрнули — снег с него сыплется вниз', () => {
  const r = setup({ intensity: 'thaw' });
  r.snowfall.config.meltPerSecond = 0;
  const drift = driftOf(r, 'window-1');
  fill(drift, 310, 690, 300);
  r.run(0.3);
  const before = drift.volume;
  const ground = volume(r, 'ground') + volume(r, 'window-2');

  r.bridge.scene(twoWindowsScene()); // окно стоит: сцены идут каждые ~33 мс, пока его тащат
  r.run(0.05);
  r.bridge.scene(movedWindow(200)); // 200 px за ~3 кадра
  assert.ok(drift.volume < before * 0.3, `осталось ${drift.volume.toFixed(0)} из ${before.toFixed(0)}`);
  assert.ok(r.snowfall.particles.length > 5, 'снег летит вниз');

  r.run(4);
  assert.ok(volume(r, 'ground') + volume(r, 'window-2') > ground + before * 0.3, 'упал на окно ниже и на землю');
});

test('окно двигают плавно — снег лежит', () => {
  const r = setup({ intensity: 'thaw' });
  r.snowfall.config.meltPerSecond = 0;
  const drift = driftOf(r, 'window-1');
  fill(drift, 310, 690, 300);
  r.run(0.3);
  const before = drift.volume;
  for (let i = 1; i <= 20; i++) {
    r.bridge.scene(movedWindow(i * 3)); // 3 px за сцену
    r.run(0.05);
  }
  assert.ok(drift.volume > before * 0.95, `${drift.volume.toFixed(0)} из ${before.toFixed(0)}`);
});

test('очень резкий рывок роняет и снеговика', () => {
  const r = setup({ intensity: 'thaw' });
  r.snowfall.snowballs.piles.push({ driftId: 'window-1', offset: 200, areas: [1500, 800, 400] });
  r.run(0.3);
  assert.equal(r.snowfall.snowballs.pileCount, 1);
  r.bridge.scene(twoWindowsScene());
  r.run(0.05);
  r.bridge.scene(movedWindow(300));
  assert.equal(r.snowfall.snowballs.pileCount, 0);
});

test('первое появление окна и скачок после паузы снег не стряхивают', () => {
  const r = setup({ intensity: 'thaw' });
  const drift = driftOf(r, 'window-1');
  fill(drift, 310, 690, 300);
  r.run(0.3);
  const before = drift.volume;
  r.run(2); // сцена давно не приходила
  r.bridge.scene(movedWindow(400)); // окно «перескочило» (например, на другой стол)
  assert.ok(drift.volume > before * 0.95);
});
