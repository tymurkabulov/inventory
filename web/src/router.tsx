import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, createRoute, createRouter, redirect, useNavigate } from '@tanstack/react-router';
import { lazy, type ReactNode, Suspense, useEffect } from 'react';
import type { Me } from './api';
import { Shell } from './Shell';
import { clearReloadGuard, LoadFailed } from './screens/LoadFailed';
import { NotFound } from './screens/NotFound';
import { Board } from './screens/board/Board';
import { Waiting } from './screens/Waiting';
import { Loading } from './ui';

// Админские экраны отдельным куском: рядовой их не грузит вовсе.
const Overview = lazy(() => import('./admin/Overview').then((m) => ({ default: m.Overview })));
const People = lazy(() => import('./admin/people/People').then((m) => ({ default: m.People })));
const Positions = lazy(() => import('./admin/Positions').then((m) => ({ default: m.Positions })));

/**
 * Ожидание и ошибка загрузки — внутри маршрута, а не вокруг всего Outlet:
 * тогда при обрыве остаются шапка и разделы, и человеку есть куда нажать.
 */
function Lazy({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<Loading />}>
      <Loaded>{children}</Loaded>
    </Suspense>
  );
}

/** Монтируется только когда кусок кода дошёл — здесь и снимаем защиту от зацикливания. */
function Loaded({ children }: { children: ReactNode }) {
  useEffect(clearReloadGuard, []);
  return children;
}

interface Context {
  qc: QueryClient;
}

/** Профиль уже в кэше: App не показывает маршруты, пока его не загрузит. */
function requireMe(qc: QueryClient): Me {
  const me = qc.getQueryData<Me | null>(['me']);
  if (!me) throw redirect({ to: '/' });
  return me;
}

const isAdmin = (me: Me) => me.admin.full || me.admin.position_ids.length > 0;

/** Списки открывают доску позиции; сам переход знает только маршрут. */
function useOpenPosition() {
  const navigate = useNavigate();
  return (positionId: string) => navigate({ to: '/pos/$positionId', params: { positionId } });
}

const rootRoute = createRootRouteWithContext<Context>()({
  component: Shell,
  notFoundComponent: NotFound,
});

/** Корень: админу — панель, рядовому — своё место или ожидание. */
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: ({ context }) => {
    const me = requireMe(context.qc);
    if (isAdmin(me)) throw redirect({ to: '/admin' });
    throw redirect({ to: '/me' });
  },
});

const meRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/me',
  component: function OwnPlace() {
    const me = requireMe(meRoute.useRouteContext().qc);
    const own = me.assignment;
    if (!own) return <Waiting me={me} />;
    return <Board key={own.position_id} positionId={own.position_id} isOwn />;
  },
});

const positionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/pos/$positionId',
  beforeLoad: ({ context }) => {
    if (!isAdmin(requireMe(context.qc))) throw redirect({ to: '/me' });
  },
  component: function PositionBoard() {
    const { positionId } = positionRoute.useParams();
    const me = requireMe(positionRoute.useRouteContext().qc);
    return <Board key={positionId} positionId={positionId} isOwn={me.assignment?.position_id === positionId} />;
  },
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  beforeLoad: ({ context }) => {
    if (!isAdmin(requireMe(context.qc))) throw redirect({ to: '/me' });
  },
  errorComponent: LoadFailed,
  component: function OverviewScreen() {
    return (
      <Lazy>
        <Overview open={useOpenPosition()} />
      </Lazy>
    );
  },
});

const peopleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/people',
  beforeLoad: ({ context }) => {
    if (!isAdmin(requireMe(context.qc))) throw redirect({ to: '/me' });
  },
  errorComponent: LoadFailed,
  component: function PeopleScreen() {
    return (
      <Lazy>
        <People me={requireMe(peopleRoute.useRouteContext().qc)} />
      </Lazy>
    );
  },
});

// Позиции заводит только полный админ: у админа зоны их нет даже в меню.
const positionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/positions',
  beforeLoad: ({ context }) => {
    if (!requireMe(context.qc).admin.full) throw redirect({ to: '/me' });
  },
  errorComponent: LoadFailed,
  component: function PositionsScreen() {
    return (
      <Lazy>
        <Positions open={useOpenPosition()} />
      </Lazy>
    );
  },
});

const routeTree = rootRoute.addChildren([indexRoute, meRoute, positionRoute, adminRoute, peopleRoute, positionsRoute]);

export function createAppRouter(qc: QueryClient) {
  return createRouter({ routeTree, context: { qc }, defaultPreload: 'intent', defaultErrorComponent: LoadFailed });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
