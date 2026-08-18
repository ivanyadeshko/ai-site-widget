<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import {
  NAlert, NButton, NCard, NColorPicker, NDivider, NForm, NFormItem, NInput, NPopconfirm, NRadio,
  NRadioGroup, NSpace, NSpin, NSwitch, NText,
} from 'naive-ui';
import OriginsEditor from '../components/OriginsEditor.vue';
import { useWidgetsStore, type Widget, type WidgetTheme } from '../stores/widgets.ts';
import { PanelApiError } from '../lib/api.ts';

const INSTRUCTIONS_MAX = 8000;
const GREETING_MAX = 500;
// Пределы — копия backend/src/widgets/theme.ts. Форма режет ДО запроса: иначе
// про лимит владелец узнаёт из 422 уже после нажатия «Сохранить».
const TITLE_MAX = 40;
const LAUNCHER_TITLE_MAX = 60;
const BUTTON_LABEL_MAX = 2;
const DEFAULT_POSITION = 'right';

const store = useWidgetsStore();
const route = useRoute();
const router = useRouter();

const id = String(route.params.id ?? '');
const widget = ref<Widget | null>(null);
const form = ref({
  name: '', instructions: '', greeting: '', voiceId: '', avatarId: '',
  origins: [] as string[], enabled: true,
  // Оформление. Пустая строка/null = «не задано»: такие поля в PATCH не уезжают
  // вовсе, иначе бэкенд отверг бы пустую строку (invalid_theme), а сохранение
  // формы вморозило бы сегодняшние дефолты в БД.
  themeColor: null as string | null,
  themePosition: DEFAULT_POSITION as 'right' | 'left',
  themeButtonLabel: '',
  themeTitle: '',
  themeLauncherTitle: '',
});
/** Была ли позиция задана явно — чтобы не записать дефолт в БД первым же сохранением. */
const positionStored = ref(false);
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
    themeColor: source.theme.color ?? null,
    themePosition: source.theme.position ?? DEFAULT_POSITION,
    themeButtonLabel: source.theme.button_label ?? '',
    themeTitle: source.theme.title ?? '',
    themeLauncherTitle: source.theme.launcher_title ?? '',
  };
  positionStored.value = source.theme.position !== undefined;
};

/**
 * Тема для PATCH: только реально заполненные поля.
 *
 * Позиция — единственное поле с всегда-непустым контролом (радиогруппа), и без
 * оглядки на `positionStored` она уезжала бы в БД при первом же сохранении
 * даже у владельца, который её не трогал. Дефолты обязаны оставаться на нашей
 * стороне (`backend/src/widgets/theme.ts`), иначе мы теряем право их менять.
 */
const themePayload = (): WidgetTheme => {
  const theme: WidgetTheme = {};
  const color = (form.value.themeColor ?? '').trim();
  if (color !== '') theme.color = color;
  if (positionStored.value || form.value.themePosition !== DEFAULT_POSITION) {
    theme.position = form.value.themePosition;
  }
  const buttonLabel = form.value.themeButtonLabel.trim();
  if (buttonLabel !== '') theme.button_label = buttonLabel;
  const title = form.value.themeTitle.trim();
  if (title !== '') theme.title = title;
  const launcherTitle = form.value.themeLauncherTitle.trim();
  if (launcherTitle !== '') theme.launcher_title = launcherTitle;
  return theme;
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
      theme: themePayload(),
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

          <n-divider title-placement="left">Оформление</n-divider>
          <n-text depth="3">
            Пустое поле означает «по умолчанию» — подставим сами.
          </n-text>

          <n-form-item label="Цвет кнопки">
            <div data-test="theme-color">
              <!-- modes=['hex'] + show-alpha=false: бэкенд принимает строго
                   #RRGGBB, а с альфой пикер отдал бы #RRGGBBAA и получил 422. -->
              <n-color-picker
                v-model:value="form.themeColor"
                :modes="['hex']"
                :show-alpha="false"
                :swatches="['#2563eb', '#0f766e', '#b91c1c', '#7c3aed', '#111827']"
              />
            </div>
          </n-form-item>

          <n-form-item label="Сторона экрана">
            <n-radio-group v-model:value="form.themePosition" data-test="theme-position">
              <n-radio value="right">Справа</n-radio>
              <n-radio value="left">Слева</n-radio>
            </n-radio-group>
          </n-form-item>

          <n-form-item label="Значок на кнопке">
            <div data-test="theme-button-label">
              <n-input v-model:value="form.themeButtonLabel" :maxlength="BUTTON_LABEL_MAX" placeholder="💬" />
            </div>
          </n-form-item>

          <n-form-item label="Заголовок панели">
            <div data-test="theme-title">
              <n-input
                v-model:value="form.themeTitle"
                :maxlength="TITLE_MAX"
                placeholder="по умолчанию — название виджета"
              />
            </div>
          </n-form-item>

          <n-form-item label="Подпись кнопки (её читает скринридер)">
            <div data-test="theme-launcher-title">
              <n-input
                v-model:value="form.themeLauncherTitle"
                :maxlength="LAUNCHER_TITLE_MAX"
                placeholder="по умолчанию — «Открыть чат: заголовок»"
              />
            </div>
          </n-form-item>

          <n-button type="primary" data-test="save-widget" :disabled="!canSave" :loading="busy" @click="save">
            Сохранить
          </n-button>
        </n-form>
      </n-card>

      <n-card v-if="widget" title="Публичный токен">
        <n-space vertical size="small">
          <n-text code>{{ widget.publish_token }}</n-text>
          <router-link data-test="install-link" :to="`/widgets/${widget.id}/install`">
            Как установить виджет на сайт
          </router-link>
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
            Старый код перестанет работать сразу: новые посетители не смогут открыть виджет,
            а уже идущие разговоры оборвутся с ошибкой. Замените сниппет на всех страницах до ротации.
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
