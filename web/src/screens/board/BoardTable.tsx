import type { Item } from '../../api';
import { fmtAgo, fmtQty, type Key, useI18n } from '../../i18n';
import { ConditionMark, cx, Icon, levelOf, openable, QtyStepper, StatusBadge } from '../../ui';

const COLUMNS: Key[] = ['col.name', 'col.qty', 'col.condition', 'col.updated'];

/** Ноутбук: таблица с липкой шапкой. */
export function BoardTable({
  items,
  now,
  onOpen,
  onSaveQty,
}: {
  items: Item[];
  now: number;
  onOpen: (item: Item) => void;
  onSaveQty: (id: string, qty: number) => void;
}) {
  const { t, lang } = useI18n();
  return (
    <table className="hidden w-full border-separate border-spacing-0 text-sm lg:table">
      <thead>
        <tr>
          {COLUMNS.map((k, i) => (
            <th
              key={k}
              className={cx(
                'sticky top-0 z-2 border-b border-line bg-surf-2 px-2 py-2.5 text-left text-[11px] font-bold tracking-[0.04em] text-muted uppercase',
                i === 0 && 'w-2/5',
              )}
            >
              {t(k)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {items.map((it) => {
          const level = levelOf(it.status, it.full_stock);
          return (
            <tr
              key={it.id}
              {...openable(() => onOpen(it))}
              className={cx(
                level === 'crit' && '[&>td]:bg-red-dim',
                level === 'low' && '[&>td]:bg-yellow-dim/55',
                'hover:[&>td]:bg-surf-2',
              )}
            >
              <td className="border-b border-line px-2 py-1.5">
                <div className="flex items-center gap-2">
                  <StatusBadge level={level} />
                  <span className="font-bold">{it.name}</span>
                </div>
                <div className="text-xs text-muted">{it.category || '—'}</div>
              </td>
              <td className="border-b border-line px-2 py-1.5">
                <QtyStepper value={it.qty} saveLabel={t('common.save')} onSave={(qty) => onSaveQty(it.id, qty)} />
                <div className="tnum mt-1 text-xs text-muted">
                  {fmtQty(lang, it.qty)}/{fmtQty(lang, it.ideal_qty)} {it.unit} · {t('item.min')} {fmtQty(lang, it.min_qty)}
                </div>
              </td>
              <td className="border-b border-line px-2 py-1.5">
                <ConditionMark condition={it.condition} />
              </td>
              <td className="border-b border-line px-2 py-1.5 text-xs">
                <span className={cx('flex items-center gap-1', it.stale && 'text-yellow-ink')}>
                  {it.stale && <Icon name="clock" className="size-3.5" />}
                  {fmtAgo(lang, it.updated_at, now)}
                </span>
                <span className="text-muted">{it.updated_by_callsign ?? ''}</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
