import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api, type Overview as OverviewData } from '../api';
import { fmtAgo, fmtQty, useI18n } from '../i18n';
import { useNow } from '../hooks';
import { cx, Empty, ErrorNote, Loading, PageTitle, StatusBadge } from '../ui';

export function Overview() {
  const { t, lang } = useI18n();
  const now = useNow();
  const q = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: ({ signal }) => api.get<OverviewData>('/admin/overview', signal),
    refetchInterval: 30_000,
    refetchOnMount: 'always',
  });

  const active = (q.data?.tiles ?? []).filter((x) => x.is_active);
  const title = <PageTitle title={t('nav.overview')} meta={t('pos.count', { count: active.length })} />;

  if (q.isPending) return <>{title}<Loading /></>;
  if (q.error) return <>{title}<ErrorNote error={q.error} /></>;

  const { red } = q.data;
  const stale = active.filter((x) => x.stale && x.people > 0);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {title}
      <div className="flex flex-col gap-3 p-3">
        {active.length === 0 ? (
          <Empty title={t('ov.noLocations')}>{t('ov.noLocationsHint')}</Empty>
        ) : (
          <div className="grid gap-2 lg:grid-cols-3">
            {active.map((tile) => {
              const isStale = tile.stale && tile.people > 0;
              return (
                <Link
                  key={tile.id}
                  to="/pos/$positionId"
                  params={{ positionId: tile.id }}
                  className={cx(
                    'flex min-h-30 flex-col gap-2 border bg-surf p-3 text-left',
                    isStale ? 'border-dashed border-yellow' : 'border-line',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-base font-semibold">{tile.name}</h3>
                    {isStale && <StatusBadge level="low">{t('ov.stale')}</StatusBadge>}
                  </div>
                  <div className="text-xs text-muted">
                    {t('ov.people', { count: tile.people })} · {t('ov.updated', { ago: fmtAgo(lang, tile.last_update, now) })}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <StatusBadge level="crit">
                      {tile.red} {t('filter.red')}
                    </StatusBadge>
                    <StatusBadge level="low">
                      {tile.yellow} {t('filter.yellow')}
                    </StatusBadge>
                    <StatusBadge level="ok">
                      {tile.green} {t('filter.green')}
                    </StatusBadge>
                  </div>
                </Link>
              );
            })}
          </div>
        )}

        <h2 className="mt-1 text-base font-semibold">{t('ov.problems')}</h2>
        {red.length + stale.length === 0 ? (
          <Empty title={t('ov.noProblems')}>{t('ov.noProblemsHint')}</Empty>
        ) : (
          <div className="flex flex-col gap-1.5">
            {red.map((r) => (
              <Link
                key={r.id}
                to="/pos/$positionId"
                params={{ positionId: r.position_id }}
                className="flex items-center gap-2.5 border border-line bg-surf p-2.5 text-left"
              >
                <StatusBadge level="crit" />
                <span className="min-w-0 flex-1">
                  <b className="block truncate">{r.name}</b>
                  <span className="block truncate text-xs text-muted">
                    {r.position_name} · {fmtQty(lang, r.qty)} / {fmtQty(lang, r.min_qty)} {r.unit} ·{' '}
                    {fmtAgo(lang, r.updated_at, now)}
                  </span>
                </span>
              </Link>
            ))}
            {stale.map((tile) => (
              <Link
                key={tile.id}
                to="/pos/$positionId"
                params={{ positionId: tile.id }}
                className="flex items-center gap-2.5 border border-line bg-surf p-2.5 text-left"
              >
                <StatusBadge level="low">{t('ov.stale')}</StatusBadge>
                <span className="min-w-0 flex-1">
                  <b className="block truncate">{tile.name}</b>
                  <span className="block truncate text-xs text-muted">
                    {t('ov.staleLine', { ago: fmtAgo(lang, tile.last_update, now), hours: tile.stale_after_hours })}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
