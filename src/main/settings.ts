import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_SETTINGS, sanitizeSettings } from './settings-schema';

/** Настройки снега: хранятся в settings.json в папке данных приложения */
export class SettingsStore {
  private readonly file = path.join(app.getPath('userData'), 'settings.json');
  private readonly listeners: Array<(settings: SnowSettings) => void> = [];
  private settings: SnowSettings;

  constructor() {
    this.settings = this.load();
  }

  get value(): SnowSettings {
    return this.settings;
  }

  onChange(listener: (settings: SnowSettings) => void): void {
    this.listeners.push(listener);
  }

  update(patch: Partial<SnowSettings>): void {
    this.settings = sanitizeSettings({ ...this.settings, ...patch });
    this.save();
    for (const listener of this.listeners) listener(this.settings);
  }

  private load(): SnowSettings {
    try {
      return sanitizeSettings(JSON.parse(fs.readFileSync(this.file, 'utf-8')));
    } catch {
      return { ...DEFAULT_SETTINGS }; // файла ещё нет или он повреждён
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.settings, null, 2));
    } catch (error) {
      console.error('Не удалось сохранить настройки:', error);
    }
  }
}
