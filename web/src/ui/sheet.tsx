import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from 'react';

import { useT } from '../i18n';

import { Button, IconButton } from './buttons';

// ---------------------------------------------------------------------------
// Модальные листы: снизу на телефоне, по центру на ноутбуке.
//
// Нативный <dialog> через showModal(): фокус внутрь, Tab по кругу, Escape и
// недоступный фон браузер делает сам. Наше — только закрытие по затемнению
// и возврат фокуса туда, откуда лист открыли.
// ---------------------------------------------------------------------------
interface SheetProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

export function Sheet(props: SheetProps) {
  return props.open ? <SheetDialog {...props} /> : null;
}

function SheetDialog({ title, onClose, children, footer }: SheetProps) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  // Кнопка, которой лист открыли. Запоминаем при монтировании, до autoFocus
  // полей внутри: при закрытии фокус возвращается на неё.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  // onClose приходит новой стрелкой на каждый рендер родителя, а эффекту нужен
  // только сам факт открытия: иначе лист переоткрывался бы на каждое нажатие.
  const close = useEffectEvent(onClose);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    // Поле внутри уже взяло фокус через autoFocus — showModal его не перебивает.
    const inside = el.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    el.showModal();
    inside?.focus();
    // Escape: браузер закрыл бы диалог сам, мимо состояния родителя. Решает родитель.
    const onCancel = (e: Event) => {
      e.preventDefault();
      close();
    };
    el.addEventListener('cancel', onCancel);
    return () => {
      el.removeEventListener('cancel', onCancel);
      el.close();
      opener?.focus?.();
    };
  }, [opener]);

  return (
    <dialog
      ref={dialog}
      aria-label={title}
      // Клик по затемнению приходит в сам <dialog>: панель заполняет его целиком.
      onClick={(e) => e.target === e.currentTarget && onClose()}
      className="mx-auto mt-auto mb-3 max-h-[86dvh] w-[calc(100%-1.5rem)] max-w-[420px] border border-line bg-surf p-0 text-text shadow-sheet lg:my-auto"
    >
      <div className="max-h-[86dvh] overflow-auto p-4">
        {/* Крестик вверху: закрыть, не долистывая до кнопок внизу. */}
        <div className="mb-2 flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold">{title}</h2>
          <IconButton icon="x" label={t('common.close')} onClick={onClose} className="-mt-1 -mr-1" />
        </div>
        <div className="flex flex-col gap-3">{children}</div>
        {footer ? <div className="mt-3 flex flex-col gap-2">{footer}</div> : null}
      </div>
    </dialog>
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
