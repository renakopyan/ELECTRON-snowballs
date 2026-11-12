// Запускает собранный нативный помощник (npm run build) и проверяет, что он говорит по протоколу.
// Без собранного помощника тесты пропускаются; в CI помощник обязателен (SNOW_REQUIRE_NATIVE=1).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { parseSnapshot } from '../src/main/snapshot';

const BINARY_NAMES: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'window-tracker',
  win32: 'window-tracker.exe',
};
const name = BINARY_NAMES[process.platform];
// Тесты компилируются в dist-test/test, бинарник лежит в bin/ в корне проекта
const binary = name ? path.join(__dirname, '..', '..', 'bin', name) : null;
const skip = binary && fs.existsSync(binary) ? false : 'нативный помощник не собран (npm run build)';

function firstLine(args: string[]): Promise<{ line: string; kill: () => void }> {
  const child = spawn(binary ?? '', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise((resolve, reject) => {
    createInterface({ input: child.stdout }).once('line', (line) => resolve({ line, kill: () => child.kill() }));
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`помощник завершился с кодом ${code}: ${stderr.trim()}`)));
  });
}

test('нативный помощник печатает снимок окон по протоколу', { skip, timeout: 15_000 }, async () => {
  const { line, kill } = await firstLine([String(process.pid)]);
  try {
    const snapshot = parseSnapshot(line);
    assert.ok(snapshot, `строка не по протоколу: ${line}`);
    for (const window of snapshot.windows) {
      assert.ok(Number.isInteger(window.id), `id окна — целое число: ${window.id}`);
      assert.ok(window.width > 0 && window.height > 0, `у окна положительный размер: ${JSON.stringify(window)}`);
    }
    for (const id of snapshot.hidden) assert.ok(Number.isInteger(id), `id скрытого окна — целое число: ${id}`);
  } finally {
    kill();
  }
});

test(
  'помощник для Windows отказывается работать без PID родителя',
  { skip: process.platform === 'win32' ? skip : 'только Windows', timeout: 15_000 },
  async () => {
    const run = (args: string[]): Promise<number | null> =>
      new Promise((resolve, reject) => {
        const child = spawn(binary ?? '', args, { stdio: 'ignore', windowsHide: true });
        child.once('error', reject);
        child.once('exit', resolve);
      });
    assert.equal(await run([]), 2);
    assert.equal(await run(['не-число']), 2);
  },
);
