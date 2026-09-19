import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import en from './locales/en';
import uk from './locales/uk';

export type Plural = { one: string; few?: string; many?: string; other: string };
export type Entry = string | Plural;
export type Key = keyof typeof uk;
export type Dict = Record<Key, Entry>;

// Реестр языков. Новый язык: словарь в locales/<код>.ts, строка здесь
// и блок сообщений бота в server/src/i18n.ts.
const LANGUAGES = {
  uk: { name: 'Українська', intl: 'uk-UA', dict: uk },
  en: { name: 'English', intl: 'en-GB', dict: en },
} satisfies Record<string, { name: string; intl: string; dict: Dict }>;

export type Lang = keyof typeof LANGUAGES;
export const LANGS = Object.keys(LANGUAGES) as Lang[];
export const DEFAULT_LANG: Lang = 'uk';
export const langName = (lang: Lang) => LANGUAGES[lang].name;
export const intlLocale = (lang: Lang) => LANGUAGES[lang].intl;

export function isLang(v: unknown): v is Lang {
  return typeof v === 'string' && Object.hasOwn(LANGUAGES, v);
}

export type Params = Record<string, string | number>;
export type T = (key: Key, params?: Params) => string;

function makeT(lang: Lang): T {
  const rules = new Intl.PluralRules(lang);
  const dict: Dict = LANGUAGES[lang].dict;
  return (key, params) => {
    const entry = dict[key];
    let text: string;
    if (typeof entry === 'string') text = entry;
    else {
      const n = Number(params?.count ?? 0);
      const form = rules.select(n) as keyof Plural;
      text = entry[form] ?? entry.other;
    }
    return params ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m)) : text;
  };
}

function savedLang(): Lang | null {
  try {
    const saved = localStorage.getItem('hz-lang');
    return isLang(saved) ? saved : null;
  } catch {
    return null; // приватный режим
  }
}

export function detectLang(): Lang {
  const saved = savedLang();
  if (saved) return saved;
  for (const l of navigator.languages ?? [navigator.language]) {
    const base = l.slice(0, 2).toLowerCase();
    if (isLang(base)) return base;
  }
  return DEFAULT_LANG;
}

/** Человек сам выбирал язык на этом устройстве. */
export function hasSavedLang(): boolean {
  return savedLang() !== null;
}

interface I18n {
  lang: Lang;
  t: T;
  /** explicit — выбор человека: запоминается на устройстве. */
  setLang: (lang: Lang, explicit?: boolean) => void;
}

const I18nCtx = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectLang);

  const setLang = useCallback((next: Lang, explicit = true) => {
    setLangState(next);
    if (explicit) {
      try {
        localStorage.setItem('hz-lang', next);
      } catch {
        /* не критично */
      }
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const value = useMemo(() => ({ lang, setLang, t: makeT(lang) }), [lang, setLang]);
  return <I18nCtx.Provider value={value}>{children}</I18nCtx.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nCtx);
  if (!ctx) throw new Error('I18nProvider missing');
  return ctx;
}

export const useT = () => useI18n().t;

const VALIDATION_FIELDS = new Set(['pin', 'code', 'callsign']);

/** Текст ошибки на текущем языке: по коду от сервера, иначе запасной. */
export function errorText(t: T, err: unknown): string {
  if (!(err instanceof Error)) return t('err.unknown');
  const e = err as Error & { code?: string; params?: Params; status?: number };
  if (e.code === 'validation') {
    const field = String(e.params?.field ?? '');
    if (VALIDATION_FIELDS.has(field)) return t(`err.validation.${field}` as Key);
    return t('err.validation', { field });
  }
  if (e.code) {
    const key = `err.${e.code}` as Key;
    if (key in uk) return t(key, e.params);
  }
  if (e.status !== undefined) return t('err.unknown');
  return err.message || t('err.unknown');
}

// ---------------------------------------------------------------------------
// Форматирование
// ---------------------------------------------------------------------------
export function fmtAgo(lang: Lang, iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const rtf = new Intl.RelativeTimeFormat(intlLocale(lang), { numeric: 'auto' });
  const min = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (min < 1) return makeT(lang)('time.justNow');
  if (min < 60) return rtf.format(-min, 'minute');
  const h = Math.floor(min / 60);
  if (h < 48) return rtf.format(-h, 'hour');
  return rtf.format(-Math.floor(h / 24), 'day');
}

export function fmtDateTime(lang: Lang, iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(intlLocale(lang), {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function fmtQty(lang: Lang, n: number): string {
  return n.toLocaleString(intlLocale(lang), { maximumFractionDigits: 2, useGrouping: false });
}
