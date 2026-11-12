import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { summarize, type Sample } from './profile-stats';

// Профилировщик включается переменной SNOW_PROFILE=1 (проще всего — npm run profile)
//   SNOW_PROFILE_INTERVAL_S — период замеров, по умолчанию 10 с
//   SNOW_PROFILE_DURATION_S — через сколько секунд завершить замер и выйти; без неё — до выхода из приложения
//   SNOW_PROFILE_OUT        — куда записать отчёт; по умолчанию profile.json в папке данных приложения
const DEFAULT_INTERVAL_S = 10;

function positiveNumber(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function takeSample(startedAt: number): Sample {
  return {
    elapsedS: Math.round((Date.now() - startedAt) / 1000),
    processes: app.getAppMetrics().map((metric) => ({
      type: metric.type,
      cpuPercent: metric.cpu.percentCPUUsage,
      memoryKb: metric.memory.workingSetSize,
    })),
  };
}

export function startProfiler(): void {
  if (!process.env.SNOW_PROFILE) return;

  const intervalS = positiveNumber(process.env.SNOW_PROFILE_INTERVAL_S) ?? DEFAULT_INTERVAL_S;
  const durationS = positiveNumber(process.env.SNOW_PROFILE_DURATION_S);
  const outPath = process.env.SNOW_PROFILE_OUT ?? path.join(app.getPath('userData'), 'profile.json');
  const startedAt = Date.now();
  const samples: Sample[] = [];

  // percentCPUUsage считается с прошлого вызова getAppMetrics, поэтому первый замер всегда нулевой
  // и в отчёт не попадает: он только «прогревает» счётчик.
  app.getAppMetrics();

  const timer = setInterval(() => {
    samples.push(takeSample(startedAt));
    if (durationS && (Date.now() - startedAt) / 1000 >= durationS) app.quit();
  }, intervalS * 1000);

  let written = false;
  app.on('before-quit', () => {
    clearInterval(timer);
    if (written) return;
    written = true;

    const summary = summarize(samples);
    const report = {
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      intervalS,
      summary,
      samples,
    };
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(
      `Профиль: ${summary.samples} замеров за ${summary.durationS} с. ` +
        `CPU в среднем ${summary.cpuPercent.total.avg.toFixed(1)} %, ` +
        `память в среднем ${summary.memoryMb.total.avg.toFixed(0)} МБ. Отчёт: ${outPath}`,
    );
  });
}
