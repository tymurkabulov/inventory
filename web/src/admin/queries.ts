import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type PositionRow } from '../api';

export function usePositions() {
  return useQuery({
    queryKey: ['admin', 'positions'],
    queryFn: ({ signal }) => api.get<PositionRow[]>('/admin/positions', signal),
  });
}

/**
 * После любого действия над человеком меняются сразу три экрана:
 * списки админа, доска позиции и собственный профиль.
 */
export function useRefreshPeople() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['admin'] }),
      qc.invalidateQueries({ queryKey: ['board'] }),
      qc.invalidateQueries({ queryKey: ['me'] }),
    ]);
}
