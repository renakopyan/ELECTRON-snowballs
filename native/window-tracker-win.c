#define WIN32_LEAN_AND_MEAN
#define __USE_MINGW_ANSI_STDIO 1 // %lld в printf и в старом msvcrt

#include <windows.h>
#include <dwmapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define POLL_MS 33

#ifndef DWMWA_EXTENDED_FRAME_BOUNDS
#define DWMWA_EXTENDED_FRAME_BOUNDS 9
#endif
#ifndef DWMWA_CLOAKED
#define DWMWA_CLOAKED 14
#endif

typedef struct {
  char *data;
  size_t len;
  size_t cap;
} Buffer;

static void buffer_append(Buffer *buffer, const char *text) {
  size_t length = strlen(text);
  if (buffer->len + length + 1 > buffer->cap) {
    size_t cap = buffer->cap ? buffer->cap : 1024;
    while (buffer->len + length + 1 > cap) cap *= 2;
    char *data = realloc(buffer->data, cap);
    if (!data) exit(1);
    buffer->data = data;
    buffer->cap = cap;
  }
  memcpy(buffer->data + buffer->len, text, length + 1);
  buffer->len += length;
}

static void buffer_clear(Buffer *buffer) {
  buffer->len = 0;
  buffer_append(buffer, "");
}

typedef struct {
  DWORD skip_pid;
  Buffer shown;
  Buffer hidden;
} Scan;

/// Рабочий стол и панели задач: на них снег ложится по рабочей области экрана, а не как на окно
static BOOL is_shell_window(HWND hwnd) {
  char name[64];
  if (!GetClassNameA(hwnd, name, (int)sizeof name)) return FALSE;
  return strcmp(name, "Progman") == 0 || strcmp(name, "WorkerW") == 0 || strcmp(name, "Shell_TrayWnd") == 0 ||
         strcmp(name, "Shell_SecondaryTrayWnd") == 0;
}

/// Есть ли у окна заголовок. GetWindowText для окон чужих процессов читает сохранённый текст
/// и не посылает им сообщений, поэтому зависшая программа не подвесит помощника
/// (GetWindowTextLength, в отличие от него, посылает WM_GETTEXTLENGTH).
static BOOL has_title(HWND hwnd) {
  WCHAR title[2];
  return GetWindowTextW(hwnd, title, 2) > 0;
}

static BOOL CALLBACK collect_window(HWND hwnd, LPARAM param) {
  Scan *scan = (Scan *)param;
  char item[128];
  DWORD pid = 0;

  if (!IsWindowVisible(hwnd) || !has_title(hwnd)) return TRUE;
  GetWindowThreadProcessId(hwnd, &pid);
  if (pid == scan->skip_pid) return TRUE;                               // наши собственные оверлеи
  if (GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) return TRUE; // плавающие панели, всплывашки
  if (is_shell_window(hwnd)) return TRUE;

  // У 64-битного HWND значимы только младшие 32 бита, так что число точно влезает в double в JS
  long long id = (long long)(LONG_PTR)hwnd;

  DWORD cloaked = 0;
  BOOL is_cloaked = SUCCEEDED(DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked, (DWORD)sizeof cloaked)) && cloaked;
  if (IsIconic(hwnd) || is_cloaked) {
    // Свёрнуто или на другом виртуальном рабочем столе — сугроб надо сохранить
    snprintf(item, sizeof item, "%s%lld", scan->hidden.len ? "," : "", id);
    buffer_append(&scan->hidden, item);
    return TRUE;
  }

  // Границы без невидимой рамки для изменения размера; в физических пикселях при любом масштабе
  RECT r;
  if (FAILED(DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &r, (DWORD)sizeof r))) return TRUE;
  if (r.right <= r.left || r.bottom <= r.top) return TRUE;

  snprintf(item, sizeof item, "%s[%lld,%ld,%ld,%ld,%ld]", scan->shown.len ? "," : "", id, (long)r.left,
           (long)r.top, (long)(r.right - r.left), (long)(r.bottom - r.top));
  buffer_append(&scan->shown, item);
  return TRUE;
}

typedef BOOL(WINAPI *SetDpiAwarenessContext)(HANDLE);

/// Помощник работает в физических пикселях, как и ожидает главный процесс (screenToDipRect)
static void enable_dpi_awareness(void) {
  HMODULE user32 = GetModuleHandleW(L"user32.dll");
  SetDpiAwarenessContext set_context =
      user32 ? (SetDpiAwarenessContext)(void *)GetProcAddress(user32, "SetProcessDpiAwarenessContext") : NULL;
  // (HANDLE)-4 — DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, есть начиная с Windows 10 1703
  if (!set_context || !set_context((HANDLE)-4)) SetProcessDPIAware();
}

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: window-tracker <parent-pid>\n");
    return 2;
  }
  char *end = NULL;
  unsigned long parent_pid = strtoul(argv[1], &end, 10);
  if (!end || *end != '\0' || parent_pid == 0) {
    fprintf(stderr, "window-tracker: invalid parent pid '%s'\n", argv[1]);
    return 2;
  }

  HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, (DWORD)parent_pid);
  if (!parent) {
    fprintf(stderr, "window-tracker: parent process %lu not found\n", parent_pid);
    return 1;
  }
  enable_dpi_awareness();

  Scan scan = {(DWORD)parent_pid, {0}, {0}};
  Buffer line = {0};
  Buffer previous = {0};
  buffer_clear(&previous);

  for (;;) {
    // Родитель завершился — помощнику тоже незачем жить
    if (WaitForSingleObject(parent, 0) != WAIT_TIMEOUT) break;

    buffer_clear(&scan.shown);
    buffer_clear(&scan.hidden);
    EnumWindows(collect_window, (LPARAM)&scan);

    buffer_clear(&line);
    buffer_append(&line, "{\"w\":[");
    buffer_append(&line, scan.shown.data);
    buffer_append(&line, "],\"d\":null,\"h\":[");
    buffer_append(&line, scan.hidden.data);
    buffer_append(&line, "]}");

    if (strcmp(line.data, previous.data) != 0) {
      // Канал закрыт — главный процесс нас больше не слушает
      if (fputs(line.data, stdout) == EOF || fputc('\n', stdout) == EOF || fflush(stdout) != 0) break;
      Buffer swap = previous;
      previous = line;
      line = swap;
    }
    Sleep(POLL_MS);
  }

  CloseHandle(parent);
  return 0;
}
