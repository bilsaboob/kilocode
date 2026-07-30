import { Layer } from "effect"
import { FetchHttpClient, HttpMiddleware, HttpRouter, HttpServer } from "effect/unstable/http"
import { CorsConfig, isAllowedCorsOrigin, type CorsOptions } from "@/server/cors"
import { compressionLayer } from "@/server/routes/instance/httpapi/middleware/compression"
import { corsVaryFix } from "@/server/routes/instance/httpapi/middleware/cors-vary"
import { errorLayer } from "@/server/routes/instance/httpapi/middleware/error"
import { fenceLayer } from "@/server/routes/instance/httpapi/middleware/fence"

import { agentBuilderHandlers } from "./handlers/agent-builder"
import { backgroundProcessHandlers } from "./handlers/background-process"
import { commitMessageHandlers } from "./handlers/commit-message"
import { codexImageHandlers } from "./handlers/codex-image"
import { configConsoleHandlers } from "./handlers/config-console"
import { enhancePromptHandlers } from "./handlers/enhance-prompt"
import { indexingHandlers } from "./handlers/indexing"
import { kiloGatewayHandlers } from "./handlers/kilo-gateway"
import { kilocodeHandlers } from "./handlers/kilocode"
import { networkHandlers } from "./handlers/network"
import { remoteHandlers } from "./handlers/remote"
import { sandboxHandlers } from "./handlers/sandbox"
import { sessionImportHandlers } from "./handlers/session-import"
import { suggestionHandlers } from "./handlers/suggestion"
import { telemetryHandlers } from "./handlers/telemetry"
import { FileActivity } from "@/kilocode/file-activity"

export const provide = Layer.provide([
  agentBuilderHandlers,
  backgroundProcessHandlers,
  commitMessageHandlers,
  codexImageHandlers,
  configConsoleHandlers,
  enhancePromptHandlers,
  indexingHandlers,
  kiloGatewayHandlers,
  kilocodeHandlers.pipe(Layer.provide(FileActivity.defaultLayer)),
  networkHandlers,
  remoteHandlers,
  sandboxHandlers,
  sessionImportHandlers,
  suggestionHandlers,
  telemetryHandlers,
])

export function provideListener(opts?: CorsOptions) {
  const cors = HttpRouter.middleware(
    HttpMiddleware.cors({
      allowedOrigins: (origin) => isAllowedCorsOrigin(origin, opts),
      maxAge: 86_400,
    }),
    { global: true },
  )
  return Layer.provide([
    errorLayer,
    compressionLayer,
    corsVaryFix,
    fenceLayer,
    cors,
    FetchHttpClient.layer,
    HttpServer.layerServices,
    Layer.succeed(CorsConfig)(opts),
  ])
}
