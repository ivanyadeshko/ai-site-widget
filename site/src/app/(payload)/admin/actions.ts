'use server'
import configPromise from '@payload-config'
import { handleServerFunctions } from '@payloadcms/next/layouts'
import type { ServerFunctionClient } from 'payload'
import { importMap } from './importMap'

export const serverFunction: ServerFunctionClient = async (args) => {
  return handleServerFunctions({ ...args, config: configPromise, importMap })
}
