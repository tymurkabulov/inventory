import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, createRoute, createRouter, lazyRouteComponent, redirect } from '@tanstack/react-router';
import type { Me } from './api';
import { Shell } from './Shell';
import { LoadFailed } from './screens/LoadFailed';
import { NotFound } from './screens/NotFound';
import { Board } from './screens/board/Board';
import { Waiting } from './screens/Waiting';
import { Loading } from './ui';

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
  // Админские экраны отдельным куском: рядовой их не грузит вовсе. Через
  // lazyRouteComponent роутер подгружает кусок заранее — при наведении на ссылку.
  component: lazyRouteComponent(() => import('./admin/Overview'), 'Overview'),
});

const peopleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/people',
  beforeLoad: ({ context }) => {
    if (!isAdmin(requireMe(context.qc))) throw redirect({ to: '/me' });
  },
  errorComponent: LoadFailed,
  component: lazyRouteComponent(() => import('./admin/people/People'), 'People'),
});

// Позиции заводит только полный админ: у админа зоны их нет даже в меню.
const positionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/positions',
  beforeLoad: ({ context }) => {
    if (!requireMe(context.qc).admin.full) throw redirect({ to: '/me' });
  },
  errorComponent: LoadFailed,
  component: lazyRouteComponent(() => import('./admin/Positions'), 'Positions'),
});

const routeTree = rootRoute.addChildren([indexRoute, meRoute, positionRoute, adminRoute, peopleRoute, positionsRoute]);

export function createAppRouter(qc: QueryClient) {
  return createRouter({
    routeTree,
    context: { qc },
    defaultPreload: 'intent',
    // Ожидание и ошибка — внутри маршрута, а не вокруг всего Outlet: при обрыве
    // остаются шапка и разделы, и человеку есть куда нажать.
    defaultPendingComponent: Loading,
    defaultErrorComponent: LoadFailed,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
