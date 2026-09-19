// Список языков системы. Сам интерфейс переводится на клиенте (web/src/locales),
// серверу язык нужен только чтобы принять и сохранить выбор человека.
//
// Новый язык: добавить код сюда и словарь в web/src/locales.
// База принимает любой двухбуквенный код, список допустимых — здесь.

export const LOCALES = ['uk', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const FALLBACK_LOCALE: Locale = 'uk';

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v);
}
