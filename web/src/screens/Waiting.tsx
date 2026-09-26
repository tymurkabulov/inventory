import type { Me } from '../api';
import { useT } from '../i18n';
import { PageTitle } from '../ui';

// Раздел 2: без привязки — никакого списка мест, только ожидание.
export function Waiting({ me }: { me: Me }) {
  const t = useT();
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <PageTitle title={t('waiting.title')} meta={me.callsign} />
      <div className="mx-auto max-w-100 px-5 py-7">
        <div className="text-[11px] font-bold tracking-[0.14em] text-muted uppercase">STATUS</div>
        <h2 className="my-2 text-2xl font-semibold">{t('waiting.title')}</h2>
        <p className="text-xs text-muted">{t('waiting.text', { callsign: me.callsign })}</p>
        <div className="mt-4 border border-line bg-surf p-2.5">
          <p className="text-xs text-muted">{t('waiting.auto')}</p>
        </div>
      </div>
    </div>
  );
}
