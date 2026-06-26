export function escapeHtml(raw: string) {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
export function normalizeUrl(raw: string) {
  return raw.trim().replace(/\s+/g, '')
}