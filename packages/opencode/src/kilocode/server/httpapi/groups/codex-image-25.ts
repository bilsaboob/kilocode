import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { CodexImage25Request, CodexImage25Response } from "@/kilocode/image-generation-25"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"

export const CodexImage25Paths = { generate: "/codex/image/generate-2.5" } as const

export class CodexImage25RequestError extends Schema.ErrorClass<CodexImage25RequestError>("CodexImage25RequestError")(
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class CodexImage25UpstreamError extends Schema.ErrorClass<CodexImage25UpstreamError>(
  "CodexImage25UpstreamError",
)(
  {
    message: Schema.String,
    upstreamStatus: Schema.optional(Schema.Number),
    diagnostics: Schema.optional(CodexImage25Response.fields.diagnostics),
  },
  { httpApiStatus: 502 },
) {}

export const CodexImage25Api = HttpApi.make("codex-image-25")
  .add(
    HttpApiGroup.make("codex-image-25")
      .add(
        HttpApiEndpoint.post("generate", CodexImage25Paths.generate, {
          query: WorkspaceRoutingQuery,
          payload: CodexImage25Request,
          success: described(
            CodexImage25Response,
            "Experimental Codex image result with requested, reported and measured metadata",
          ),
          error: [CodexImage25RequestError, CodexImage25UpstreamError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "codexImage25.generate",
            summary: "Experiment with GPT Image 2.5 through Codex",
            description:
              "Request one PNG using an explicit Flare or Sunburst model ID. Subscription support is experimental; success does not verify model selection. No fallback or retry is performed.",
          }),
        ),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(OpenApi.annotations({ title: "codex-image-25", version: "0.0.1" }))
