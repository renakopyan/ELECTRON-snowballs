import { app, screen } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { identity, parseSnapshot } from './snapshot';

const RESTART_DELAY_MS = 500;
const MIN_HEALTHY_RUN_MS = 5000;
const MAX_QUICK_FAILURES = 3;

// Все помощники печатают строки вида
//   {"w":[[id,x,y,width,height],...],"d":[x,y,width,height]|null,"h":[id,...]}
// w — видимые окна от переднего к заднему, d — Dock, h — свёрнутые окна
// и окна на других рабочих столах.

// ---------- macOS, запасной вариант: JXA-скрипт для osascript ----------
// Медленнее нативного помощника и не знает границ Dock. Сам завершается примерно
// раз в 10 минут и запускается заново: так он не копит память и не остаётся
// висеть, если приложение упало.
const JXA_POLL_SECONDS = 0.15;
const JXA_POLLS_PER_RUN = 4000;
const JXA_HIDDEN_REFRESH_EVERY = 40;
const JXA_SCRIPT = `
ObjC.import('CoreGraphics');
ObjC.import('Foundation');
var out = $.NSFileHandle.fileHandleWithStandardOutput;
var prev = '';
var prevIds = {};
var hidden = [];
function list(options) {
  return ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(options, 0))) || [];
}
for (var i = 0; i < ${JXA_POLLS_PER_RUN}; i++) {
  // 17 = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements
  var info = list(17);
  var wins = [];
  var ids = {};
  for (var j = 0; j < info.length; j++) {
    var w = info[j];
    if (w.kCGWindowLayer !== 0 || !(w.kCGWindowAlpha > 0)) continue;
    var b = w.kCGWindowBounds;
    wins.push([w.kCGWindowNumber, b.X, b.Y, b.Width, b.Height]);
    ids[w.kCGWindowNumber] = true;
  }
  var lost = Object.keys(prevIds).some(function (id) { return !ids[id]; });
  if (lost || i % ${JXA_HIDDEN_REFRESH_EVERY} === 0) {
    // 16 = все окна, кроме элементов рабочего стола — в том числе свёрнутые и на других столах
    var all = list(16);
    hidden = [];
    for (var k = 0; k < all.length; k++) {
      if (all[k].kCGWindowLayer === 0 && !ids[all[k].kCGWindowNumber]) hidden.push(all[k].kCGWindowNumber);
    }
  }
  prevIds = ids;
  var line = JSON.stringify({ w: wins, d: null, h: hidden });
  if (line !== prev) {
    prev = line;
    out.writeData($(line + '\\n').dataUsingEncoding(4));
  }
  delay(${JXA_POLL_SECONDS});
}
`;

