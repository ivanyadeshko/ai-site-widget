import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { PanelApi } from '../lib/api.ts';

export type AgentConfig = {
  instructions: string;
  greeting?: string;
  voice_id?: string;
  avatar_id?: string;
};

export type Widget = {
  id: string;
  name: string;
  publish_token: string;
  enabled: boolean;
  allowed_origins: string[];
  agent_config: AgentConfig;
  created_at: string;
  /** Наполняется в Task 13; сейчас бэкенд отдаёт пустую строку. */
  embed_snippet: string;
  app_url: string;
};

export type WidgetDraft = {
  name: string;
  agent_config: AgentConfig;
  allowed_origins: string[];
};

export const useWidgetsStore = defineStore('widgets', () => {
  const items = ref<Widget[]>([]);
  const loading = ref(false);
  const loaded = ref(false);

  const byId = computed(() => (id: string): Widget | undefined => items.value.find((w) => w.id === id));

  async function load(): Promise<Widget[]> {
    loading.value = true;
    try {
      items.value = (await PanelApi.get<{ widgets: Widget[] }>('/widgets')).widgets;
      loaded.value = true;
      return items.value;
    } finally {
      loading.value = false;
    }
  }

  /** Ответ сервера — источник истины: свежий виджет кладём как есть, без домыслов. */
  async function create(draft: WidgetDraft): Promise<Widget> {
    const { widget } = await PanelApi.post<{ widget: Widget }>('/widgets', draft);
    items.value = [widget, ...items.value];
    return widget;
  }

  function replace(widget: Widget): void {
    const index = items.value.findIndex((w) => w.id === widget.id);
    items.value = index === -1
      ? [widget, ...items.value]
      : [...items.value.slice(0, index), widget, ...items.value.slice(index + 1)];
  }

  async function update(id: string, patch: Partial<WidgetDraft> & { enabled?: boolean }): Promise<Widget> {
    const { widget } = await PanelApi.patch<{ widget: Widget }>(`/widgets/${id}`, patch);
    replace(widget);
    return widget;
  }

  async function rotateToken(id: string): Promise<Widget> {
    const { widget } = await PanelApi.post<{ widget: Widget }>(`/widgets/${id}/rotate-token`);
    replace(widget);
    return widget;
  }

  async function remove(id: string): Promise<void> {
    await PanelApi.delete(`/widgets/${id}`);
    items.value = items.value.filter((w) => w.id !== id);
  }

  /** Открытие экрана настройки по прямой ссылке: строки в сторе может ещё не быть. */
  async function fetchOne(id: string): Promise<Widget> {
    const { widget } = await PanelApi.get<{ widget: Widget }>(`/widgets/${id}`);
    replace(widget);
    return widget;
  }

  return { items, loading, loaded, byId, load, create, update, rotateToken, remove, fetchOne };
});
