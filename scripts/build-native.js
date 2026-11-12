const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const required = process.env.SNOW_REQUIRE_NATIVE === '1';

function fail(message, details = '') {
  if (required) {
    console.error(`[snow] ${message}`);
    if (details) console.error(details);
    process.exit(1);
  }
  console.warn(`[snow] ${message}`);
  if (details) console.warn(details);
}

function isUpToDate(source, output) {
  return fs.existsSync(output) && fs.statSync(output).mtimeMs >= fs.statSync(source).mtimeMs;
}

function buildMac() {
  const source = path.join(root, 'native', 'window-tracker.swift');
  const output = path.join(root, 'bin', 'window-tracker');
  if (isUpToDate(source, output)) return;

  // Сначала xcode-select: прямой вызов swiftc без инструментов разработчика
  // открывает системное окно с предложением их установить
  if (spawnSync('xcode-select', ['-p'], { stdio: 'ignore' }).status !== 0) {
    fail(
      'Инструменты разработчика Xcode не найдены — нативный помощник не собран.\n' +
        '       Снег будет работать, но сугробы станут отставать от окон.\n' +
        '       Чтобы исправить: xcode-select --install, затем снова npm run build.',
    );
    return;
  }

  fs.mkdirSync(path.dirname(output), { recursive: true });
  console.log('[snow] Собираю нативный помощник для macOS…');
  const result = spawnSync('swiftc', ['-O', source, '-o', output], { encoding: 'utf-8' });
  if (result.status !== 0) {
    fail(
      'Не удалось собрать нативный помощник — будет использован osascript.',
      result.stderr || String(result.error ?? ''),
    );
  }
}

function buildWindows() {
  const source = path.join(root, 'native', 'window-tracker-win.c');
  const output = path.join(root, 'bin', 'window-tracker.exe');
  if (isUpToDate(source, output)) return;

  fs.mkdirSync(path.dirname(output), { recursive: true });
  const objectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snow-native-'));
  const libs = ['-luser32', '-ldwmapi'];
  // Пробуем по очереди: первый найденный компилятор и собирает
  const compilers = [
    { name: 'gcc (MinGW)', command: 'gcc', args: ['-O2', '-s', '-Wall', '-Wextra', source, '-o', output, ...libs] },
    { name: 'clang', command: 'clang', args: ['-O2', '-Wall', '-Wextra', source, '-o', output, ...libs] },
    {
      name: 'cl (Visual Studio)',
      command: 'cl',
      args: [
        '/nologo',
        '/O2',
        '/W3',
        source,
        `/Fe${output}`,
        `/Fo${objectDir}${path.sep}`,
        '/link',
        'user32.lib',
        'dwmapi.lib',
      ],
    },
  ];

  try {
    for (const compiler of compilers) {
      const result = spawnSync(compiler.command, compiler.args, { encoding: 'utf-8' });
      if (result.error) continue; // компилятора нет в PATH — пробуем следующий
      if (result.status === 0) {
        console.log(`[snow] Нативный помощник для Windows собран: ${compiler.name}`);
        return;
      }
      fail(
        `Не удалось собрать нативный помощник (${compiler.name}) — будет использован PowerShell.`,
        `${result.stdout ?? ''}${result.stderr ?? ''}`,
      );
      return;
    }
    fail(
      'Не найден компилятор C (gcc из MinGW, clang или cl из Visual Studio) — нативный помощник не собран.\n' +
        '       Снег будет работать через PowerShell, но сугробы станут отставать от окон.',
    );
  } finally {
    fs.rmSync(objectDir, { recursive: true, force: true });
  }
}

if (process.platform === 'darwin') buildMac();
else if (process.platform === 'win32') buildWindows();
