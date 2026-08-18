import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { defineComponent, h } from 'vue';
import LoginView from '../src/views/LoginView.vue';

const blank = defineComponent({ render: () => h('div') });

/** Отдельный роутер без гардов: экран логина проверяем в изоляции от навигации. */
const testRouter = () => createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', name: 'widgets', component: blank },
    { path: '/login', name: 'login', component: blank },
    { path: '/register', name: 'register', component: blank },
  ],
});

const stubFetch = (status: number, body: unknown): void => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })));
};

const mountLogin = async () => {
  const router = testRouter();
  await router.push('/login');
  await router.isReady();
  return mount(LoginView, { global: { plugins: [router] } });
};

beforeEach(() => { setActivePinia(createPinia()); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('экран входа', () => {
  it('кнопка входа заблокирована, пока поля пусты', async () => {
    const wrapper = await mountLogin();
    const button = wrapper.find('button');
    expect(button.attributes('disabled')).toBeDefined();

    await wrapper.find('input[type="text"]').setValue('owner@example.com');
    await wrapper.find('input[type="password"]').setValue('пароль-владельца');
    expect(wrapper.find('button').attributes('disabled')).toBeUndefined();
  });

  it('пароль не показывается на экране', async () => {
    const wrapper = await mountLogin();
    expect(wrapper.find('input[type="password"]').exists()).toBe(true);
  });

  it('ошибку от API показывает текстом, а не молча глотает', async () => {
    stubFetch(401, { error: { code: 'invalid_credentials', message: 'Неверная почта или пароль.' } });
    const wrapper = await mountLogin();
    await wrapper.find('input[type="text"]').setValue('owner@example.com');
    await wrapper.find('input[type="password"]').setValue('мимо');
    await wrapper.find('button').trigger('click');
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('Неверная почта или пароль.');
  });

  it('при блокировке предлагает подождать, а НЕ «восстановить пароль» (его нет)', async () => {
    stubFetch(429, { error: { code: 'login_locked', message: 'Слишком много неудачных попыток. Повторите позже.' } });
    const wrapper = await mountLogin();
    await wrapper.find('input[type="text"]').setValue('brute@example.com');
    await wrapper.find('input[type="password"]').setValue('мимо');
    await wrapper.find('button').trigger('click');
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('попробуйте позже');
    expect(wrapper.text()).not.toMatch(/восстанов|забыли пароль/i);
  });
});
