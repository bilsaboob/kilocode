import { z } from "zod"
import { KILO_API_BASE, MODELS_FETCH_TIMEOUT_MS } from "./constants.js"
import { getDefaultHeaders } from "../headers.js"

/**
 * Group entry in an organization mode config.
 * Either a simple group name or a tuple for edit with file restrictions.
 */
const EditGroupConfigSchema = z.object({
  fileRegex: z.string().optional(),
  description: z.string().optional(),
})

const GroupEntrySchema = z.union([z.string(), z.tuple([z.string(), EditGroupConfigSchema])])

const OrganizationModeConfigSchema = z.object({
  roleDefinition: z.string().optional(),
  whenToUse: z.string().optional(),
  description: z.string().optional(),
  customInstructions: z.string().optional(),
  groups: z.array(GroupEntrySchema).optional(),
})

const OrganizationModeSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  name: z.string(),
  slug: z.string(),
  created_by: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  config: OrganizationModeConfigSchema,
})

const ResponseSchema = z.object({
  modes: z.array(OrganizationModeSchema),
})

export type OrganizationModeConfig = z.infer<typeof OrganizationModeConfigSchema>
export type OrganizationMode = z.infer<typeof OrganizationModeSchema>

/**
 * In-memory cache for organization modes, scoped to organization and credential authority.
 */
const cache = new Map<string, { modes: OrganizationMode[]; timestamp: number }>()
const pending = new Map<string, { revision: number; task: Promise<OrganizationMode[]> }>()
const TTL = 5 * 60 * 1000 // 5 minutes
let generation = 0

/**
 * Clear the organization modes cache.
 * Should be called when switching organizations.
 */
export function clearModesCache() {
  generation++
  cache.clear()
  pending.clear()
}

/**
 * Fetch custom modes for an organization from the Kilo Cloud API.
 *
 * @param token - Bearer authentication token
 * @param organizationId - Organization UUID
 * @param authority - Optional login-generation identity for callers with durable auth metadata
 * @returns Array of organization modes, or empty array on error
 */
export async function fetchOrganizationModes(
  token: string,
  organizationId: string,
  authority?: string,
): Promise<OrganizationMode[]> {
  const revision = generation
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([organizationId, authority ?? token])),
  )
  const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
  for (const [id, entry] of cache) {
    if (Date.now() - entry.timestamp >= TTL) cache.delete(id)
  }
  const cached = cache.get(key)
  if (cached && Date.now() - cached.timestamp < TTL) {
    return cached.modes
  }

  const active = pending.get(key)
  if (active?.revision === revision) return active.task
  const task = (async () => {
    try {
      const url = `${KILO_API_BASE}/api/organizations/${encodeURIComponent(organizationId)}/modes`
      const response = await fetch(url, {
        headers: {
          ...getDefaultHeaders(),
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS),
      })

      if (!response.ok) {
        return []
      }

      const json = await response.json()
      const parsed = ResponseSchema.safeParse(json)

      if (!parsed.success) {
        return []
      }

      const modes = parsed.data.modes
      if (revision === generation) cache.set(key, { modes, timestamp: Date.now() })
      return modes
    } catch (err) {
      console.warn("[Kilo Gateway] Error fetching organization modes:", err)
      return []
    }
  })()
  if (revision === generation) pending.set(key, { revision, task })
  return task.finally(() => {
    if (pending.get(key)?.task === task) pending.delete(key)
  })
}
