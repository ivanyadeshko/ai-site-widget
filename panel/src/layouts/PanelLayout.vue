<script setup lang="ts">
import { computed, h } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { NButton, NLayout, NLayoutHeader, NLayoutSider, NMenu, NSpace, NText, type MenuOption } from 'naive-ui';
import { useSessionStore } from '../stores/session.ts';

const session = useSessionStore();
const router = useRouter();
const route = useRoute();

const link = (to: string, label: string) => () => h(RouterLink, { to }, { default: () => label });

const menuOptions = computed<MenuOption[]>(() => {
  const options: MenuOption[] = [
    { label: link('/', 'Виджеты'), key: 'widgets' },
    { label: link('/leads', 'Лиды'), key: 'leads' },
    { label: link('/dialogs', 'Диалоги'), key: 'dialogs' },
    { label: link('/usage', 'Использование'), key: 'usage' },
  ];
  // Раздел админки виден только админу — ровно как и сам API (requireAdmin
  // отвечает 404, а не 403: существование поверхности не подтверждаем).
  // Скрытие пункта — УДОБСТВО, а не защита: барьер стоит на сервере, и
  // подмена `is_admin` в DevTools даст пустой экран с отказом, а не данные.
  if (session.account?.is_admin === true) {
    options.push({
      label: 'Администрирование',
      key: 'admin',
      children: [
        { label: link('/admin/accounts', 'Аккаунты'), key: 'admin-accounts' },
        { label: link('/admin/widgets', 'Виджеты витрины'), key: 'admin-widgets' },
        { label: link('/admin/usage', 'Расход витрины'), key: 'admin-usage' },
      ],
    });
  }
  return options;
});

const activeKey = computed(() => String(route.name ?? ''));

async function logout(): Promise<void> {
  await session.logout();
  await router.replace('/login');
}
</script>

<template>
  <n-layout has-sider style="min-height: 100vh">
    <n-layout-sider bordered :width="220" content-style="padding: 16px">
      <n-space vertical size="large">
        <n-text strong>Vell</n-text>
        <n-menu :options="menuOptions" :value="activeKey" />
      </n-space>
    </n-layout-sider>
    <n-layout>
      <n-layout-header bordered style="padding: 12px 24px">
        <n-space justify="space-between" align="center">
          <n-text depth="3">{{ session.account?.email }}</n-text>
          <n-button quaternary size="small" @click="logout">Выйти</n-button>
        </n-space>
      </n-layout-header>
      <n-layout content-style="padding: 24px">
        <router-view />
      </n-layout>
    </n-layout>
  </n-layout>
</template>
