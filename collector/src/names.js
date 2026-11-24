// Nomes e siglas personalizados das contas. O usuário escolhe nas
// configurações; o config.json guarda { id: { name, label } }. O nome padrão
// fica em defaultName/defaultLabel para a interface poder voltar a ele.
const MAX_NAME = 32;
const MAX_LABEL = 5;

function clean(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text ? [...text].slice(0, max).join('') : '';
}

export function normalizeAccountNames(raw) {
  const result = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  for (const [id, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object') continue;
    const name = clean(entry.name, MAX_NAME);
    const label = clean(entry.label, MAX_LABEL).toUpperCase();
    if (name || label) result[id] = { ...(name ? { name } : {}), ...(label ? { label } : {}) };
  }
  return result;
}

export function applyAccountNames(items, names) {
  if (!Array.isArray(items)) return items;
  return items.map((item) => {
    const custom = names?.[item?.id];
    const defaultName = item.defaultName ?? item.name;
    const defaultLabel = item.defaultLabel ?? item.label;
    return {
      ...item,
      name: custom?.name || defaultName,
      label: custom?.label || defaultLabel,
      defaultName,
      defaultLabel
    };
  });
}
