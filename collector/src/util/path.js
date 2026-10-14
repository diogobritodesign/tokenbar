// Caminhos POSIX sem depender do Node, para o mesmo código rodar no GJS.
export const sep = '/';

export function join(...parts) {
  const joined = parts.filter((part) => part !== '' && part !== undefined && part !== null).join('/');
  return joined.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
}

export function basename(file) {
  const trimmed = String(file).replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

export function dirname(file) {
  const trimmed = String(file).replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  if (index < 0) return '.';
  return index === 0 ? '/' : trimmed.slice(0, index);
}
