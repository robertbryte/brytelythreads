/**
 * Printify product descriptions are HTML written in the Printify editor.
 * We keep a tiny allowlist of formatting tags and drop every attribute,
 * so nothing executable can reach the storefront.
 */
const ALLOWED = new Set(["p", "br", "ul", "ol", "li", "strong", "b", "em", "i", "h3", "h4"]);

export function sanitizeHtml(input: string): string {
  if (!input) return "";
  let s = input
    // remove whole dangerous elements including their content
    .replace(/<(script|style|iframe|object|embed|svg|math|template|noscript)[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<\/?([a-zA-Z0-9]+)(\s[^>]*)?>/g, (m, tag: string) => {
    const t = tag.toLowerCase();
    if (!ALLOWED.has(t)) return "";
    const closing = m.startsWith("</");
    return closing ? `</${t}>` : t === "br" ? "<br>" : `<${t}>`;
  });
  // any stray angle brackets left from malformed markup
  s = s.replace(/<(?![/]?(?:p|br|ul|ol|li|strong|b|em|i|h3|h4)>)/gi, "&lt;");
  return s.trim();
}

export function stripHtml(input: string): string {
  return input.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}
