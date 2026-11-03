<script setup lang="ts">
// What happens to a visitor's question (GDPR Art. 13). Keep in step with
// server/api/chat.post.ts, server/utils/quota.ts and server/plugins/tracing.ts.
useSeoMeta({
  title: 'Privacy · TruthBase',
  description: 'What happens to the questions you ask TruthBase.',
})
</script>

<template>
  <main class="mx-auto max-w-2xl px-6 py-12 text-sm leading-6">
    <h1 class="text-2xl font-semibold">
      Privacy
    </h1>
    <p class="mt-4">
      TruthBase is a portfolio demo. It has no accounts, sets no cookies and runs no analytics. Please don't enter personal data in your questions.
    </p>

    <h2 class="mt-8 text-base font-semibold">
      Who is responsible
    </h2>
    <p class="mt-2">
      Elbay Malikmammadov, Berlin. Address and contact details are in the
      <a
        href="https://elbaymalik.com/de/impressum/"
        class="underline underline-offset-2"
      >Impressum</a>.
    </p>

    <h2 class="mt-8 text-base font-semibold">
      What happens to your question
    </h2>
    <p class="mt-2">
      Your question is sent to these services to find passages and write the answer. Asking is voluntary, but without sending the question there is no answer. The purpose is to answer you and to check the quality of answers. The legal basis is legitimate interest in running and improving the demo (Art. 6(1)(f) GDPR).
    </p>
    <ul class="mt-2 list-disc space-y-2 pl-5">
      <li><strong>Groq</strong> (USA) rewrites the question, ranks the passages and writes the answer. Groq states that it doesn't retain inference data by default, but keeps abuse and reliability logs for up to 30 days.</li>
      <li><strong>Cloudflare Workers AI</strong> (USA) writes the answer when Groq is unavailable. Cloudflare states that it doesn't retain this content after the response or use it for training.</li>
      <li><strong>Google Gemini</strong> (USA) turns the question into a search vector. Google states that it retains prompts for 55 days to detect abuse. This demo uses Google's unpaid tier, for which Google's terms allow use of the content to improve its products and review by people, and its terms set different rules for users in the EEA, Switzerland and the UK.</li>
      <li><strong>Langfuse</strong> records the question, the passages and the answer for quality checks, without your IP address. On the free plan used here, records can be viewed for 30 days, but Langfuse doesn't delete them automatically. They stay stored until they are deleted by hand, which you can ask for.</li>
    </ul>

    <h2 class="mt-8 text-base font-semibold">
      Limits and hosting
    </h2>
    <p class="mt-2">
      Your IP address is used to deliver the site and to apply the demo's limits against abuse. The legal basis is the same legitimate interest.
    </p>
    <ul class="mt-2 list-disc space-y-2 pl-5">
      <li><strong>Supabase</strong> (database in Ireland) counts requests against the daily limits. Each count is stored under a keyed hash of your IP address, never the address itself, and is removed after about three days.</li>
      <li><strong>Vercel</strong> (USA, functions run in Dublin) hosts the site and keeps request logs for about an hour.</li>
    </ul>

    <h2 class="mt-8 text-base font-semibold">
      Transfers outside the EU
    </h2>
    <p class="mt-2">
      Data sent to providers in the USA leaves the EU. Vercel and Cloudflare state that they rely on the EU-U.S. Data Privacy Framework, with standard contractual clauses as a fallback. Groq states that customers can rely on standard contractual clauses. The Google terms that apply here name no specific safeguard.
    </p>

    <h2 class="mt-8 text-base font-semibold">
      Your rights
    </h2>
    <p class="mt-2">
      You can ask for access to your data, and for its correction, deletion or restriction, and you can object to its processing. Questions aren't linked to a person, so it helps to tell me what you asked and when. You can also complain to a supervisory authority, for example the Berliner Beauftragte für Datenschutz und Informationsfreiheit.
    </p>

    <p class="mt-8">
      <NuxtLink
        to="/"
        class="underline underline-offset-2"
      >Back to TruthBase</NuxtLink>
    </p>
  </main>
</template>
