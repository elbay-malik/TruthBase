// The SSR HTML paints without JavaScript, but Chrome fetches module preloads at
// high priority, sharing a slow link with the render-blocking CSS. The page's
// chunks are preloaded at low priority instead; the entry script keeps its own.

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('render:html', (html) => {
    html.head = [lowerModulePreloads(html.head.join(''))]
  })
})
