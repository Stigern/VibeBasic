/** Injected by Vite/Vitest `define` from package.json's version. */
declare const __APP_VERSION__: string;

declare module '*.md?raw' {
  const text: string;
  export default text;
}
