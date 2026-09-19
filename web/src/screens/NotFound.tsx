import { useNavigate } from '@tanstack/react-router';
import { useT } from '../i18n';
import { Button, Empty } from '../ui';

/** Опечатка в ссылке больше не выглядит как рабочий экран. */
export function NotFound() {
  const t = useT();
  const navigate = useNavigate();
  return (
    <div className="p-3">
      <Empty title={t('notFound.title')}>{t('notFound.text')}</Empty>
      <Button variant="blue" className="mt-3" onClick={() => navigate({ to: '/' })}>
        {t('notFound.home')}
      </Button>
    </div>
  );
}
