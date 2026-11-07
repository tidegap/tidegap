/**
 * The `undici` package as the plugin bundle sees it: empty (the build
 * aliases `undici` here). undici reads the process environment, and the
 * bundle must read none (the ClawScan acceptance test), so the core's model
 * calls in this plugin use Node's own `fetch`, with its 300-second wait for
 * response headers.
 */
export {};
