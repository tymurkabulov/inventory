import { isLang, type Lang, langName, LANGS, useI18n } from '../i18n';

import { cx } from './cx';

import { Icon } from './icons';

export function LanguageSelect({ onChange, className }: { onChange?: (lang: Lang) => void; className?: string }) {
  const { lang, setLang, t } = useI18n();
  return (
    <label
      title={t('nav.language')}
      className={cx(
        'relative flex min-h-9 cursor-pointer items-center gap-1.5 border border-line bg-surf-2 px-2 text-xs font-semibold text-text',
        className,
      )}
    >
      <Icon name="globe" className="size-4" />
      <span className="uppercase">{lang}</span>
      <select
        aria-label={t('nav.language')}
        value={lang}
        onChange={(e) => {
          const next = e.target.value;
          if (!isLang(next)) return;
          setLang(next);
          onChange?.(next);
        }}
        className="absolute inset-0 cursor-pointer appearance-none opacity-0"
      >
        {LANGS.map((l) => (
          <option key={l} value={l}>
            {langName(l)}
          </option>
        ))}
      </select>
    </label>
  );
}
