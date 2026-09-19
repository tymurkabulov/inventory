import type { ReactNode } from 'react';
import { useT } from '../../i18n';
import { Button } from '../../ui';

/** Рамка для одного действия внутри карточки человека: поля, «сделать», «отмена». */
export function ActionBox({
  title,
  children,
  submitLabel,
  danger,
  busy,
  disabled,
  onCancel,
  onSubmit,
}: {
  title: string;
  children: ReactNode;
  submitLabel: string;
  danger?: boolean;
  busy: boolean;
  disabled?: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const t = useT();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="flex flex-col gap-3 border border-line bg-bg-0 p-3"
    >
      <b>{title}</b>
      {children}
      <Button
        variant={danger ? 'red' : 'green'}
        icon={danger ? undefined : 'check'}
        block
        type="submit"
        busy={busy}
        disabled={disabled}
      >
        {submitLabel}
      </Button>
      <Button variant="gray" block onClick={onCancel}>
        {t('common.cancel')}
      </Button>
    </form>
  );
}
