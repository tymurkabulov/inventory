import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { I18nProvider } from '../src/i18n';
import { Sheet } from '../src/ui/sheet';

/** Экран с кнопкой, которая открывает лист: нужен, чтобы проверить возврат фокуса. */
function Host() {
  const [open, setOpen] = useState(false);
  return (
    <I18nProvider>
      <button type="button" onClick={() => setOpen(true)}>
        Відкрити
      </button>
      <Sheet open={open} title="Рядок" onClose={() => setOpen(false)}>
        <button type="button">Перший</button>
        <button type="button">Останній</button>
      </Sheet>
    </I18nProvider>
  );
}

describe('Sheet', () => {
  it('забирает фокус внутрь и возвращает его на место при закрытии', async () => {
    const user = userEvent.setup();
    render(<Host />);
    const opener = screen.getByRole('button', { name: 'Відкрити' });

    opener.focus();
    await user.click(opener);
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  // Tab по кругу и недоступный фон даёт браузер — если лист открыт модально.
  it('открывается как модальный <dialog>', async () => {
    const user = userEvent.setup();
    render(<Host />);
    await user.click(screen.getByRole('button', { name: 'Відкрити' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialog).toHaveAttribute('data-modal', 'true');
  });

  it('закрывается кликом по затемнению, но не по содержимому', async () => {
    const user = userEvent.setup();
    render(<Host />);
    await user.click(screen.getByRole('button', { name: 'Відкрити' }));

    await user.click(screen.getByRole('button', { name: 'Перший' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.click(screen.getByRole('dialog'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('не перебивает autoFocus поля внутри', async () => {
    function WithField() {
      const [open, setOpen] = useState(false);
      return (
        <I18nProvider>
          <button type="button" onClick={() => setOpen(true)}>
            Відкрити
          </button>
          <Sheet open={open} title="Рядок" onClose={() => setOpen(false)}>
            <input aria-label="Назва" autoFocus />
          </Sheet>
        </I18nProvider>
      );
    }
    const user = userEvent.setup();
    render(<WithField />);
    const opener = screen.getByRole('button', { name: 'Відкрити' });
    await user.click(opener);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Назва' }));

    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(opener);
  });
});
