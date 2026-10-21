// The document serif (DESIGN.md "The Light Font Rule") is switched on once the
// page is idle after hydration, so its download never competes with first
// paint; until then the serif voice uses the metric-matched Georgia fallback.
export default defineNuxtPlugin(() => {
  onNuxtReady(() => document.documentElement.classList.add('serif-ready'))
})
