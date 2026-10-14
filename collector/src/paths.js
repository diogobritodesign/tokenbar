import { platform } from './platform/index.js';
import { join } from './util/path.js';

// Calculados na hora (e não na importação) para valerem as variáveis de
// ambiente do momento, inclusive nos testes.
export const home = () => platform.home();

function appDir(variable, fallback) {
  return join(platform.env()[variable] || join(home(), ...fallback), 'tokenbar');
}

export const cacheDir = () => appDir('XDG_CACHE_HOME', ['.cache']);
export const stateDir = () => appDir('XDG_STATE_HOME', ['.local', 'state']);
export const configDir = () => appDir('XDG_CONFIG_HOME', ['.config']);

export const stateFile = () => join(cacheDir(), 'state.json');
export const usageCacheFile = () => join(cacheDir(), 'usage-cache.json');
export const fxCacheFile = () => join(cacheDir(), 'fx.json');
export const samplesFile = () => join(cacheDir(), 'samples.json');
export const updateCacheFile = () => join(cacheDir(), 'update.json');
export const statusCacheFile = () => join(cacheDir(), 'status.json');
// Histórico não é cache: não dá para reconstruir depois que os transcripts antigos somem.
export const historyFile = () => join(stateDir(), 'history.json');
export const configFile = () => join(configDir(), 'config.json');
