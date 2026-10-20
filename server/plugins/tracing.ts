import { LangfuseSpanProcessor } from '@langfuse/otel'
import { LangfuseVercelAiSdkIntegration } from '@langfuse/vercel-ai-sdk'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { registerTelemetry } from 'ai'

// Phase 10: runtime tracing to Langfuse (TECH_NOTES §15).
//
// Every AI SDK call (embeddings, rewrite, rerank, answer) becomes a Langfuse
// observation through the AI SDK 7 telemetry integration, and the chat route
// and retrieval add their own (`@langfuse/tracing`), so one chat request is
// one trace: question → rewrite → searches → rerank → answer, with tokens
// and latency per step.
//
// Off unless LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set (the SDK's
// standard names; LANGFUSE_BASE_URL picks the region). Without them no tracer
// provider is registered and the observation calls are no-ops. Read from
// process.env at run time, not runtimeConfig, so the keys never sit in a
// build artifact.

export default defineNitroPlugin((nitroApp) => {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY
  const secretKey = process.env.LANGFUSE_SECRET_KEY
  if (!publicKey || !secretKey) {
    console.info('[tracing] LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set: tracing is off')
    return
  }

  const processor = new LangfuseSpanProcessor({
    publicKey,
    secretKey,
    baseUrl: process.env.LANGFUSE_BASE_URL || undefined,
    environment: process.env.LANGFUSE_TRACING_ENVIRONMENT || (import.meta.dev ? 'development' : 'production'),
  })
  // register() also installs the AsyncLocalStorage context manager, which
  // nests AI SDK calls under the active observation across awaits.
  const provider = new NodeTracerProvider({ spanProcessors: [processor] })
  provider.register()
  registerTelemetry(new LangfuseVercelAiSdkIntegration())
  console.info(`[tracing] Langfuse tracing on (${process.env.LANGFUSE_BASE_URL || 'default region'})`)

  // Spans are exported in batches; send what's left on shutdown.
  nitroApp.hooks.hook('close', () => provider.shutdown())
})
