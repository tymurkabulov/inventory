import { Component, type ErrorInfo, type ReactNode } from 'react';

import { staticT } from './i18n';
import { Button } from './ui';

/**
 * Последняя сетка. Всё внутри маршрутов ловят их errorComponent, но падение
 * экрана входа, провайдеров или темы оставляло белый экран без единой кнопки —
 * а починить его на позиции нечем.
 *
 * Класс, потому что хуками границу ошибок сделать нельзя. Перевод берём без
 * контекста: он мог упасть вместе со всем остальным.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Horizon: непойманная ошибка', error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;

    // Язык по умолчанию — на случай, если сломан сам словарь.
    let title = 'Щось пішло не так';
    let reload = 'Перезавантажити';
    try {
      const t = staticT();
      title = t('load.failedTitle');
      reload = t('common.reload');
    } catch {
      /* остаются значения выше */
    }

    return (
      <main className="mx-auto flex min-h-dvh max-w-100 flex-col justify-center gap-4 px-4">
        <h1 className="text-xl font-semibold">{title}</h1>
        <Button variant="blue" block onClick={() => location.reload()}>
          {reload}
        </Button>
      </main>
    );
  }
}
