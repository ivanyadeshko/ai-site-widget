<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  NAlert, NButton, NCard, NForm, NFormItem, NInput, NPopconfirm, NSpace, NSpin, NSwitch, NText,
} from 'naive-ui';
import OriginsEditor from '../components/OriginsEditor.vue';
import { useWidgetsStore, type Widget } from '../stores/widgets.ts';
import { PanelApiError } from '../lib/api.ts';

const INSTRUCTIONS_MAX = 8000;
const GREETING_MAX = 500;

const store = useWidgetsStore();
const route = useRoute();
const router = useRouter();

const id = String(route.params.id ?? '');
const widget = ref<Widget | null>(null);
const form = ref({
  name: '', instructions: '', greeting: '', voiceId: '', avatarId: '',
  origins: [] as string[], enabled: true,
});
const error = ref('');
const notice = ref('');
const busy = ref(false);
const deleteConfirmation = ref('');

const apply = (source: Widget): void => {
  widget.value = source;
  form.value = {
    name: source.name,
    instructions: source.agent_config.instructions,
    greeting: source.agent_config.greeting ?? '',
    voiceId: source.agent_config.voice_id ?? '',
    avatarId: source.agent_config.avatar_id ?? '',
    origins: [...source.allowed_origins],
    enabled: source.enabled,
  };
};

const fail = (err: unknown, fallback: string): void => {
  error.value = err instanceof PanelApiError ? err.message : fallback;
};

onMounted(async () => {
  const known = store.byId(id);
  if (known) apply(known);
  try {
    // Даже при попадании в стор перечитываем: экран открывают по прямой ссылке
    // и после правок с другого устройства.
    apply(await store.fetchOne(id));
  } catch (err) {
    fail(err, 'Виджет не найден.');
  }
});

const canSave = computed(() => form.value.name.trim() !== '' && form.value.instructions.trim() !== '' && !busy.value);
const canDelete = computed(() => widget.value !== null && deleteConfirmation.value.trim() === widget.value.name);

async function save(): Promise<void> {
  if (!canSave.value) return;
  error.value = '';
  notice.value = '';
  busy.value = true;
  try {
    apply(await store.update(id, {
      name: form.value.name.trim(),
      agent_config: {
        instructions: form.value.instructions.trim(),
        ...(form.value.greeting.trim() === '' ? {} : { greeting: form.value.greeting.trim() }),
        ...(form.value.voiceId.trim() === '' ? {} : { voice_id: form.value.voiceId.trim() }),
        ...(form.value.avatarId.trim() === '' ? {} : { avatar_id: form.value.avatarId.trim() }),
      },
      allowed_origins: form.value.origins,
      enabled: form.value.enabled,
    }));
    notice.value = 'Сохранено.';
  } catch (err) {
    fail(err, 'Не удалось сохранить виджет.');
  } finally {
    busy.value = false;
  }
}

async function rotate(): Promise<void> {
  error.value = '';
  notice.value = '';
  busy.value = true;
  try {
    apply(await store.rotateToken(id));
    notice.value = 'Токен перевыпущен. Замените сниппет на сайте — старый больше не работает.';
  } catch (err) {
    fail(err, 'Не удалось перевыпустить токен.');
  } finally {
    busy.value = false;
  }
}

async function destroy(): Promise<void> {
  if (!canDelete.value) return;
  busy.value = true;
  try {
    await store.remove(id);
    await router.replace('/');
  } catch (err) {
    fail(err, 'Не удалось удалить виджет.');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <n-spin :show="widget === null && error === ''">
    <n-space vertical size="large">
      <n-alert v-if="error" type="error" :bordered="false" data-test="edit-error">{{ error }}</n-alert>
      <n-alert v-if="notice" type="success" :bordered="false" data-test="edit-notice">{{ notice }}</n-alert>

      <n-card v-if="widget" :title="widget.name">
        <n-form @submit.prevent="save">
          <n-form-item label="Название">
            <div data-test="widget-name"><n-input v-model:value="form.name" /></div>
          </n-form-item>

          <n-form-item :label="`Что агент должен делать (${form.instructions.length} из ${INSTRUCTIONS_MAX})`">
            <div data-test="widget-instructions">
              <n-input
                v-model:value="form.instructions"
                type="textarea"
                :maxlength="INSTRUCTIONS_MAX"
                :autosize="{ minRows: 5 }"
              />
            </div>
          </n-form-item>

          <n-form-item label="Приветствие (необязательно)">
            <n-input v-model:value="form.greeting" :maxlength="GREETING_MAX" placeholder="Здравствуйте! Чем помочь?" />
          </n-form-item>

          <n-form-item label="Голос">
            <n-input v-model:value="form.voiceId" placeholder="оставьте пустым — возьмётся дефолт ядра" />
          </n-form-item>
          <n-form-item label="Аватар">
            <n-input v-model:value="form.avatarId" placeholder="оставьте пустым — возьмётся дефолт ядра" />
          </n-form-item>

          <n-form-item label="Сайты, на которых виджет разрешён">
            <origins-editor v-model="form.origins" />
          </n-form-item>

          <n-form-item label="Включён">
            <n-switch v-model:value="form.enabled" />
          </n-form-item>

          <n-button type="primary" data-test="save-widget" :disabled="!canSave" :loading="busy" @click="save">
            Сохранить
          </n-button>
        </n-form>
      </n-card>

      <n-card v-if="widget" title="Публичный токен">
        <n-space vertical size="small">
          <n-text code>{{ widget.publish_token }}</n-text>
          <!-- Токен НЕ секрет: он лежит в HTML сайта открытым текстом. Владелец
               обязан это знать, иначе перевыпуск будет восприниматься как
               «смена пароля» и делаться зря. -->
          <n-text depth="3">
            Токен не секретный: он виден в исходном коде вашей страницы. Защита от чужих
            сайтов — список разрешённых адресов выше, а не скрытность токена.
          </n-text>
          <n-popconfirm @positive-click="rotate">
            <template #trigger>
              <n-button data-test="rotate-token" :loading="busy">Перевыпустить токен</n-button>
            </template>
            Старый сниппет на сайте перестанет работать сразу же — придётся заменить код на всех страницах.
          </n-popconfirm>
        </n-space>
      </n-card>

      <n-card v-if="widget" title="Удаление">
        <n-space vertical size="small">
          <n-text depth="3">
            Вместе с виджетом навсегда исчезнут его диалоги и лиды. Для подтверждения
            введите название виджета: {{ widget.name }}
          </n-text>
          <div data-test="delete-confirmation">
            <n-input v-model:value="deleteConfirmation" placeholder="Название виджета" />
          </div>
          <n-button type="error" data-test="delete-widget" :disabled="!canDelete" @click="destroy">
            Удалить виджет
          </n-button>
        </n-space>
      </n-card>
    </n-space>
  </n-spin>
</template>
