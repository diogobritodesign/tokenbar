import os from 'node:os';
import path from 'node:path';

const home = os.homedir();

export const HOME = home;
export const CACHE_DIR = path.join(process.env.XDG_CACHE_HOME || path.join(home, '.cache'), 'tokenbar');
export const STATE_DIR = path.join(process.env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'tokenbar');
export const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'tokenbar');

export const STATE_FILE = path.join(CACHE_DIR, 'state.json');
export const USAGE_CACHE_FILE = path.join(CACHE_DIR, 'usage-cache.json');
export const FX_CACHE_FILE = path.join(CACHE_DIR, 'fx.json');
export const SAMPLES_FILE = path.join(CACHE_DIR, 'samples.json');
export const UPDATE_CACHE_FILE = path.join(CACHE_DIR, 'update.json');
export const STATUS_CACHE_FILE = path.join(CACHE_DIR, 'status.json');
// Histórico não é cache: não dá para reconstruir depois que os transcripts antigos somem.
export const HISTORY_FILE = path.join(STATE_DIR, 'history.json');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
