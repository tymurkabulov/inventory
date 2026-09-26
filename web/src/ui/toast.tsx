import { createContext, type ReactNode, useContext, useState } from 'react';

import { cx } from './cx';

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
interface ToastItem {
  id: number;
  text: string;
  kind: 'success' | 'warn' | 'error';
}

const ToastCtx = createContext<(text: string, kind?: ToastItem['kind']) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = (text: string, kind: ToastItem['kind'] = 'success') => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs.slice(-2), { id, text, kind }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3000);
  };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-3 bottom-20 z-30 flex flex-col items-center gap-2 lg:bottom-4">
        {items.map((item) => (
          <div
            key={item.id}
            className={cx(
              'w-full max-w-[420px] border px-3 py-2.5 text-sm font-semibold',
              item.kind === 'error'
                ? 'border-red bg-red-dim text-red-ink'
                : item.kind === 'warn'
                  ? 'border-yellow bg-yellow-dim text-yellow-ink'
                  : 'border-line bg-surf-2 text-text',
            )}
          >
            {item.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

