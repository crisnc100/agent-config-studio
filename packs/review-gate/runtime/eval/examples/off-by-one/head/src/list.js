export function last(items, n) {
  return items.slice(items.length - n + 1)
}

export function first(items, n) {
  return items.slice(0, n)
}
