import type { Item } from '../../api';
import { fmtAgo, fmtQty, useI18n } from '../../i18n';
import { ConditionMark, cx, LEVEL_RAIL, levelOf, openable, QtyStepper, StatusBadge } from '../../ui';

/** Телефон: карточки. Крупная цель нажатия и остаток правится, не открывая панель. */
export function BoardCards({
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
    <ul className="flex flex-col gap-3 p-3 lg:hidden">
      {items.map((it) => {
        const level = levelOf(it.status, it.full_stock);
        return (
          <li
            key={it.id}
            {...openable(() => onOpen(it))}
            className={cx(
              'relative grid gap-2 border py-2.5 pr-2.5 pl-3.5',
              level === 'crit' ? 'border-red bg-red-dim' : 'border-line bg-surf',
            )}
          >
            <i aria-hidden className={cx('absolute top-0 bottom-0 left-0 w-1', LEVEL_RAIL[level])} />
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <h3 className="text-sm leading-5 font-bold">{it.name}</h3>
                <div className="truncate text-xs text-muted">
                  {[it.category, `${t('col.updated')} ${fmtAgo(lang, it.updated_at, now)}`, it.updated_by_callsign]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              <StatusBadge level={level} />
            </div>
            <QtyStepper value={it.qty} saveLabel={t('common.save')} onSave={(qty) => onSaveQty(it.id, qty)} />
            <div className="tnum flex flex-wrap items-center gap-x-2 text-xs text-muted">
              <span>
                {fmtQty(lang, it.qty)} / {fmtQty(lang, it.ideal_qty)} {it.unit}
              </span>
              <span>
                · {t('item.min')} {fmtQty(lang, it.min_qty)} ·
              </span>
              <ConditionMark condition={it.condition} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
