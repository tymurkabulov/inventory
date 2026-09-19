import { type ReactNode, useEffect } from 'react';

import { useT } from '../i18n';

import { Button, IconButton } from './buttons';

// ---------------------------------------------------------------------------
// Модальные листы: снизу на телефоне, по центру на ноутбуке.
// ---------------------------------------------------------------------------
export function Sheet({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const t = useT();
  const closeLabel = t('common.close');
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-20 flex items-end justify-center bg-[var(--scrim)] p-3 lg:items-center"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[86%] w-full max-w-[420px] overflow-auto border border-line bg-surf p-4 shadow-sheet"
      >
        {/* Крестик вверху: закрыть, не долистывая до кнопок внизу. */}
        <div className="mb-2 flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold">{title}</h2>
          <IconButton icon="x" label={closeLabel} onClick={onClose} className="-mt-1 -mr-1" />
        </div>
        <div className="flex flex-col gap-3">{children}</div>
        {footer ? <div className="mt-3 flex flex-col gap-2">{footer}</div> : null}
      </div>
    </div>
  );
}

export function ConfirmSheet({
  open,
  title,
  children,
  confirmLabel,
  variant = 'red',
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  variant?: 'red' | 'green' | 'blue';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <Sheet open={open} title={title} onClose={onCancel}>
      <p className="text-xs text-muted">{children}</p>
      <Button variant={variant} block busy={busy} onClick={onConfirm}>
        {confirmLabel}
      </Button>
      <Button variant="gray" block onClick={onCancel}>
        {t('common.cancel')}
      </Button>
    </Sheet>
  );
}
