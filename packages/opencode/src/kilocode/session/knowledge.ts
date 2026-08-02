import { Option, Schema, Types } from "effect"

export namespace SessionKnowledge {
  export const Scope = Schema.Struct({
    knowledgeBaseID: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(500),
      Schema.isPattern(/^[A-Za-z0-9_-]+$/),
    ),
    snapshotID: Schema.optional(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500), Schema.isPattern(/^[A-Za-z0-9_-]+$/)),
    ),
  }).annotate({ identifier: "SessionKnowledgeScope" })
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
    return {
      scopes: knowledge.scopes,
      grant: knowledge.grant ?? parent?.grant,
    }
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
        item.knowledgeBaseID === request.knowledgeBaseID &&
        (item.snapshotID === undefined ? request.snapshotID === undefined : item.snapshotID === request.snapshotID),
    )
    if (!scope) {
      throw new Error("The requested Knowledge Base and snapshot are outside this session's Knowledge scope.")
    }
    return knowledge.grant
  }

  export function logged<T extends { knowledge?: Info }>(value: T) {
    if (!value.knowledge?.grant) return value
    return { ...value, knowledge: { scopes: value.knowledge.scopes } }
  }

  function normalize(knowledge: Info): Mutable {
    const seen = new Set<string>()
    const scopes = knowledge.scopes.flatMap((scope) => {
      const id = `${scope.knowledgeBaseID}\0${scope.snapshotID ?? ""}`
      if (seen.has(id)) return []
      seen.add(id)
      return [{ ...scope }]
    })
    return { scopes, ...(knowledge.grant ? { grant: knowledge.grant } : {}) }
  }
}
