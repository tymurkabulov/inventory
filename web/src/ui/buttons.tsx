import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { cx } from './cx';

import { Icon, type IconName } from './icons';

// ---------------------------------------------------------------------------
// Кнопки и поля
// ---------------------------------------------------------------------------
type Variant = 'blue' | 'green' | 'red' | 'gray' | 'plain';

const VARIANT: Record<Variant, string> = {
  blue: 'border-accent bg-accent text-accent-ink hover:bg-accent-hover hover:border-accent-hover',
  green: 'border-green bg-green text-white hover:bg-green-hover',
  red: 'border-red bg-red-dim text-red-ink hover:bg-red hover:text-white',
  gray: 'border-transparent bg-transparent text-muted hover:bg-surf-3 hover:text-text',
  plain: 'border-line bg-surf-2 text-text hover:bg-surf-3',
};

/** Вид кнопки — отдельно, чтобы ссылка (<Link>) выглядела так же, оставаясь ссылкой. */
export function buttonClass({
  variant = 'plain',
  size = 'md',
  block,
}: { variant?: Variant; size?: 'sm' | 'md'; block?: boolean } = {}): string {
  return cx(
    'inline-flex items-center justify-center gap-2 border font-semibold whitespace-nowrap',
    'active:translate-y-px disabled:translate-y-0 disabled:opacity-40',
    size === 'sm' ? 'min-h-9 px-2.5 text-xs' : 'min-h-touch px-3 text-sm',
    block && 'w-full',
    VARIANT[variant],
  );
}

export function Button({
  variant = 'plain',
  size = 'md',
  icon,
  busy,
  block,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: 'sm' | 'md';
  icon?: IconName;
  busy?: boolean;
  block?: boolean;
}) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      className={cx(buttonClass({ variant, size, block }), className)}
    >
      {busy ? <Spinner /> : icon ? <Icon name={icon} className={size === 'sm' ? 'size-4' : 'size-5'} /> : null}
      {children}
    </button>
  );
}

export function IconButton({
  icon,
  label,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={cx(
        'grid size-touch shrink-0 place-items-center border border-line bg-surf-2 text-text hover:bg-surf-3',
        className,
      )}
    >
      <Icon name={icon} />
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cx('inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent', className)}
    />
  );
}

export function Chip({
  active,
  count,
  children,
  onClick,
}: {
  active?: boolean;
  count?: number;
  children: ReactNode;
  onClick?: () => void;
}) {
  const className = cx(
    'inline-flex min-h-9 shrink-0 items-center gap-1.5 border px-2.5 text-xs font-semibold whitespace-nowrap',
    active ? 'border-text bg-surf-3 text-text' : 'border-line bg-surf-2 text-text',
  );
  const inner = (
    <>
      {children}
      {count !== undefined && <span className="tnum text-muted">{count}</span>}
    </>
  );
  if (!onClick) return <span className={className}>{inner}</span>;
  return (
    <button type="button" aria-pressed={active} onClick={onClick} className={className}>
      {inner}
    </button>
  );
}

export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="border border-line-2 px-1.5 py-0.5 text-[11px] font-bold tracking-[0.02em] text-muted">{children}</span>
  );
}
