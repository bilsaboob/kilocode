import { Image } from "@/image/image" // kilocode_change - classify user image validation defects
import { KiloSessionHttpApi } from "@/kilocode/server/httpapi/session-fork" // kilocode_change
import { SessionKnowledge } from "@/kilocode/session/knowledge" // kilocode_change
import { KiloCompactionBudget } from "@/kilocode/session/compaction-budget" // kilocode_change
import { KiloSessionRecovery } from "@/kilocode/session/recovery" // kilocode_change
import { KiloSessionIdentity } from "@/kilocode/session/identity" // kilocode_change
import { Bus } from "@/bus"
import { Command } from "@/command"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { SessionShare } from "@/share/session"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { NamedError } from "@opencode-ai/core/util/error"
import { Cause, Effect, Latch, Option, Schema, Scope } from "effect" // kilocode_change
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError, HttpApiSchema } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  CommandPayload,
  DiffQuery,
  ForkPayload,
  InitPayload,
  ListQuery,
  MessagesQuery,
  PermissionResponsePayload,
  PermissionGrantPayload, // kilocode_change
  PromptPayload,
  RevertPayload,
  ShellPayload,
  SummarizePayload,
  UpdatePayload,
  ViewedPayload, // kilocode_change
} from "../groups/session"
import { PermissionNotFoundError } from "../errors"
import * as SessionError from "./session-errors"

const tryParseJson = (text: string) =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => new HttpApiError.BadRequest({}),
  })

// kilocode_change start - persistence conflicts are explicit request failures, not accepted no-op writes
const identity = <A, E, R>(work: Effect.Effect<A, E, R>) =>
  work.pipe(
    Effect.catchDefect((error) =>
      error instanceof KiloSessionIdentity.Conflict ? Effect.fail(new HttpApiError.BadRequest({})) : Effect.die(error),
    ),
  )
// kilocode_change end

