import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import OriginsEditor from '../src/components/OriginsEditor.vue';

const mountEditor = (origins: string[] = []) => mount(OriginsEditor, { props: { modelValue: origins } });

describe('редактор разрешённых сайтов', () => {
  it('пустой список — это ПРЕДУПРЕЖДЕНИЕ, а не «разрешено всё»', () => {
    // Правило originGuard.ts: пустой allowed_origins = deny. Это осознанное
    // отличие от монолита (Constraint 12), и владелец обязан его ВИДЕТЬ, а не
    // выяснять по молчащему виджету на своём сайте.
    const wrapper = mountEditor([]);
    expect(wrapper.text()).toContain('не будет работать ни на одном сайте');
  });

  it('непустой список предупреждения не показывает', () => {
    const wrapper = mountEditor(['https://shop.example']);
    expect(wrapper.text()).not.toContain('не будет работать ни на одном сайте');
    expect(wrapper.text()).toContain('https://shop.example');
  });

  it('адрес без схемы — подсказка добавить https://, а не молчаливый отказ', async () => {
    const wrapper = mountEditor([]);
    await wrapper.find('input').setValue('shop.example');
    expect(wrapper.text()).toContain('https://');
    expect(wrapper.find('button[data-test="add-origin"]').attributes('disabled')).toBeDefined();
  });

  it('маска * отвергается ДО отправки формы', async () => {
    const wrapper = mountEditor([]);
    await wrapper.find('input').setValue('https://*.shop.example');
    expect(wrapper.text()).toMatch(/Маска/i);
    expect(wrapper.find('button[data-test="add-origin"]').attributes('disabled')).toBeDefined();
  });

  it('корректный адрес добавляется и уезжает наверх нормализованным', async () => {
    const wrapper = mountEditor([]);
    await wrapper.find('input').setValue('https://Shop.Example/path/');
    expect(wrapper.find('button[data-test="add-origin"]').attributes('disabled')).toBeUndefined();
    await wrapper.find('button[data-test="add-origin"]').trigger('click');

    const emitted = wrapper.emitted('update:modelValue');
    expect(emitted).toBeTruthy();
    expect(emitted![0]![0]).toEqual(['https://shop.example']);
  });

  it('дубликат не добавляется дважды', async () => {
    const wrapper = mountEditor(['https://shop.example']);
    await wrapper.find('input').setValue('https://shop.example/');
    expect(wrapper.text()).toMatch(/уже/i);
    expect(wrapper.find('button[data-test="add-origin"]').attributes('disabled')).toBeDefined();
  });
});
