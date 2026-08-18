import config from '@payload-config'
import { getPayload, type Payload } from 'payload'

/** Клиент Payload для server-компонентов и роут-хендлеров лендинга. */
export const getPayloadClient = (): Promise<Payload> => getPayload({ config })
