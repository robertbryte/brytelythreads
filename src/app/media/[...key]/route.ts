import { getEnv } from "@/lib/cf";

// Serves product mockups mirrored into R2 (see MIRROR_IMAGES).
export async function GET(_req: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const { key } = await params;
  const path = key.join("/");
  if (!path.startsWith("mockups/") || path.includes("..")) return new Response("Not found", { status: 404 });
  const bucket = getEnv().MEDIA;
  if (!bucket) return new Response("Not found", { status: 404 });
  const obj = await bucket.get(path);
  if (!obj) return new Response("Not found", { status: 404 });
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "image/jpeg",
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: obj.httpEtag,
    },
  });
}
