import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"
import { SessionID } from "@/session/schema"
import { FileActivity } from "@/kilocode/file-activity"
import { ApiNotFoundError } from "@/server/routes/instance/httpapi/errors"

const root = "/kilocode"

export const RemoveSkillPayload = Schema.Struct({
  location: Schema.String,
})

export const RemoveAgentPayload = Schema.Struct({
  name: Schema.String,
})

export const KilocodePaths = {
  heapSnapshot: `${root}/heap/snapshot`,
  removeSkill: `${root}/skill/remove`,
  removeAgent: `${root}/agent/remove`,
  fileActivity: `/session/:sessionID/file-activity`,
} as const

export const KilocodeApi = HttpApi.make("kilocode")
  .add(
    HttpApiGroup.make("kilocode")
      .add(
        HttpApiEndpoint.post("heapSnapshot", KilocodePaths.heapSnapshot, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.String, "Heap snapshot file path"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.heap.snapshot",
            summary: "Write heap snapshot",
            description: "Write a heap snapshot for the CLI process to the log directory.",
          }),
        ),
        HttpApiEndpoint.post("removeSkill", KilocodePaths.removeSkill, {
          query: WorkspaceRoutingQuery,
          payload: RemoveSkillPayload,
          success: described(Schema.Boolean, "Skill removed"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.removeSkill",
            summary: "Remove a skill",
            description: "Remove a skill by deleting its manifest from disk and clearing it from cache.",
          }),
        ),
        HttpApiEndpoint.post("removeAgent", KilocodePaths.removeAgent, {
          query: WorkspaceRoutingQuery,
          payload: RemoveAgentPayload,
          success: described(Schema.Boolean, "Agent removed"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.removeAgent",
            summary: "Remove a custom agent",
            description:
              "Remove a custom (non-native) agent by deleting its markdown file from disk and refreshing state.",
          }),
        ),
        HttpApiEndpoint.get("fileActivity", KilocodePaths.fileActivity, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(FileActivity.Info), "Session file activity"),
          error: ApiNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.fileActivity",
            summary: "List session file activity",
            description: "List deterministic file reads and changes recorded for a session.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "kilocode",
          description: "Kilo-specific routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "kilo HttpApi",
      version: "0.0.1",
      description: "Kilo HttpApi surface.",
    }),
  )
