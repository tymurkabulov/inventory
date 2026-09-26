import type { KeyboardEvent } from 'react';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * Карточка или строка таблицы, которая открывает панель: курсор, Tab, Enter/пробел.
 * Кнопки внутри гасят всплытие сами (см. QtyStepper).
 */
export function openable(onOpen: () => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: onOpen,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      onOpen();
    },
  };
}

/**
 * Копирование в буфер. Сайт работает по HTTPS, где navigator.clipboard есть
 * всегда. Отказ (нет разрешения) — false: экран предложит скопировать руками.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
