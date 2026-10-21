export default defineAppConfig({
  ui: {
    colors: {
      primary: 'blue',
      // Warm stone, not slate: paper and ink rather than a blue-grey toolkit
      // (DESIGN.md "The Paper and Ink Rule").
      neutral: 'stone',
    },
    button: {
      // Hover states that keep AA text contrast (main.css tokens): the default
      // solid hover (primary/75) drops white text to 4.1:1 light and 4.4:1
      // dark, and the outline hover (error/10) on a subtle error alert's own
      // error/10 tint drops Retry below 4.5:1.
      compoundVariants: [
        { color: 'primary', variant: 'solid', class: 'hover:bg-primary/90 active:bg-primary/90' },
        { color: 'error', variant: 'outline', class: 'hover:bg-error/5 active:bg-error/5' },
      ],
    },
    // Placeholders at AA: the default text-dimmed is 2.5:1 on white and 3.6:1
    // in dark; text-muted is 4.8:1 and 7:1.
    textarea: { slots: { base: 'placeholder:text-muted' } },
    input: { slots: { base: 'placeholder:text-muted' } },
  },
})
