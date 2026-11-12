// Собирает нативный помощник для macOS (native/window-tracker.swift → bin/window-tracker).
// Без него приложение тоже работает — через более медленный osascript, — поэтому
// любая неудача здесь только предупреждение, а не ошибка сборки.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = path.join(root, 'native', 'window-tracker.swift');
const output = path.join(root, 'bin', 'window-tracker');

function main() {
  if (process.platform !== 'darwin') return;

  const upToDate = fs.existsSync(output) && fs.statSync(output).mtimeMs >= fs.statSync(source).mtimeMs;
  if (upToDate) return;

  // Сначала xcode-select: прямой вызов swiftc без инструментов разработчика
  // открывает системное окно с предложением их установить
  if (spawnSync('xcode-select', ['-p'], { stdio: 'ignore' }).status !== 0) {
    console.warn(
      '[snow] Инструменты разработчика Xcode не найдены — нативный помощник не собран.\n' +
        '       Снег будет работать, но сугробы станут отставать от окон.\n' +
        '       Чтобы исправить: xcode-select --install, затем снова npm run build.',
    );
    return;
  }

  fs.mkdirSync(path.dirname(output), { recursive: true });
  console.log('[snow] Собираю нативный помощник…');
  const result = spawnSync('swiftc', ['-O', source, '-o', output], { encoding: 'utf-8' });
  if (result.status !== 0) {
    console.warn('[snow] Не удалось собрать нативный помощник — будет использован osascript.');
    console.warn(result.stderr || result.error || '');
  }
}

main();
