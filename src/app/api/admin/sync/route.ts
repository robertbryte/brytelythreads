import { adminAction } from "@/lib/admin-route";
import { syncCatalog } from "@/lib/catalog";

export const POST = adminAction(async (env) => {
  const r = await syncCatalog(env, "admin");
  return r.ok
    ? `Catalog synced: ${r.upserted} products updated, ${r.removed} removed.`
    : `Sync finished with errors (${r.upserted}/${r.seen} updated): ${r.error ?? "unknown"}`;
});
