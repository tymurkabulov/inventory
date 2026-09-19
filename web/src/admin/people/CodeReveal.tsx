import { useT } from '../../i18n';
import { copyText, useToast } from '../../ui';

/** Код показывается один раз: дальше только новый сброс. */
export function CodeReveal({ callsign, code, hours }: { callsign: string; code: string; hours: number }) {
  const toast = useToast();
  const t = useT();
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted">
        {t('code.pass')} <b className="text-text">{callsign}</b>. {t('code.valid', { hours })}
      </p>
      <button
        type="button"
        onClick={() =>
          void copyText(code).then((ok) => toast(ok ? t('code.copied') : t('common.copyFailed'), ok ? 'success' : 'warn'))
        }
        title={t('code.copy')}
        className="border border-dashed border-line bg-bg-0 p-2.5 text-center font-mono text-xl font-bold tracking-[0.12em]"
      >
        {code}
      </button>
      <p className="text-xs text-muted">{t('code.how')}</p>
    </div>
  );
}
