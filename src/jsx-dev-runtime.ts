// Development entry for the automatic JSX runtime. esbuild/tsc import this when
// `jsxDev` is enabled; the dev signature carries extra debug args we ignore, so
// `jsxDEV` just forwards to `jsx`.
export * from "./jsx-runtime";
export { jsx as jsxDEV } from "./jsx-runtime";
