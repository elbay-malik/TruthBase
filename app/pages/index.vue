<script setup lang="ts">
useSeoMeta({
  title: 'TruthBase',
  description:
    'A verifiable advanced-RAG knowledge base: grounded answers whose citations scroll the PDF to the exact highlighted passage.',
})
</script>

<template>
  <UContainer class="flex min-h-screen flex-col items-center justify-center gap-6 text-center">
    <UBadge variant="subtle" size="lg">
      🚧 Phase 1 — repository bootstrap
    </UBadge>
    <h1 class="text-4xl font-bold">
      TruthBase
    </h1>
    <p class="max-w-xl text-lg text-muted">
      A verifiable advanced-RAG knowledge base: grounded answers with citations
      that scroll the PDF viewer to the exact highlighted passage.
    </p>
    <UButton
      to="https://github.com/EleoXDA/TruthBase"
      target="_blank"
      variant="outline"
    >
      Repository
    </UButton>
  </UContainer>
</template>
