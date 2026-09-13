import { anyApi, type FunctionReturnType } from 'convex/server'
import type { api as backendApi } from '@backend/_generated/api'

/**
 * The backend's generated `api` is `anyApi` behind a type (see packages/backend/convex/_generated/
 * api.js). Rebuilding it here from this app's own copy of `convex` keeps one copy of the library
 * in the bundle while the function names, arguments and return types stay exactly what the backend
 * generated and the desktop app typechecks against.
 */
export const api = anyApi as unknown as typeof backendApi

export type UserDto = FunctionReturnType<typeof api.users.me>
export type InferenceStatus = FunctionReturnType<typeof api.inference.status>
export type StatsDto = FunctionReturnType<typeof api.stats.get>
export type DeviceDto = FunctionReturnType<typeof api.devices.list>[number]