export const sessionHandlers = HttpApiBuilder.group(InstanceHttpApi, "session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const shareSvc = yield* SessionShare.Service
    const promptSvc = yield* SessionPrompt.Service
    const revertSvc = yield* SessionRevert.Service
    const runState = yield* SessionRunState.Service
    const permissionSvc = yield* Permission.Service
    const statusSvc = yield* SessionStatus.Service
    const todoSvc = yield* Todo.Service
    const summary = yield* SessionSummary.Service
    const bus = yield* Bus.Service
    const scope = yield* Scope.Scope

    // kilocode_change start - hydrate all descendants in batched server-side waves
    const descendants = Effect.fn("SessionHttpApi.descendants")(function* (ids: SessionID[]) {
      const rows = new Map<string, Session.Info>()
      const seen = new Set<SessionID>()
      let batch = ids
      while (batch.length) {
        const parents = batch.filter((id) => !seen.has(id))
        batch = []
        if (parents.length === 0) break
        for (const id of parents) seen.add(id)
        const kids = yield* session.childrenByParent(parents)
        for (const row of kids) {
          if (!rows.has(row.id)) batch.push(row.id)
          rows.set(row.id, row)
        }
      }
      return [...rows.values()]
    })
    // kilocode_change end

    const list = Effect.fn("SessionHttpApi.list")(function* (ctx: { query: typeof ListQuery.Type }) {
      const rows = yield* session.list({
        directory: ctx.query.scope === "project" ? undefined : ctx.query.directory,
        scope: ctx.query.scope,
        path: ctx.query.path,
        roots: ctx.query.roots,
        start: ctx.query.start,
        search: ctx.query.search,
        limit: ctx.query.limit,
      })
      // kilocode_change start - let clients hydrate root session children without browser-side N+1 requests
      if (!ctx.query.includeChildren || rows.length === 0) return rows
      const roots = rows.filter((row) => !row.parentID)
      if (roots.length === 0) return rows
      const kids = yield* descendants(roots.map((row) => row.id))
      const map = new Map<string, Session.Info>()
      for (const row of [...rows, ...kids]) map.set(row.id, row)
      return [...map.values()].sort((a, b) => b.time.updated - a.time.updated)
      // kilocode_change end
    })

    const status = Effect.fn("SessionHttpApi.status")(function* () {
      return Object.fromEntries(yield* statusSvc.list())
    })

    const requireSession = Effect.fn("SessionHttpApi.requireSession")(function* (sessionID: SessionID) {
      return yield* SessionError.mapStorageNotFound(session.get(sessionID))
    })

    const get = Effect.fn("SessionHttpApi.get")(function* (ctx: { params: { sessionID: SessionID } }) {
      return yield* requireSession(ctx.params.sessionID)
    })

    const children = Effect.fn("SessionHttpApi.children")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* session.children(ctx.params.sessionID)
    })

    const todo = Effect.fn("SessionHttpApi.todo")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* todoSvc.get(ctx.params.sessionID)
    })

    const diff = Effect.fn("SessionHttpApi.diff")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof DiffQuery.Type
    }) {
      return yield* summary.diff({ sessionID: ctx.params.sessionID, messageID: ctx.query.messageID })
    })

    const messages = Effect.fn("SessionHttpApi.messages")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof MessagesQuery.Type
    }) {
      if (ctx.query.before && ctx.query.limit === undefined) return yield* new HttpApiError.BadRequest({})
      if (ctx.query.before) {
        const before = ctx.query.before
        yield* Effect.try({
          try: () => MessageV2.cursor.decode(before),
          catch: () => new HttpApiError.BadRequest({}),
        })
      }
      yield* requireSession(ctx.params.sessionID)
      if (ctx.query.limit === undefined || ctx.query.limit === 0) {
        return yield* SessionError.mapStorageNotFound(session.messages({ sessionID: ctx.params.sessionID }))
      }

      const page = yield* SessionError.mapStorageNotFound(
        MessageV2.page({
          sessionID: ctx.params.sessionID,
          limit: ctx.query.limit,
          before: ctx.query.before,
        }),
      )
      if (!page.cursor) return page.items

      const request = yield* HttpServerRequest.HttpServerRequest
      // toURL() honors the Host + x-forwarded-proto headers, so the Link
      // header echoes the real origin instead of a hard-coded localhost.
      const url = Option.getOrElse(HttpServerRequest.toURL(request), () => new URL(request.url, "http://localhost"))
      url.searchParams.set("limit", ctx.query.limit.toString())
      url.searchParams.set("before", page.cursor)
      return HttpServerResponse.jsonUnsafe(page.items, {
        headers: {
          "Access-Control-Expose-Headers": "Link, X-Next-Cursor",
          Link: `<${url.toString()}>; rel="next"`,
          "X-Next-Cursor": page.cursor,
        },
      })
    })

    const message = Effect.fn("SessionHttpApi.message")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      return yield* SessionError.mapStorageNotFound(
        MessageV2.get({ sessionID: ctx.params.sessionID, messageID: ctx.params.messageID }),
      )
    })

    const create = Effect.fn("SessionHttpApi.create")(function* (ctx: { payload?: Session.CreateInput }) {
      return yield* shareSvc.create(ctx.payload)
    })

    const createRaw = Effect.fn("SessionHttpApi.createRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      if (body.trim().length === 0) return yield* create({})

      const json = yield* tryParseJson(body)
      const decoded = yield* Schema.decodeUnknownEffect(Session.CreateInput)(json).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      const payload = decoded
        ? {
            ...decoded,
            permission: decoded.permission ? [...decoded.permission] : undefined,
            knowledge: SessionKnowledge.inherit(undefined, decoded.knowledge), // kilocode_change - mutable normalized API input
          }
        : decoded
      return yield* create({ payload })
    })

    const remove = Effect.fn("SessionHttpApi.remove")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* SessionError.mapStorageNotFound(session.remove(ctx.params.sessionID))
      return true
    })

    const update = Effect.fn("SessionHttpApi.update")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof UpdatePayload.Type
    }) {
      const current = yield* requireSession(ctx.params.sessionID)
      if (ctx.payload.title !== undefined) {
        yield* session.setTitle({ sessionID: ctx.params.sessionID, title: ctx.payload.title })
      }
      // kilocode_change start - keep generic metadata and Knowledge updates atomic while preserving omitted fields
      if (ctx.payload.metadata !== undefined || ctx.payload.knowledge !== undefined) {
        yield* session.setMetadata({
          sessionID: ctx.params.sessionID,
          metadata: ctx.payload.metadata,
          knowledge: ctx.payload.knowledge,
        })
      }
      // kilocode_change end
      if (ctx.payload.permission !== undefined) {
        yield* session.setPermission({
          sessionID: ctx.params.sessionID,
          permission: Permission.merge(current.permission ?? [], ctx.payload.permission),
        })
      }
      if (ctx.payload.time?.archived !== undefined) {
        yield* session.setArchived({ sessionID: ctx.params.sessionID, time: ctx.payload.time.archived })
      }
      return yield* requireSession(ctx.params.sessionID)
    })

    const fork = Effect.fn("SessionHttpApi.fork")(function* (ctx: {
      params: { sessionID: SessionID }
      payload?: typeof ForkPayload.Type
    }) {
      return yield* SessionError.mapStorageNotFound(
        session.fork({
          sessionID: ctx.params.sessionID,
          messageID: ctx.payload?.messageID,
          knowledge: ctx.payload?.knowledge, // kilocode_change
        }),
      )
    })

    const forkRaw = KiloSessionHttpApi.forkRaw(fork) // kilocode_change - carry upstream bodyless full-session fork support

    const abort = Effect.fn("SessionHttpApi.abort")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* promptSvc.cancel(ctx.params.sessionID)
      return true
    })

    const init = Effect.fn("SessionHttpApi.init")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof InitPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* identity(Effect.sync(() => KiloSessionIdentity.prompt({ ...ctx.payload, ...ctx.params }))) // kilocode_change
      yield* promptSvc
        .command({
          sessionID: ctx.params.sessionID,
          messageID: ctx.payload.messageID,
          model: `${ctx.payload.providerID}/${ctx.payload.modelID}`,
          command: Command.Default.INIT,
          arguments: "",
        })
        .pipe(
          identity, // kilocode_change
          Effect.mapError(() => new HttpApiError.BadRequest({})),
        ) // kilocode_change
      return true
    })

    // share/unshare errors aren't all client-induced — storage and network
    // failures from SessionShare are real possibilities. Map to a typed 500
    // (matches the legacy route behavior which routed any failure through
    // ErrorMiddleware → NamedError.Unknown 500) instead of blanket-mapping
    // every failure to a 400 BadRequest.
    const share = Effect.fn("SessionHttpApi.share")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      yield* shareSvc.share(ctx.params.sessionID).pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      return yield* requireSession(ctx.params.sessionID)
    })

    const unshare = Effect.fn("SessionHttpApi.unshare")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      yield* shareSvc
        .unshare(ctx.params.sessionID)
        .pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      return yield* requireSession(ctx.params.sessionID)
    })

    const summarize = Effect.fn("SessionHttpApi.summarize")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof SummarizePayload.Type
    }) {
      // kilocode_change start - claim the runner before cleanup, marker creation, or provider work
      yield* requireSession(ctx.params.sessionID)
      yield* SessionError.mapBusy(
        promptSvc.compact({
          sessionID: ctx.params.sessionID,
          model: {
            providerID: ctx.payload.providerID,
            modelID: ctx.payload.modelID,
          },
          auto: ctx.payload.auto ?? false,
        }),
      )
      // kilocode_change end
      return true
    })

    const prompt = Effect.fn("SessionHttpApi.prompt")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* identity(Effect.sync(() => KiloSessionIdentity.prompt({ ...ctx.payload, ...ctx.params }))) // kilocode_change
      // kilocode_change start - validate protected receipts and recovery before admission.
      if (
        !KiloCompactionBudget.external(ctx.payload.parts) ||
        !KiloSessionRecovery.accept(ctx.params.sessionID, ctx.payload.parts)
      )
        return yield* new HttpApiError.BadRequest({}) // kilocode_change - validate recovery before any admission or persistence
      // kilocode_change end
      const message = yield* promptSvc
        .prompt({ ...ctx.payload, sessionID: ctx.params.sessionID } as unknown as SessionPrompt.PromptInput) // kilocode_change
        .pipe(
          // kilocode_change start - reject only typed user image validation defects as request errors
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause)
            if (
              error instanceof Image.InvalidDataUrlError ||
              error instanceof Image.DecodeError ||
              error instanceof Image.SizeError ||
              error instanceof KiloSessionIdentity.Conflict // kilocode_change
            )
              return Effect.fail(new HttpApiError.BadRequest({}))
            return Effect.die(error)
          }),
          // kilocode_change end
        )
      return HttpServerResponse.stream(Stream.make(JSON.stringify(message)).pipe(Stream.encodeText), {
        contentType: "application/json",
      })
    })

    const promptAsync = Effect.fn("SessionHttpApi.promptAsync")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* identity(Effect.sync(() => KiloSessionIdentity.prompt({ ...ctx.payload, ...ctx.params }))) // kilocode_change - reject known collisions before asynchronous acknowledgement
      // kilocode_change start - asynchronous acknowledgement cannot admit caller-supplied authority.
      if (
        !KiloCompactionBudget.external(ctx.payload.parts) ||
        !KiloSessionRecovery.accept(ctx.params.sessionID, ctx.payload.parts)
      )
        return yield* new HttpApiError.BadRequest({}) // kilocode_change
      // kilocode_change end
      const admitted = yield* Latch.make() // kilocode_change - acknowledge only after per-session admission, not merely fork scheduling
      let entered = false // kilocode_change
      let rejection: Cause.Cause<unknown> | undefined // kilocode_change
      // kilocode_change start - cast to bridge schema-readonly to PromptInput mutable; matches legacy Hono session.ts
      yield* promptSvc
        .prompt({
          ...ctx.payload,
          sessionID: ctx.params.sessionID,
          onAdmitted: () => {
            entered = true
            admitted.openUnsafe()
          },
        } as unknown as SessionPrompt.PromptInput)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              // Denied admission is synchronous; explicit Abort is not a session error.
              if (!entered) {
                rejection = cause
                return
              }
              if (Cause.hasInterruptsOnly(cause)) return
              yield* Effect.logError("prompt_async failed").pipe(
                Effect.annotateLogs({ sessionID: ctx.params.sessionID, cause }),
              )
              yield* bus.publish(Session.Event.Error, {
                sessionID: ctx.params.sessionID,
                error: new NamedError.Unknown({ message: Cause.pretty(cause) }).toObject(),
              })
            }),
          ),
          Effect.onExit(() => admitted.open), // a rejected admission must also release the HTTP waiter
          Effect.forkIn(scope, { startImmediately: true }),
        )
      yield* admitted.await
      if (rejection) return yield* Effect.die(Cause.squash(rejection)) // kilocode_change
      // kilocode_change end
      return HttpApiSchema.NoContent.make()
    })

    const command = Effect.fn("SessionHttpApi.command")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof CommandPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* identity(Effect.sync(() => KiloSessionIdentity.prompt({ ...ctx.payload, ...ctx.params }))) // kilocode_change
      return yield* promptSvc.command({ ...ctx.payload, sessionID: ctx.params.sessionID }).pipe(
        identity, // kilocode_change
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      ) // kilocode_change
    })

    const shell = Effect.fn("SessionHttpApi.shell")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof ShellPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* identity(Effect.sync(() => KiloSessionIdentity.prompt({ ...ctx.payload, ...ctx.params }))) // kilocode_change
      // kilocode_change start - shell identity failures use the same public boundary.
      return yield* SessionError.mapBusy(promptSvc.shell({ ...ctx.payload, sessionID: ctx.params.sessionID })).pipe(
        identity, // kilocode_change
      )
      // kilocode_change end
    })

    const revert = Effect.fn("SessionHttpApi.revert")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof RevertPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* SessionError.mapBusy(revertSvc.revert({ sessionID: ctx.params.sessionID, ...ctx.payload }))
    })

    const unrevert = Effect.fn("SessionHttpApi.unrevert")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* SessionError.mapBusy(revertSvc.unrevert({ sessionID: ctx.params.sessionID }))
    })

    const permissionRespond = Effect.fn("SessionHttpApi.permissionRespond")(function* (ctx: {
      params: { sessionID: SessionID; permissionID: PermissionID }
      payload: typeof PermissionResponsePayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* permissionSvc.reply({ requestID: ctx.params.permissionID, reply: ctx.payload.response }).pipe(
        Effect.catchTag("Permission.NotFoundError", (error) =>
          Effect.fail(
            new PermissionNotFoundError({
              requestID: String(error.requestID),
              message: `Permission request not found: ${error.requestID}`,
            }),
          ),
        ),
      )
      return true
    })

    // kilocode_change start - merge session permissions without returning a full session payload
    const grantPermission = Effect.fn("SessionHttpApi.grantPermission")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PermissionGrantPayload.Type
    }) {
      const current = yield* requireSession(ctx.params.sessionID)
      yield* session.setPermission({
        sessionID: ctx.params.sessionID,
        permission: Permission.merge(current.permission ?? [], ctx.payload.permission),
      })
      return true
    })
    // kilocode_change end

    const deleteMessage = Effect.fn("SessionHttpApi.deleteMessage")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* SessionError.mapBusy(runState.assertNotBusy(ctx.params.sessionID))
      if (!KiloCompactionBudget.mutable(ctx.params)) return yield* new HttpApiError.BadRequest({}) // kilocode_change - cascading deletion must not reset a frozen quota
      yield* session.removeMessage(ctx.params).pipe(identity) // kilocode_change
      return true
    })

    const deletePart = Effect.fn("SessionHttpApi.deletePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      // kilocode_change start - protect admission against concurrent public edits and receipt deletion
      yield* runState.assertNotBusy(ctx.params.sessionID).pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      if (!KiloCompactionBudget.mutable(ctx.params)) return yield* new HttpApiError.BadRequest({})
      // kilocode_change end
      yield* session.removePart(ctx.params).pipe(identity) // kilocode_change
      return true
    })

    const updatePart = Effect.fn("SessionHttpApi.updatePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
      payload: typeof MessageV2.Part.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      // kilocode_change start - receipt authority belongs to internal transactional writes only
      yield* runState.assertNotBusy(ctx.params.sessionID).pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      if (!KiloCompactionBudget.external([ctx.payload]) || !KiloCompactionBudget.mutable(ctx.params))
        return yield* new HttpApiError.BadRequest({})
      // kilocode_change end
      const payload = ctx.payload as MessageV2.Part
      if (
        payload.id !== ctx.params.partID ||
        payload.messageID !== ctx.params.messageID ||
        payload.sessionID !== ctx.params.sessionID
      ) {
        return yield* new HttpApiError.BadRequest({})
      }
      return yield* session.updatePart(payload).pipe(identity) // kilocode_change
    })

    // kilocode_change start
    const viewed = Effect.fn("SessionHttpApi.viewed")(function* (ctx: { payload: typeof ViewedPayload.Type }) {
      const { KiloSessions } = yield* Effect.promise(() => import("@/kilo-sessions/kilo-sessions"))
      KiloSessions.setViewedSessions({ focused: ctx.payload.focused ?? [], open: ctx.payload.open ?? [] })
      return true
    })
    // kilocode_change end

    return handlers
      .handle("list", list)
      .handle("status", status)
      .handle("get", get)
      .handle("children", children)
      .handle("todo", todo)
      .handle("diff", diff)
      .handle("messages", messages)
      .handle("message", message)
      .handleRaw("create", createRaw)
      .handle("remove", remove)
      .handle("update", update)
      .handleRaw("fork", forkRaw) // kilocode_change - carry upstream bodyless full-session fork support
      .handle("abort", abort)
      .handle("init", init)
      .handle("share", share)
      .handle("unshare", unshare)
      .handle("summarize", summarize)
      .handle("prompt", prompt)
      .handle("promptAsync", promptAsync)
      .handle("command", command)
      .handle("shell", shell)
      .handle("revert", revert)
      .handle("unrevert", unrevert)
      .handle("permissionRespond", permissionRespond)
      .handle("grantPermission", grantPermission) // kilocode_change
      .handle("deleteMessage", deleteMessage)
      .handle("deletePart", deletePart)
      .handle("updatePart", updatePart)
      .handle("viewed", viewed) // kilocode_change
  }),
)
