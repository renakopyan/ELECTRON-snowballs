import test from 'node:test';
import assert from 'node:assert/strict';
import { percentile, summarize, type Sample } from '../src/main/profile-stats';

test('перцентиль: ближайший ранг, порядок значений не важен', () => {
  assert.equal(percentile([], 95), 0);
  assert.equal(percentile([7], 95), 7);
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
});

test('сводка: пустой список замеров не роняет расчёт', () => {
  const summary = summarize([]);
  assert.equal(summary.samples, 0);
  assert.equal(summary.durationS, 0);
  assert.deepEqual(summary.cpuPercent.total, { avg: 0, p95: 0, max: 0 });
  assert.deepEqual(summary.cpuPercent.byType, {});
});

test('сводка: процессы одного типа складываются внутри замера, а замеры усредняются', () => {
  const samples: Sample[] = [
    {
      elapsedS: 10,
      processes: [
        { type: 'Browser', cpuPercent: 2, memoryKb: 100 * 1024 },
        { type: 'Tab', cpuPercent: 4, memoryKb: 50 * 1024 },
        { type: 'Tab', cpuPercent: 6, memoryKb: 50 * 1024 },
      ],
    },
    {
      elapsedS: 20,
      processes: [
        { type: 'Browser', cpuPercent: 4, memoryKb: 120 * 1024 },
        { type: 'Tab', cpuPercent: 10, memoryKb: 100 * 1024 },
      ],
    },
  ];
  const summary = summarize(samples);

  assert.equal(summary.samples, 2);
  assert.equal(summary.durationS, 20);
  // Всего по замерам: 12 и 14 %
  assert.equal(summary.cpuPercent.total.avg, 13);
  assert.equal(summary.cpuPercent.total.max, 14);
  // Два окна-оверлея в первом замере дают 10 % на тип Tab, во втором — 10 %
  assert.deepEqual(summary.cpuPercent.byType['Tab'], { avg: 10, p95: 10, max: 10 });
  assert.deepEqual(summary.cpuPercent.byType['Browser'], { avg: 3, p95: 4, max: 4 });
  // Память: 200 и 220 МБ суммарно
  assert.equal(summary.memoryMb.total.avg, 210);
  assert.equal(summary.memoryMb.total.max, 220);
});

test('сводка: тип процесса, которого не было в замере, считается нулём', () => {
  const samples: Sample[] = [
    { elapsedS: 10, processes: [{ type: 'GPU', cpuPercent: 8, memoryKb: 1024 }] },
    { elapsedS: 20, processes: [] },
  ];
  const gpu = summarize(samples).cpuPercent.byType['GPU'];
  assert.deepEqual(gpu, { avg: 4, p95: 8, max: 8 });
});
