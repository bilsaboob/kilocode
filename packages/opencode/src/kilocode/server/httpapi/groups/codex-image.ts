import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { CodexImageRequest, CodexImageResponse } from "@/kilocode/image-generation"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"

export const CodexImagePaths = {
  generate: "/codex/image/generate",
} as const

export class CodexImageApiError extends Schema.ErrorClass<CodexImageApiError>("CodexImageApiError")(
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export const CodexImageApi = HttpApi.make("codex-image")
  .add(
    HttpApiGroup.make("codex-image")
      .add(
        HttpApiEndpoint.post("generate", CodexImagePaths.generate, {
          query: WorkspaceRoutingQuery,
          payload: CodexImageRequest,
          success: described(CodexImageResponse, "Codex subscription image generation result"),
          error: CodexImageApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "codexImage.generate",
            summary: "Generate image with Codex",
            description: "Generate one PNG with GPT Image 2 using the connected ChatGPT/Codex subscription.",
          }),
        ),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(OpenApi.annotations({ title: "codex-image", version: "0.0.1" }))
