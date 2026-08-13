<script setup lang="ts">
import { computed, ref } from 'vue';

// Лид-форма на ЧУЖОМ сайте собирает PII (§3 спеки), поэтому:
//   — обязательный чекбокс согласия на обработку персональных данных;
//   — минимум один канал связи (телефон ИЛИ почта), иначе лид бесполезен;
//   — при ошибке сервера введённое НЕ теряем (посетитель не наберёт заново).
type LeadFields = { name: string; phone: string; email: string; comment: string; consent: boolean };

const props = defineProps<{ submit: (payload: LeadFields) => Promise<void> }>();
const emit = defineEmits<{ close: [] }>();

const name = ref('');
const phone = ref('');
const email = ref('');
const comment = ref('');
const consent = ref(false);
const status = ref<'form' | 'sending' | 'sent' | 'error'>('form');

const canSubmit = computed(
  () => consent.value && (phone.value.trim() !== '' || email.value.trim() !== '') && status.value !== 'sending',
);

async function onSubmit(): Promise<void> {
  if (!canSubmit.value) return;
  status.value = 'sending';
  try {
    await props.submit({
      name: name.value, phone: phone.value, email: email.value, comment: comment.value, consent: consent.value,
    });
    status.value = 'sent';
  } catch {
    // Значения полей остаются — посетителю не набирать телефон заново.
    status.value = 'error';
  }
}
</script>

<template>
  <div class="lead" data-test="lead-form">
    <template v-if="status === 'sent'">
      <p class="lead__thanks">Спасибо! Мы свяжемся с вами.</p>
      <button type="button" class="lead__btn" data-test="lead-close" @click="emit('close')">Закрыть</button>
    </template>
    <template v-else>
      <input v-model="name" class="lead__field" data-test="lead-name" placeholder="Имя" />
      <input v-model="phone" class="lead__field" data-test="lead-phone" placeholder="Телефон" inputmode="tel" />
      <input v-model="email" class="lead__field" data-test="lead-email" placeholder="Email" inputmode="email" />
      <textarea v-model="comment" class="lead__field" data-test="lead-comment" rows="2" placeholder="Комментарий"></textarea>
      <label class="lead__consent">
        <input type="checkbox" v-model="consent" data-test="lead-consent" />
        <span>Согласен на обработку персональных данных</span>
      </label>
      <p v-if="status === 'error'" class="lead__error" data-test="lead-error">Не удалось отправить, попробуйте ещё раз</p>
      <button type="button" class="lead__btn" data-test="lead-submit" :disabled="!canSubmit" @click="onSubmit">
        Отправить
      </button>
    </template>
  </div>
</template>

<style scoped>
.lead {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid #e9ecef;
  background: #fafbfc;
}
.lead__field {
  padding: 8px 10px;
  border: 1px solid #ced4da;
  border-radius: 10px;
  font: 15px/1.4 system-ui, sans-serif;
  resize: none;
}
.lead__consent {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  font: 13px/1.4 system-ui, sans-serif;
  color: #495057;
}
.lead__error {
  margin: 0;
  font: 13px/1.4 system-ui, sans-serif;
  color: #b00020;
}
.lead__thanks {
  margin: 0;
  font: 15px/1.4 system-ui, sans-serif;
  color: #1b5e20;
}
.lead__btn {
  align-self: flex-start;
  padding: 8px 14px;
  border: none;
  border-radius: 10px;
  background: #2563eb;
  color: #fff;
  font: 600 14px/1 system-ui, sans-serif;
  cursor: pointer;
}
.lead__btn:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
