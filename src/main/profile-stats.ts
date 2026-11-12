/** Один процесс приложения в момент замера */
export interface ProcessSample {
  /** Тип процесса по классификации Electron: Browser, Tab, GPU, Utility… */
  type: string;
  /** Загрузка одного ядра в процентах: 100 — ядро занято целиком */
  cpuPercent: number;
  /** Рабочий набор памяти, КБ */
  memoryKb: number;
}

export interface Sample {
  /** Секунд от начала замера */
  elapsedS: number;
  processes: ProcessSample[];
}

export interface Stat {
  avg: number;
  p95: number;
  max: number;
}

export interface Summary {
  samples: number;
  durationS: number;
  cpuPercent: { total: Stat; byType: Record<string, Stat> };
  memoryMb: { total: Stat; byType: Record<string, Stat> };
}

const EMPTY_STAT: Stat = { avg: 0, p95: 0, max: 0 };

/** Перцентиль по методу ближайшего ранга; values не обязаны быть отсортированы */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? 0;
}

function statOf(values: number[]): Stat {
  if (values.length === 0) return EMPTY_STAT;
  const sum = values.reduce((acc, value) => acc + value, 0);
  return { avg: sum / values.length, p95: percentile(values, 95), max: Math.max(...values) };
}

/** Складывает значения процессов одного типа в каждом замере, потом считает статистику по ряду замеров */
function seriesByType(samples: Sample[], pick: (process: ProcessSample) => number): Record<string, number[]> {
  const types = new Set(samples.flatMap((sample) => sample.processes.map((process) => process.type)));
  const series: Record<string, number[]> = {};
  for (const type of types) {
    series[type] = samples.map((sample) =>
      sample.processes.filter((process) => process.type === type).reduce((acc, process) => acc + pick(process), 0),
    );
  }
  return series;
}

function summarizeMetric(samples: Sample[], pick: (process: ProcessSample) => number) {
  const byTypeSeries = seriesByType(samples, pick);
  const totalSeries = samples.map((sample) => sample.processes.reduce((acc, process) => acc + pick(process), 0));
  return {
    total: statOf(totalSeries),
    byType: Object.fromEntries(Object.entries(byTypeSeries).map(([type, values]) => [type, statOf(values)])),
  };
}

/** Сводка по замерам: среднее, 95-й перцентиль и максимум для CPU и памяти — суммарно и по типам процессов */
export function summarize(samples: Sample[]): Summary {
  const last = samples[samples.length - 1];
  return {
    samples: samples.length,
    durationS: last ? last.elapsedS : 0,
    cpuPercent: summarizeMetric(samples, (process) => process.cpuPercent),
    memoryMb: summarizeMetric(samples, (process) => process.memoryKb / 1024),
  };
}
