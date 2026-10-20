export default defineAppConfig({
  ui: {
    colors: {
      primary: 'blue',
      neutral: 'slate',
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
  },
})
