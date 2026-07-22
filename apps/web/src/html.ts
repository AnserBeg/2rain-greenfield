export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const replacements: Record<string, string> = {
      '"': '&quot;',
      '&': '&amp;',
      "'": '&#39;',
      '<': '&lt;',
      '>': '&gt;',
    };
    return replacements[character] ?? character;
  });
}

export function shortIdentity(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
}