// ---------- Windows: PowerShell + WinAPI ----------
// EnumWindows отдаёт окна от переднего к заднему. Координаты — в физических
// пикселях, в экранные точки их переводит toDip ниже.
const POWERSHELL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$source = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class SnowWindows {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lparam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hwnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT rect, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);

  public static string List(uint skipPid) {
    StringBuilder shown = new StringBuilder();
    StringBuilder hidden = new StringBuilder();
    EnumWindows(delegate (IntPtr hwnd, IntPtr lparam) {
      if (!IsWindowVisible(hwnd) || GetWindowTextLength(hwnd) == 0) return true;
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      if (pid == skipPid) return true;                          // наши собственные оверлеи
      if ((GetWindowLong(hwnd, -20) & 0x80) != 0) return true;  // WS_EX_TOOLWINDOW
      StringBuilder cls = new StringBuilder(64);
      GetClassName(hwnd, cls, 64);
      string name = cls.ToString();
      if (name == "Progman" || name == "WorkerW" || name == "Shell_TrayWnd") return true; // рабочий стол и панель задач
      int cloaked;
      bool isCloaked = DwmGetWindowAttribute(hwnd, 14, out cloaked, 4) == 0 && cloaked != 0;
      if (IsIconic(hwnd) || isCloaked) {
        // Свёрнуто или на другом виртуальном рабочем столе — сугроб надо сохранить
        if (hidden.Length > 0) hidden.Append(",");
        hidden.Append(hwnd.ToInt64());
        return true;
      }
      RECT r;
      if (DwmGetWindowAttribute(hwnd, 9, out r, 16) != 0) return true; // границы без невидимой рамки
      if (shown.Length > 0) shown.Append(",");
      shown.Append("[").Append(hwnd.ToInt64()).Append(",").Append(r.Left).Append(",").Append(r.Top)
          .Append(",").Append(r.Right - r.Left).Append(",").Append(r.Bottom - r.Top).Append("]");
      return true;
    }, IntPtr.Zero);
    return "{\\"w\\":[" + shown + "],\\"d\\":null,\\"h\\":[" + hidden + "]}";
  }
}
"@
Add-Type -TypeDefinition $source
$parentId = __PARENT_PID__
$previous = ''
$tick = 0
while ($true) {
  $tick++
  # Родитель завершился — помощнику тоже незачем жить
  if ($tick % 20 -eq 0 -and -not (Get-Process -Id $parentId -ErrorAction SilentlyContinue)) { break }
  $line = [SnowWindows]::List($parentId)
  if ($line -ne $previous) {
    $previous = $line
    [Console]::Out.WriteLine($line)
  }
  Start-Sleep -Milliseconds 100
}
`;

interface Helper {
  command: string;
  args: string[];
  /** Переводит координаты помощника в экранные точки Electron */
  toDip: (rect: ScreenRect) => ScreenRect;
}

const JXA_HELPER: Helper = {
  command: 'osascript',
  args: ['-l', 'JavaScript', '-e', JXA_SCRIPT],
  toDip: identity,
};

const EMPTY_SNAPSHOT: ScreenSnapshot = { windows: [], dock: null, hidden: [] };

function pickHelper(): Helper | null {
  if (process.platform === 'darwin') {
    // В собранном приложении бинарник лежит рядом с app.asar, а не внутри него
    const binary = path.join(app.getAppPath(), 'bin', 'window-tracker').replace('app.asar', 'app.asar.unpacked');
    if (fs.existsSync(binary)) return { command: binary, args: [], toDip: identity };
    return JXA_HELPER;
  }

  if (process.platform === 'win32') {
    const script = POWERSHELL_SCRIPT.replace('__PARENT_PID__', String(process.pid));
    return {
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      toDip: (rect) => screen.screenToDipRect(null, rect),
    };
  }

  return null;
}

/**
 * Следит за окнами других программ, чтобы снег мог ложиться на их кромки.
 * macOS — нативный помощник (или osascript, если он не собран), Windows — PowerShell.
 * Если помощник не запускается, снег копится только внизу экрана.
 */
export class WindowTracker {
  private child: ChildProcess | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private running = false;
  private quickFailures = 0;

  constructor(private readonly onChange: (snapshot: ScreenSnapshot) => void) {}

  start(): void {
    if (this.running) return;
    const helper = pickHelper();
    if (!helper) return;

    this.running = true;
    this.quickFailures = 0;
    this.spawnHelper(helper);
  }

  stop(): void {
    this.running = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.child?.kill();
    this.child = null;
  }

  private spawnHelper(helper: Helper): void {
    const startedAt = Date.now();
    const child = spawn(helper.command, helper.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    let errorOutput = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      errorOutput = (errorOutput + chunk.toString()).slice(-800);
    });

    if (child.stdout) {
      createInterface({ input: child.stdout }).on('line', (line) => {
        const snapshot = parseSnapshot(line, helper.toDip);
        if (snapshot && this.running) this.onChange(snapshot);
      });
    }

    child.on('error', (error) => {
      errorOutput = String(error);
    });
    child.on('close', () => {
      if (this.child !== child || !this.running) return;
      this.child = null;

      this.quickFailures = Date.now() - startedAt < MIN_HEALTHY_RUN_MS ? this.quickFailures + 1 : 0;
      if (this.quickFailures >= MAX_QUICK_FAILURES && process.platform === 'darwin' && helper !== JXA_HELPER) {
        console.warn('Нативный помощник не работает — перехожу на osascript.', errorOutput.trim());
        this.quickFailures = 0;
        this.spawnHelper(JXA_HELPER);
        return;
      }
      if (this.quickFailures >= MAX_QUICK_FAILURES) {
        console.error('Не удалось отследить окна — снег будет копиться только внизу экрана.', errorOutput.trim());
        this.running = false;
        this.onChange(EMPTY_SNAPSHOT);
        return;
      }
      this.restartTimer = setTimeout(() => this.spawnHelper(helper), RESTART_DELAY_MS);
    });
  }
}
