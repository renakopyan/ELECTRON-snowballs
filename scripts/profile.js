// Запускает Snow с включённым профилировщиком: npm run profile -- --minutes=60
// Без --minutes замер идёт до выхода из приложения. Отчёт — profile.json в папке данных приложения
// (путь печатается при выходе). Подробности и порядок замера — в README, раздел «Профилирование».

const { spawn } = require('node:child_process');
const path = require('node:path');
const electron = require('electron'); // при запросе из Node отдаёт путь к исполняемому файлу Electron

const minutesArg = process.argv.find((arg) => arg.startsWith('--minutes='));
const minutes = minutesArg ? Number(minutesArg.split('=')[1]) : null;
if (minutesArg && !(minutes > 0)) {
  console.error('Укажите положительное число минут: --minutes=60');
  process.exit(1);
}

const env = { ...process.env, SNOW_PROFILE: '1' };
if (minutes) env.SNOW_PROFILE_DURATION_S = String(minutes * 60);

const child = spawn(electron, ['.'], { cwd: path.join(__dirname, '..'), env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
