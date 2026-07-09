export function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-');
}

export function money(cents) {
  return '$' + (cents / 100).toFixed(2);
}
