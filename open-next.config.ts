import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// All storefront pages are dynamic (catalog is cached in KV by our own code),
// so the default config is enough. See https://opennext.js.org/cloudflare/caching
// if you later want ISR / incremental cache in R2.
export default defineCloudflareConfig({});
