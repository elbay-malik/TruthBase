<script setup lang="ts">
import type { NuxtError } from '#app'

// Every error page Nuxt renders: an address with no page (404), a request
// the server turned down (other 4xx), or a failure (5xx). Status copy in the
// tool's voice (DESIGN.md "Status Messages") under the wordmark, then the way
// back. The error's own message is never shown: a 404's names the address
// the visitor typed, and a server error's can carry internals.
const props = defineProps<{ error: NuxtError }>()

const status = computed(() => props.error.statusCode || 500)
const copy = computed(() => {
  if (status.value === 404) {
    return { title: 'Page not found', description: 'There is no page at this address. Questions are asked on the start page.' }
  }
  if (status.value < 500) {
    return { title: 'Request not accepted', description: `TruthBase couldn’t use this address (error ${status.value}). Check the link, or go to the start page.` }
  }
  return { title: 'Page failed to load', description: `TruthBase couldn’t load this page (error ${status.value}). Try again in a moment, or go to the start page.` }
})

useSeoMeta({ title: () => `${copy.value.title} · TruthBase`, robots: 'noindex' })
</script>

<template>
  <UApp>
    <main class="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-10 px-4 py-6 sm:px-6 sm:py-10">
      <header>
        <p class="font-serif text-[1.75rem] leading-tight font-semibold tracking-tight text-highlighted">
          TruthBase
        </p>
        <p class="text-sm text-muted">
          Ask the documents. Every answer cites its source.
        </p>
      </header>

      <section
        class="flex flex-col gap-2"
        aria-labelledby="error-title"
      >
        <h1
          id="error-title"
          class="text-xl font-semibold text-balance text-highlighted"
        >
          {{ copy.title }}
        </h1>
        <p class="text-pretty text-muted">
          {{ copy.description }}
        </p>
        <!-- A full page load: it leaves the error state behind, with or without JavaScript. -->
        <div class="mt-4 flex flex-wrap gap-3">
          <!-- 44 px touch targets on phones, as in the viewer sheet. -->
          <UButton
            v-if="status >= 500"
            label="Try again"
            icon="i-lucide-rotate-ccw"
            class="min-h-11 sm:min-h-0"
            @click="reloadNuxtApp()"
          />
          <UButton
            to="/"
            external
            label="Go to the start page"
            :color="status >= 500 ? 'neutral' : 'primary'"
            :variant="status >= 500 ? 'outline' : 'solid'"
            class="min-h-11 sm:min-h-0"
          />
        </div>
      </section>
    </main>
  </UApp>
</template>
