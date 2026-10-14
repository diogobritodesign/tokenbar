import { platform } from './platform/index.js';
import { dirname } from './util/path.js';

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await platform.readText(file));
  } catch {
    return fallback;
  }
}

// Escreve em .tmp e renomeia, para que quem lê nunca veja um arquivo pela metade.
export async function writeJsonAtomic(file, data) {
  await platform.mkdirp(dirname(file), 0o700);
  const tmp = `${file}.${platform.pid()}.tmp`;
  try {
    await platform.writeText(tmp, `${JSON.stringify(data, null, 2)}\n`, 0o600);
    await platform.rename(tmp, file);
  } catch (error) {
    await platform.remove(tmp).catch(() => {});
    throw error;
  }
}

export async function isDirectory(dir) {
  return (await platform.stat(dir))?.isDirectory === true;
}
