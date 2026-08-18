import { defineComponent, h } from 'vue';
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import PanelLayout from '../layouts/PanelLayout.vue';
import LoginView from '../views/LoginView.vue';
import RegisterView from '../views/RegisterView.vue';
import { useSessionStore } from '../stores/session.ts';

/**
 * Заглушка экрана: настоящий путь уже есть, содержимое приезжает своей
 * задачей. Так навигация и гарды проверяются целиком, не дожидаясь последнего
 * экрана.
 */
const stub = (title: string) => defineComponent({
  name: 'StubView',
  render: () => h('h1', title),
});

export const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: LoginView, meta: { public: true } },
  { path: '/register', name: 'register', component: RegisterView, meta: { public: true } },
  {
    path: '/',
    component: PanelLayout,
    children: [
      { path: '', name: 'widgets', component: stub('Виджеты') },
      { path: 'widgets/:id', name: 'widget', component: stub('Настройка виджета') },
      { path: 'widgets/:id/install', name: 'widget-install', component: stub('Установка на сайт') },
      { path: 'leads', name: 'leads', component: stub('Лиды') },
      { path: 'dialogs', name: 'dialogs', component: stub('Диалоги') },
      { path: 'usage', name: 'usage', component: stub('Использование') },
      { path: 'admin/accounts', name: 'admin-accounts', component: stub('Аккаунты'), meta: { admin: true } },
      { path: 'admin/usage', name: 'admin-usage', component: stub('Расход витрины'), meta: { admin: true } },
    ],
  },
  { path: '/:pathMatch(.*)*', name: 'not-found', component: stub('Страница не найдена'), meta: { public: true } },
];

export const router = createRouter({
  // Базой обязан быть тот же префикс, с которого бэкенд раздаёт SPA
  // (panelApp.ts), иначе history-фолбэк и ссылки на чанки разъедутся.
  // vue-router нормализует базу и хранит её БЕЗ хвостового слэша — '/panel'.
  history: createWebHistory('/panel/'),
  routes,
});

router.beforeEach(async (to) => {
  if (to.meta.public === true) return true;
  const session = useSessionStore();

  // Сначала спрашиваем сервер, кто мы, и ТОЛЬКО потом решаем про редирект:
  // иначе обычная перезагрузка страницы кабинета всегда выкидывала бы на
  // логин — стор при старте пуст по определению.
  if (session.account === null && !session.loaded) await session.load();

  if (session.account === null) {
    return { name: 'login', query: { next: to.fullPath } };
  }
  // Не-админ, забредший на /admin/*, уезжает к себе домой — без объяснений,
  // как и на бэкенде.
  if (to.meta.admin === true && session.account.is_admin !== true) {
    return { name: 'widgets' };
  }
  return true;
});

export default router;
