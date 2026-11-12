import { app, session } from 'electron';

/**
 * Страница со снегом ничего не загружает и никуда не ходит: навигация, новые окна и webview
 * ей не нужны. Закрываем их для всех веб-страниц приложения, чтобы подмена содержимого или
 * ошибка в рендерере не превратили оверлей в браузер. Вызывать до создания первого окна.
 */
export function hardenWebContents(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.on('will-redirect', (event) => event.preventDefault());
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}

/** Оверлею не нужны ни камера, ни микрофон, ни уведомления, ни другие разрешения. Вызывать после app.whenReady() */
export function denyAllPermissions(): void {
  const { defaultSession } = session;
  defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  defaultSession.setPermissionCheckHandler(() => false);
}
