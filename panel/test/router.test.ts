import { describe, expect, it } from 'vitest';
import { router, routes } from '../src/router/index.ts';

describe('роутер панели', () => {
  it('база истории совпадает с префиксом раздачи SPA', () => {
    // Бэкенд отдаёт оболочку с /panel (panelApp.ts), Vite собирает чанки с
    // base '/panel/'. Разъезд этих трёх мест = белый экран после деплоя.
    expect(router.options.history.base).toBe('/panel');
  });

  it('каждый объявленный путь резолвится в непустой компонент', () => {
    const paths = [
      '/login', '/register', '/', '/widgets/abc', '/widgets/abc/install',
      '/leads', '/dialogs', '/dialogs/abc', '/usage', '/admin/accounts', '/admin/usage',
    ];
    for (const path of paths) {
      const resolved = router.resolve(path);
      expect(resolved.matched.length, `нет совпадения для ${path}`).toBeGreaterThan(0);
      expect(resolved.matched[0]!.components?.default, `нет компонента у ${path}`).toBeTruthy();
      // Заглушка тоже обязана быть настоящим компонентом, а не undefined:
      // иначе router-view отрисует пустоту без единой ошибки в консоли.
      expect(resolved.name).not.toBe('not-found');
    }
  });

  it('неизвестный путь ловится и не роняет SPA', () => {
    const resolved = router.resolve('/такого-экрана-нет');
    expect(resolved.name).toBe('not-found');
  });

  it('публичны ровно вход, регистрация и 404 — остальное под гардом', () => {
    const publicNames = routes.filter((r) => r.meta?.public === true).map((r) => r.name);
    expect(publicNames).toEqual(['login', 'register', 'not-found']);
    for (const path of ['/', '/leads', '/dialogs', '/usage', '/admin/accounts']) {
      expect(router.resolve(path).meta.public, `${path} не должен быть публичным`).toBeUndefined();
    }
  });

  it('экраны кабинета живут внутри общего лэйаута, экраны входа — нет', () => {
    expect(router.resolve('/leads').matched).toHaveLength(2);
    expect(router.resolve('/login').matched).toHaveLength(1);
  });
});
