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
//
// Serverless (Vercel, ADR-0011): an instance can be frozen or reclaimed once
// its response ends, and Nitro's 'close' hook never runs there. So spans are
// exported as each one ends ('immediate', what Langfuse recommends for
// serverless), and every request asks the platform to wait, after the
// response has gone out, until they are sent: the stream isn't delayed.

export default defineNitroPlugin((nitroApp) => {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY
  const secretKey = process.env.LANGFUSE_SECRET_KEY
  if (!publicKey || !secretKey) {
    console.info('[tracing] LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set: tracing is off')
    return
  }

  const serverless = onVercel()
  const processor = new LangfuseSpanProcessor({
    publicKey,
    secretKey,
    baseUrl: process.env.LANGFUSE_BASE_URL || undefined,
    environment: process.env.LANGFUSE_TRACING_ENVIRONMENT || (import.meta.dev ? 'development' : 'production'),
    exportMode: serverless ? 'immediate' : 'batched',
  })
  // register() also installs the AsyncLocalStorage context manager, which
  // nests AI SDK calls under the active observation across awaits.
  const provider = new NodeTracerProvider({ spanProcessors: [processor] })
  provider.register()
  registerTelemetry(new LangfuseVercelAiSdkIntegration())
  console.info(`[tracing] Langfuse tracing on (${process.env.LANGFUSE_BASE_URL || 'default region'})`)

  if (serverless) {
    nitroApp.hooks.hook('request', (event) => {
      // Read in the request's async context, where Vercel's waitUntil lives.
      const waitUntil = platformWaitUntil()
      if (!waitUntil) return
      const res = event.node.res
      const finished = new Promise<void>(resolve => res.once('close', () => resolve()))
      // One turn of the event loop after the response closes, so a root
      // observation that ends just after its stream (ingest) is included.
      waitUntil(finished
        .then(() => new Promise(resolve => setImmediate(resolve)))
        .then(() => processor.forceFlush())
        .catch(error => console.warn('[tracing] flush failed:', error)))
    })
  }

  // node-server: spans are exported in batches; send what's left on shutdown.
  nitroApp.hooks.hook('close', () => provider.shutdown())
})
