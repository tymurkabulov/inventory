import type { ReactNode } from 'react';

import { errorText, useT } from '../i18n';

import { cx } from './cx';

import { IconButton, Spinner } from './buttons';

import { Icon } from './icons';

/** Ключ-значение в карточке: подпись сверху, число крупно. */
export function Box({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border border-line bg-surf p-2.5">
      <span className="mb-1.5 block text-xs font-semibold text-muted">{label}</span>
      <b className="tnum block text-lg font-bold">{children}</b>
    </div>
  );
}

export function Banner({ children }: { children: ReactNode }) {
  return (
    <p className="m-3 border border-dashed border-yellow bg-yellow-dim px-3 py-2.5 text-xs font-semibold text-yellow-ink">
      {children}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Разметка приложения: слева разделы (ноутбук), сверху заголовок экрана.
// ---------------------------------------------------------------------------
export function TopBar({
  title,
  meta,
  onBack,
  children,
}: {
  title: ReactNode;
  meta?: ReactNode;
  onBack?: () => void;
  children?: ReactNode;
}) {
  const t = useT();
  return (
    <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-line bg-surf px-3 py-2">
      {onBack && <IconButton icon="back" label={t('nav.back')} onClick={onBack} />}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-base leading-[22px] font-semibold">{title}</h1>
        {meta ? <div className="truncate text-xs leading-4 text-muted">{meta}</div> : null}
      </div>
      {children}
    </header>
  );
}

export function StickyTools({ children }: { children: ReactNode }) {
  return <div className="sticky top-0 z-3 border-b border-line bg-bg px-3 py-2.5">{children}</div>;
}

/** Нижняя панель на телефоне: главное действие экрана под большим пальцем. */
export function BottomBar({ children }: { children: ReactNode }) {
  return <div className="flex shrink-0 gap-2 border-t border-line bg-surf px-3 py-2 lg:hidden">{children}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="border border-line bg-surf p-4">
      <p className="font-semibold">{title}</p>
      {children ? <p className="mt-1 text-xs text-muted">{children}</p> : null}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  const t = useT();
  if (!error) return null;
  return (
    <p role="alert" className="flex items-start gap-2 border border-red bg-red-dim px-3 py-2.5 text-xs font-semibold text-red-ink">
      <Icon name="alert" className="size-4 shrink-0" />
      {errorText(t, error)}
    </p>
  );
}

export function Loading() {
  const t = useT();
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-xs text-muted">
      <Spinner className="size-4" />
      {t('common.loading')}
    </div>
  );
}
