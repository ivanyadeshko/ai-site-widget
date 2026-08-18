<script setup lang="ts">
// Naive UI подключается ТОЧЕЧНЫМИ импортами компонентов, без
// unplugin-vue-components: меньше зависимостей и честный typecheck.
import { NConfigProvider, NDialogProvider, NGlobalStyle, NMessageProvider, ruRU, dateRuRU } from 'naive-ui';
</script>

<template>
  <n-config-provider :locale="ruRU" :date-locale="dateRuRU">
    <n-global-style />
    <n-message-provider>
      <n-dialog-provider>
        <router-view />
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>
