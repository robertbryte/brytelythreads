// Lists the Printify shops your token can see, so you can copy PRINTIFY_SHOP_ID.
// Usage: npm run printify:shops   (reads PRINTIFY_API_TOKEN from .dev.vars)
const token = process.env.PRINTIFY_API_TOKEN;
if (!token) {
  console.error("Set PRINTIFY_API_TOKEN in .dev.vars first.");
  process.exit(1);
}
const res = await fetch("https://api.printify.com/v1/shops.json", {
  headers: { Authorization: `Bearer ${token}`, "User-Agent": "BrytelyThreads-Setup" },
});
if (!res.ok) {
  console.error(`Printify returned HTTP ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const shops = await res.json();
console.table(shops.map((s) => ({ id: s.id, title: s.title, sales_channel: s.sales_channel })));
console.log('\nUse the id of the shop whose sales channel is "custom_integration" (API) as PRINTIFY_SHOP_ID.');
