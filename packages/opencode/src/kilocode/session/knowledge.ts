import { Option, Schema, Types } from "effect"

export namespace SessionKnowledge {
  export const Reference = Schema.Struct({
    kind: Schema.optional(Schema.Literal("knowledge_reference")),
    knowledgeBaseID: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(500),
      Schema.isPattern(/^[A-Za-z0-9_-]+$/),
    ),
    snapshotID: Schema.optional(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500), Schema.isPattern(/^[A-Za-z0-9_-]+$/)),
    ),
  }).annotate({ identifier: "SessionKnowledgeReferenceScope" })
  export type Reference = Schema.Schema.Type<typeof Reference>

  export const Project = Schema.Struct({
    kind: Schema.Literal("project_target_index"),
    projectID: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(500),
      Schema.isPattern(/^[A-Za-z0-9_-]+$/),
    ),
    rootIdentity: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(500),
      Schema.isPattern(/^[A-Za-z0-9_-]+$/),
    ),
  }).annotate({ identifier: "SessionKnowledgeProjectScope" })
  export type Project = Schema.Schema.Type<typeof Project>

  export const Scope = Schema.Union([Reference, Project]).annotate({ identifier: "SessionKnowledgeScope" })
  export type Scope = Schema.Schema.Type<typeof Scope>

  const Grant = Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16_384),
    Schema.isPattern(/^[\x21-\x7e]+$/),
  )

  export const Info = Schema.Struct({
    scopes: Schema.Array(Scope).check(Schema.isMaxLength(32)),
    grant: Schema.optional(Grant),
  }).annotate({ identifier: "SessionKnowledge" })
  export type Info = Schema.Schema.Type<typeof Info>
  export type Mutable = Types.DeepMutable<Info>

  export const key = "kilo.knowledge"
  const decode = Schema.decodeUnknownOption(Info)

  export function split(metadata: Record<string, unknown> | undefined) {
    if (!metadata) return { metadata, knowledge: undefined }
    const rest = { ...metadata }
    const knowledge = Option.getOrUndefined(decode(rest[key]))
    delete rest[key]
    return {
      metadata: Object.keys(rest).length ? rest : undefined,
      knowledge: knowledge ? normalize(knowledge) : undefined,
    }
  }

  export function merge(metadata: Record<string, unknown> | undefined, knowledge: Info | undefined) {
    const result: Record<string, unknown> = { ...metadata }
    delete result[key]
    if (knowledge !== undefined) result[key] = normalize(knowledge)
    return Object.keys(result).length ? result : undefined
  }

  export function inherit(parent: Info | undefined, supplied: Info | undefined) {
    if (supplied === undefined) return parent ? normalize(parent) : undefined
    const knowledge = normalize(supplied)
    if (knowledge.scopes.length === 0) return { scopes: [] }
    if (parent) {
      const allowed = new Set(normalize(parent).scopes.map(identity))
      const scopes = knowledge.scopes.filter((scope) => allowed.has(identity(scope)))
      if (scopes.length === 0) return { scopes: [] }
      return {
        scopes,
        grant: knowledge.grant ?? parent.grant,
      }
    }
    return {
      scopes: knowledge.scopes,
      grant: knowledge.grant,
    }
  }

  export function refresh(current: Info | undefined, supplied: Info) {
    const knowledge = normalize(supplied)
    if (knowledge.scopes.length === 0) return { scopes: [] }
    if (knowledge.grant) return knowledge
    return inherit(current, knowledge)
  }

  export function effective(knowledge: Info | undefined) {
    return knowledge?.grant && knowledge.scopes.length > 0 ? knowledge.scopes : []
  }

  export function visible(tool: string, knowledge: Info | undefined) {
    return (
      !["zen_query_knowledge", "zen_discover_knowledge", "zen_inspect_entity", "zen_read_source"].includes(tool) ||
      effective(knowledge).length > 0
    )
  }

  export function authorize(knowledge: Info | undefined, request: { knowledgeBaseID: string; snapshotID?: string }) {
    if (!knowledge?.grant || effective(knowledge).length === 0) {
      throw new Error("Zen knowledge queries are not authorized for this session.")
    }
    const scope = knowledge.scopes.find(
      (item) =>
        reference(item) &&
        item.knowledgeBaseID === request.knowledgeBaseID &&
        (item.snapshotID === undefined ? request.snapshotID === undefined : item.snapshotID === request.snapshotID),
    )
    if (!scope) {
      throw new Error("The requested Knowledge Base and snapshot are outside this session's Knowledge scope.")
    }
    return knowledge.grant
  }

  export function authorizeProject(knowledge: Info | undefined, request: { projectID: string; rootIdentity: string }) {
    if (!knowledge?.grant || effective(knowledge).length === 0) {
      throw new Error("Zen Project Intelligence queries are not authorized for this session.")
    }
    const scope = knowledge.scopes.find(
      (item) => project(item) && item.projectID === request.projectID && item.rootIdentity === request.rootIdentity,
    )
    if (!scope) throw new Error("The requested Project or root identity is outside this session's Project scope.")
    return knowledge.grant
  }

  export function reference(scope: Scope): scope is Reference {
    return scope.kind === undefined || scope.kind === "knowledge_reference"
  }

  export function project(scope: Scope): scope is Project {
    return scope.kind === "project_target_index"
  }

  export function logged<T extends { knowledge?: Info }>(value: T) {
    if (!value.knowledge?.grant) return value
    return { ...value, knowledge: { scopes: value.knowledge.scopes } }
  }

  function normalize(knowledge: Info): Mutable {
    const seen = new Set<string>()
    const scopes = knowledge.scopes.flatMap((scope) => {
      const value = reference(scope) ? { ...scope, kind: "knowledge_reference" as const } : { ...scope }
      const id = identity(value)
      if (seen.has(id)) return []
      seen.add(id)
      return [value]
    })
    return { scopes, ...(knowledge.grant ? { grant: knowledge.grant } : {}) }
  }

  function identity(scope: Scope) {
    return reference(scope)
      ? `knowledge_reference\0${scope.knowledgeBaseID}\0${scope.snapshotID ?? ""}`
      : `project_target_index\0${scope.projectID}\0${scope.rootIdentity}`
  }
}
