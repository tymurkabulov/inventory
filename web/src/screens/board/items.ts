import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Board as BoardData, type Item, RANK, sortItems, statusOf } from '../../api';
import { errorText, useT } from '../../i18n';
import { useToast } from '../../ui';

export interface ItemPatch {
  id?: string;
  position_id?: string;
  name?: string;
  category?: string;
  unit?: string;
  qty?: number;
  min_qty?: number;
  acceptable_qty?: number;
  ideal_qty?: number;
  condition?: Item['condition'];
  comment?: string;
  /** updated_at, который карточка видела при открытии. Степпер его не шлёт. */
  expected_updated_at?: string;
  /** Остаток, от которого считал степпер: чужая правка за это время даст 409. */
  expected_qty?: number;
}

/** Справочник категорий: один на роту, меняется редко — держим сутки. */
export function useCategories() {
  return useQuery({
    queryKey: ['categories'],
    queryFn: ({ signal }) => api.get<string[]>('/categories', signal),
    staleTime: 24 * 60 * 60 * 1000,
  });
}

export function useSaveItem(positionId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  const t = useT();
  const key = ['board', positionId];
  return useMutation({
    mutationFn: (patch: ItemPatch) => api.post<Item>('/items', { ...patch, position_id: positionId }),
    // Оптимистично: строка сразу перекрашивается и встаёт на своё место.
    onMutate: async (patch) => {
      if (!patch.id) return undefined;
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<BoardData>(key);
      const before = prev?.items.find((it) => it.id === patch.id);
      // Число то же — человек подтвердил, что остаток не изменился.
      const confirmed = !!before && patch.qty !== undefined && before.qty === patch.qty;
      if (prev) {
        const items = prev.items.map((it) => {
          if (it.id !== patch.id) return it;
          const next = { ...it, ...patch } as Item;
          // Снимки для сервера в строку доски не попадают.
          delete (next as Partial<ItemPatch>).expected_qty;
          delete (next as Partial<ItemPatch>).expected_updated_at;
          next.status = statusOf(next.qty, next.min_qty, next.acceptable_qty);
          next.stock_rank = RANK[next.status];
          next.full_stock = next.qty >= next.ideal_qty;
          next.stale = false;
          next.updated_at = new Date().toISOString();
          return next;
        });
        qc.setQueryData<BoardData>(key, { ...prev, items: sortItems(items) });
      }
      return { prev, confirmed };
    },
    onError: (err, _patch, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast(errorText(t, err), 'error');
    },
    onSuccess: (saved, _patch, ctx) => {
      // Строка с сервера сразу, не дожидаясь перечитывания доски: оптимистичный
      // updated_at стоит по часам телефона, и карточка, открытая до перечитывания,
      // прислала бы его как снимок и получила ложное «строку уже изменили».
      qc.setQueryData<BoardData>(key, (cur) =>
        cur ? { ...cur, items: sortItems(cur.items.map((it) => (it.id === saved.id ? saved : it))) } : cur,
      );
      // Подтверждение красной строки бот не рассылает повторно — не обещаем этого и в тосте.
      if (ctx?.confirmed) toast(t('qty.confirmed', { name: saved.name }));
      else if (saved.status === 'red') toast(t('board.redToast', { name: saved.name }), 'warn');
      else toast(t('board.saved'));
    },
    // Остаток виден не только на доске: на «Панели» от него зависят счётчики
    // и список проблем, а в карточке — «последнее изменение». Иначе там
    // останутся вчерашние числа.
    onSettled: (_data, _err, patch) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: key }),
        qc.invalidateQueries({ queryKey: ['admin'] }),
        patch.id ? qc.invalidateQueries({ queryKey: ['movements', patch.id] }) : undefined,
      ]),
  });
}
