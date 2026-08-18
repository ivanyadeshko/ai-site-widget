import type { components } from '../../../contracts/core-api.d.ts';

export type SessionCreate = components['schemas']['SessionCreate'];
export type SessionCreated = components['schemas']['SessionCreated'];
export type ParticipantToken = components['schemas']['ParticipantToken'];
export type TranscriptMessage = components['schemas']['TranscriptMessage'];
export type TranscriptPage = components['schemas']['TranscriptPage'];
export type CoreSession = components['schemas']['Session'];
export type SessionFinalizedData = components['schemas']['SessionFinalizedData'];
export type WebhookEnvelope = components['schemas']['WebhookEnvelope'];
/**
 * Баланс кредитов ТЕНАНТА, а не аккаунта витрины: для ядра весь виджет-продукт
 * — один тенант (D-1). Админка обязана подписывать эту цифру именно так, иначе
 * оператор прочитает её как баланс конкретного клиента.
 */
export type CreditsBalance = components['schemas']['CreditsBalance'];
