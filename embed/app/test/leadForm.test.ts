import { describe, expect, it } from 'vitest';
import { mountWidget } from './helpers/mount.ts';

describe('лид-форма', () => {
  it('кнопка отправки заблокирована без согласия', async () => {
    const { wrapper } = await mountWidget();
    await wrapper.find('[data-test=open-lead]').trigger('click');
    await wrapper.find('[data-test=lead-phone]').setValue('+7 900 000-00-00');
    expect(wrapper.find('[data-test=lead-submit]').attributes('disabled')).toBeDefined();
    await wrapper.find('[data-test=lead-consent]').setValue(true);
    expect(wrapper.find('[data-test=lead-submit]').attributes('disabled')).toBeUndefined();
  });

  it('без телефона и почты не отправляется', async () => {
    const { wrapper, api } = await mountWidget();
    await wrapper.find('[data-test=open-lead]').trigger('click');
    await wrapper.find('[data-test=lead-name]').setValue('Пётр');
    await wrapper.find('[data-test=lead-consent]').setValue(true);
    expect(wrapper.find('[data-test=lead-submit]').attributes('disabled')).toBeDefined();
    expect(api.lead).not.toHaveBeenCalled();
  });

  it('успешная отправка шлёт consent:true и показывает благодарность', async () => {
    const { wrapper, api } = await mountWidget();
    await wrapper.find('[data-test=open-lead]').trigger('click');
    await wrapper.find('[data-test=lead-name]').setValue('Пётр');
    await wrapper.find('[data-test=lead-phone]').setValue('+7 900 000-00-00');
    await wrapper.find('[data-test=lead-consent]').setValue(true);
    await wrapper.find('[data-test=lead-submit]').trigger('click');
    expect(api.lead).toHaveBeenCalledWith('d1', expect.any(String), {
      name: 'Пётр', phone: '+7 900 000-00-00', email: '', comment: '', consent: true,
    });
    expect(wrapper.text()).toContain('Спасибо');
  });

  it('ошибка сервера не теряет введённое', async () => {
    const { wrapper, api } = await mountWidget();
    api.lead.mockRejectedValueOnce({ status: 503, code: 'service_unavailable' });
    await wrapper.find('[data-test=open-lead]').trigger('click');
    await wrapper.find('[data-test=lead-phone]').setValue('+7 900 000-00-00');
    await wrapper.find('[data-test=lead-consent]').setValue(true);
    await wrapper.find('[data-test=lead-submit]').trigger('click');
    expect((wrapper.find('[data-test=lead-phone]').element as HTMLInputElement).value).toBe('+7 900 000-00-00');
    expect(wrapper.text()).toContain('Не удалось отправить');
  });
});
