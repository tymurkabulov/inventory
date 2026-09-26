import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../src/i18n';
import { QtyStepper } from '../src/ui/qty';

/** Степпер живёт в строке доски, а доска сама переспрашивает сервер раз в 30 с. */
function setup(value: number, onSave = vi.fn()) {
  const ui = (v: number) => (
    <I18nProvider>
      <QtyStepper value={v} saveLabel="Зберегти" onSave={onSave} />
    </I18nProvider>
  );
  const { rerender } = render(ui(value));
  return { onSave, fromServer: (v: number) => rerender(ui(v)) };
}

const field = () => screen.getByRole('textbox');

describe('QtyStepper', () => {
  it('нетронутое число следует за сервером', () => {
    const { fromServer } = setup(10);
    expect(field()).toHaveValue('10');
    fromServer(3);
    expect(field()).toHaveValue('3');
  });

  it('набранное число переживает обновление доски', async () => {
    const user = userEvent.setup();
    const { fromServer } = setup(10);

    await user.clear(field());
    await user.type(field(), '124');
    fromServer(3); // тем временем остаток поправили с другого телефона

    expect(field()).toHaveValue('124');
  });

  it('шлёт число, от которого начали править, даже если доска обновилась', async () => {
    const user = userEvent.setup();
    const { onSave, fromServer } = setup(10);

    await user.click(screen.getByRole('button', { name: /плюс|plus/i }));
    fromServer(8); // кто-то поправил с другого телефона
    await user.click(screen.getByRole('button', { name: 'Зберегти' }));
    // Сервер сверит 10 с тем, что у него сейчас (8), и ответит 409.
    expect(onSave).toHaveBeenCalledWith(11, 10);
  });

  it('после сохранения снова следует за сервером', async () => {
    const user = userEvent.setup();
    const { onSave, fromServer } = setup(10);

    await user.clear(field());
    await user.type(field(), '7');
    await user.click(screen.getByRole('button', { name: 'Зберегти' }));
    expect(onSave).toHaveBeenCalledWith(7, 10);

    fromServer(7);
    fromServer(2);
    expect(field()).toHaveValue('2');
  });
});
