// Описание настроек без зависимостей от Electron — чтобы его можно было тестировать

export const DEFAULT_SETTINGS: SnowSettings = {
  intensity: 'steady',
  wind: 'gusty',
  drifts: true,
  pileSpeed: 'normal',
  tool: 'mitten',
  frost: true,
  garland: false,
  plow: true,
  hideInFullscreen: true,
};

const ALLOWED_VALUES: { [K in keyof SnowSettings]: ReadonlyArray<SnowSettings[K]> } = {
  intensity: ['light', 'steady', 'blizzard', 'thaw'],
  wind: ['calm', 'gusty', 'left', 'right'],
  drifts: [true, false],
  pileSpeed: ['slow', 'normal', 'fast'],
  tool: ['mitten', 'shovel', 'snowball'],
  frost: [true, false],
  garland: [true, false],
  plow: [true, false],
  hideInFullscreen: [true, false],
};

/** Берёт только известные ключи с допустимыми значениями; остальное — по умолчанию */
export function sanitizeSettings(raw: unknown): SnowSettings {
  const result: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  if (typeof raw === 'object' && raw !== null) {
    for (const [key, allowed] of Object.entries(ALLOWED_VALUES)) {
      const value = (raw as Record<string, unknown>)[key];
      if ((allowed as readonly unknown[]).includes(value)) result[key] = value;
    }
  }
  return result as unknown as SnowSettings;
}
