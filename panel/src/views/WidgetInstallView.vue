<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { NAlert, NButton, NCard, NSpace, NSpin, NText } from 'naive-ui';
import { useWidgetsStore, type Widget } from '../stores/widgets.ts';
import { PanelApiError } from '../lib/api.ts';

const store = useWidgetsStore();
const route = useRoute();

const id = String(route.params.id ?? '');
const widget = ref<Widget | null>(null);
const error = ref('');
const copyState = ref<'' | 'done' | 'failed'>('');

onMounted(async () => {
  const known = store.byId(id);
  if (known) widget.value = known;
  try {
    // Перечитываем всегда: сниппет зависит от токена, а токен могли
    // перевыпустить с другого устройства — показать протухший было бы хуже,
    // чем не показать ничего.
    widget.value = await store.fetchOne(id);
  } catch (err) {
    error.value = err instanceof PanelApiError ? err.message : 'Виджет не найден.';
  }
});

/**
 * Адрес демо-страницы выводится из `app_url` виджета, а не из адреса самой
 * панели: на мультидоменной раскладке (Task 24) SPA живёт на app.vell.pro, а
 * `/demo.html` раздаёт тот же BFF, что и `/app/:token`. Источник истины про
 * этот origin — ответ сервера, а не `location` браузера.
 */
const demoUrl = computed(() => {
  const source = widget.value;
  if (!source) return '';
  try {
    return `${new URL(source.app_url).origin}/demo.html?token=${encodeURIComponent(source.publish_token)}`;
  } catch {
    return '';
  }
});

const hasOrigins = computed(() => (widget.value?.allowed_origins.length ?? 0) > 0);

async function copySnippet(): Promise<void> {
  const snippet = widget.value?.embed_snippet ?? '';
  copyState.value = '';
  try {
    // Буфер обмена доступен только в secure context и только по жесту
    // пользователя. На http-стенде и при отказе в разрешении бросает — молчать
    // об этом нельзя: владелец решит, что скопировалось.
    await navigator.clipboard.writeText(snippet);
    copyState.value = 'done';
  } catch {
    copyState.value = 'failed';
  }
}
</script>

<template>
  <n-spin :show="widget === null && error === ''">
    <n-space vertical size="large">
      <n-alert v-if="error" type="error" :bordered="false" data-test="install-error">{{ error }}</n-alert>

      <n-card v-if="widget" :title="`Установка: ${widget.name}`">
        <n-space vertical size="small">
          <n-text depth="3">Вставьте этот код на все страницы сайта — перед закрывающим &lt;/body&gt;.</n-text>
          <pre class="snippet" data-test="embed-snippet">{{ widget.embed_snippet }}</pre>
          <n-space align="center" size="small">
            <n-button type="primary" data-test="copy-snippet" @click="copySnippet">Скопировать</n-button>
            <n-text v-if="copyState === 'done'" type="success">Сниппет скопирован в буфер обмена.</n-text>
            <n-text v-if="copyState === 'failed'" type="warning">
              Буфер обмена недоступен — скопируйте вручную, выделив код выше.
            </n-text>
          </n-space>
        </n-space>
      </n-card>

      <n-alert v-if="widget && !hasOrigins" type="warning" :bordered="false" data-test="no-origins-warning">
        <!-- Пустой список = deny (осознанное отличие от монолита). Владельцу это
             нужно ОБЪЯСНИТЬ до того, как он полчаса проищет пропавшую кнопку. -->
        Список разрешённых сайтов пуст — виджет сейчас закрыт везде, и кнопка не появится
        ни на одной странице. Добавьте адрес своего сайта в настройках виджета.
      </n-alert>

      <n-card v-if="widget" title="Что дальше">
        <n-space vertical size="small">
          <n-text>
            1. Добавьте адрес своего сайта в
            <a data-test="origins-link" :href="`/widgets/${widget.id}`">список разрешённых сайтов</a>:
            без него виджет не откроется ни у одного посетителя.
          </n-text>
          <n-text>2. Вставьте сниппет перед закрывающим &lt;/body&gt; на всех страницах.</n-text>
          <n-text>
            3. Сниппет можно случайно вставить дважды (так делают CMS) — это безопасно:
            второй запуск лоадера сам себя выключает, второй кнопки не будет.
          </n-text>
          <n-text>
            4. Проверьте вживую: <a data-test="demo-link" :href="demoUrl" target="_blank" rel="noopener">
              откройте демо-страницу с этим токеном</a>.
          </n-text>
          <!-- Тот же текст, что на экране настройки: владелец приходит сюда
               первым и должен понять природу токена до того, как испугается. -->
          <n-text depth="3">
            Токен в сниппете не секрет — он виден в исходном коде вашей страницы. Защита от
            чужих сайтов — список разрешённых сайтов, а не скрытность токена.
          </n-text>
        </n-space>
      </n-card>
    </n-space>
  </n-spin>
</template>

<style scoped>
.snippet {
  margin: 0;
  padding: 12px;
  overflow-x: auto;
  border-radius: 6px;
  background: #f5f5f5;
  font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  /* Сниппет копируют глазами и руками: перенос по словам сломал бы код. */
  white-space: pre;
}
</style>
