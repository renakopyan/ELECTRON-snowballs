/** Убирает null и undefined из типа; если значения нет — тест падает с понятным сообщением */
export function must<T>(value: T | null | undefined, message = 'ожидалось значение, а не null/undefined'): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}
