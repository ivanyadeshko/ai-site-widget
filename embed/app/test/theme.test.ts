import { describe, expect, it } from 'vitest';
import { mountWidget } from './helpers/mount.ts';

describe('оформление панели', () => {
  it('тема из init даёт заголовок панели и акцентный цвет', async () => {
    const { wrapper } = await mountWidget({
      theme: {
        color: '#ff0000', position: 'right', button_label: '🤖',
        title: 'Магазин на связи', launcher_title: 'Спросить консультанта',
      },
    });

    expect(wrapper.find('[data-test="panel-title"]').text()).toBe('Магазин на связи');
    // Акцент — CSS-переменной на корне, а не инлайновым цветом на каждой кнопке:
    // так его подхватывают все элементы панели разом.
    expect(wrapper.find('.widget').attributes('style')).toContain('--vell-accent: #ff0000');
  });

  it('без темы панель работает как раньше: ни заголовка, ни переменной', async () => {
    // Прямое следствие отката образа бэкенда: /config без theme, лоадер шлёт
    // init без неё. Панель обязана остаться рабочей, а не показать «undefined».
    const { wrapper } = await mountWidget();

    expect(wrapper.find('[data-test="panel-title"]').exists()).toBe(false);
    expect(wrapper.find('.widget').attributes('style') ?? '').not.toContain('--vell-accent');
    // Композер на месте — панель функциональна, а не сломана отсутствием темы.
    expect(wrapper.find('textarea').exists() || wrapper.find('input').exists()).toBe(true);
  });
});
