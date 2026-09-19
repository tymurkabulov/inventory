import type { ReactNode } from 'react';

import type { Condition, Status } from '../api';

import { useT } from '../i18n';

import { cx } from './cx';

// ---------------------------------------------------------------------------
// Статус: подпись заглавными в цветной рамке. Смысл несёт слово, цвет — подсказка,
// поэтому без цвета значок всё равно читается.
// ---------------------------------------------------------------------------
export type Level = 'crit' | 'low' | 'ok' | 'full';

export function levelOf(status: Status, full: boolean): Level {
  if (status === 'red') return 'crit';
  if (status === 'yellow') return 'low';
  return full ? 'full' : 'ok';
}

const LEVEL_BADGE: Record<Level, string> = {
  crit: 'border-red bg-red-dim text-red-ink',
  low: 'border-yellow bg-yellow-dim text-yellow-ink',
  ok: 'border-green bg-green-dim text-green-ink',
  full: 'border-full bg-full-dim text-full-ink',
};

export const LEVEL_RAIL: Record<Level, string> = {
  crit: 'bg-red',
  low: 'bg-yellow',
  ok: 'bg-green',
  full: 'bg-full',
};

export const LEVEL_KEY: Record<Level, 'status.red' | 'status.yellow' | 'status.green' | 'status.full'> = {
  crit: 'status.red',
  low: 'status.yellow',
  ok: 'status.green',
  full: 'status.full',
};

/** Значок статуса — один на всё приложение: доска, карточка строки, панель. */
export function StatusBadge({ level, children }: { level: Level; children?: ReactNode }) {
  const t = useT();
  return (
    <span
      className={cx(
        'inline-flex h-5.5 shrink-0 items-center border px-1.5 text-[11px] font-bold tracking-[0.03em] uppercase',
        LEVEL_BADGE[level],
      )}
    >
      {children ?? t(LEVEL_KEY[level])}
    </span>
  );
}

const COND_MARK: Record<Condition, string> = {
  ok: 'bg-green rounded-full',
  repair: 'bg-yellow [clip-path:polygon(50%_0,100%_100%,0_100%)]',
  broken: 'bg-red',
};

export function ConditionMark({ condition }: { condition: Condition }) {
  const t = useT();
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted">
      <i aria-hidden className={cx('size-1.75 shrink-0', COND_MARK[condition])} />
      {t(`condition.${condition}`)}
    </span>
  );
}
