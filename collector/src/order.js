// Ordena contas pela lista gravada nas configurações. Ids ausentes na lista
// ficam no fim, na ordem em que foram descobertos.
export function applyProviderOrder(items, order) {
  if (!Array.isArray(items) || items.length < 2) return items;
  if (!Array.isArray(order) || order.length === 0) return items;
  const rank = new Map(order.map((id, index) => [String(id), index]));
  return [...items].sort((a, b) => {
    const left = rank.has(a?.id) ? rank.get(a.id) : order.length;
    const right = rank.has(b?.id) ? rank.get(b.id) : order.length;
    return left - right;
  });
}

// Garante que todos os ids conhecidos estejam na lista, e remove os que sumiram.
export function mergeProviderOrder(order, ids) {
  const known = ids.map(String);
  const present = new Set(known);
  const kept = (Array.isArray(order) ? order.map(String) : []).filter((id) => present.has(id));
  for (const id of known) {
    if (!kept.includes(id)) kept.push(id);
  }
  return kept;
}

export function moveInOrder(order, id, direction) {
  const list = [...order];
  const index = list.indexOf(String(id));
  const next = index + direction;
  if (index < 0 || next < 0 || next >= list.length) return list;
  [list[index], list[next]] = [list[next], list[index]];
  return list;
}
