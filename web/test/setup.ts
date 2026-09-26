import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// globals: false, поэтому авто-очистку testing-library вешаем сами: иначе DOM
// копится между тестами и запросы находят по несколько элементов сразу.
afterEach(cleanup);

// jsdom не умеет модальный <dialog>. Повторяем ту часть браузера, на которую
// опираются листы: showModal открывает и уводит фокус внутрь, Escape шлёт
// отменяемое cancel, close закрывает. Ловушку Tab и недоступный фон jsdom
// не воспроизведёт — это проверяется в браузере.
if (!HTMLDialogElement.prototype.showModal) {
  const escape = new WeakMap<HTMLDialogElement, (e: KeyboardEvent) => void>();
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
    this.dataset.modal = 'true';
    if (!this.contains(document.activeElement)) {
      this.querySelector<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')?.focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const cancel = new Event('cancel', { cancelable: true });
      if (this.dispatchEvent(cancel)) this.close();
    };
    escape.set(this, onKey);
    document.addEventListener('keydown', onKey);
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    delete this.dataset.modal;
    const onKey = escape.get(this);
    if (onKey) document.removeEventListener('keydown', onKey);
  };
}
