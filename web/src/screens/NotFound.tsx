import { Link } from '@tanstack/react-router';
import { useT } from '../i18n';
import { buttonClass, cx, Empty } from '../ui';

/** Опечатка в ссылке больше не выглядит как рабочий экран. */
export function NotFound() {
  const t = useT();
  return (
    <div className="p-3">
      <Empty title={t('notFound.title')}>{t('notFound.text')}</Empty>
      <Link to="/" className={cx(buttonClass({ variant: 'blue' }), 'mt-3')}>
        {t('notFound.home')}
      </Link>
    </div>
  );
}
