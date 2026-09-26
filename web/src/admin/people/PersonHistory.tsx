import { useQuery } from '@tanstack/react-query';
import { api, type HistoryRow } from '../../api';
import { fmtDate } from '../../format';
import { useT } from '../../i18n';
import { Label } from '../../ui';

/** Где человек стоял раньше: только чтение, поэтому свой запрос и никакого состояния. */
export function PersonHistory({ personId }: { personId: string }) {
  const t = useT();
  const history = useQuery({
    queryKey: ['admin', 'history', personId],
    queryFn: ({ signal }) => api.get<HistoryRow[]>(`/admin/users/${personId}/history`, signal),
  });

  return (
    <div>
      <Label>{t('history.title')}</Label>
      {history.data && history.data.length > 0 ? (
        <ul className="m-0 list-none p-0">
          {history.data.map((h) => (
            <li key={h.id} className="grid grid-cols-[8px_1fr] gap-2 border-b border-line py-2 text-sm">
              <i aria-hidden className="mt-1.5 size-2 bg-accent" />
              <div>
                <b>{h.position_name}</b>
                <div className="text-xs text-muted">
                  {fmtDate(h.date_from)} — {h.date_to ? fmtDate(h.date_to) : t('history.now')}
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted">{history.isPending ? t('common.loading') : t('history.empty')}</p>
      )}
    </div>
  );
}
