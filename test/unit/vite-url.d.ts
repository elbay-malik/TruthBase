// Vite's `?url` imports, for app/utils/pdf-highlight.ts when a unit test
// typechecks it under tsconfig.scripts.json (no vite/client types there).
declare module '*?url' {
  const url: string
  export default url
}
