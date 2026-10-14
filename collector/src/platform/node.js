import { execFile } from 'node:child_process';
import { createReadStream, watch } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

function failure(code) {
  return Object.assign(new Error(code), { code });
}

// Requisição a um servidor local (127.0.0.1) que usa certificado autoassinado.
function localRequest({ method, url, headers, body, timeoutMs }) {
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : http;
  const payload = body === undefined ? undefined : Buffer.from(body);
  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        host: target.hostname,
        port: target.port,
        method,
        path: target.pathname + target.search,
        headers: payload ? { ...headers, 'content-length': payload.length } : headers,
        timeout: timeoutMs,
        rejectUnauthorized: false
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({
          status: response.statusCode,
          header: (name) => response.headers[name.toLowerCase()] ?? null,
          text: Buffer.concat(chunks).toString('utf8')
        }));
      }
    );
    request.on('timeout', () => request.destroy(failure('timeout')));
    request.on('error', (error) => reject(error.code === 'timeout' ? error : failure('network')));
    request.end(payload);
  });
}

export const nodePlatform = {
  name: 'node',
  env: () => process.env,
  home: () => os.homedir(),
  pid: () => process.pid,

  readText: (file) => fs.readFile(file, 'utf8'),
  async writeText(file, text, mode = 0o600) {
    await fs.writeFile(file, text, { mode });
  },
  rename: (from, to) => fs.rename(from, to),
  async mkdirp(dir, mode = 0o700) {
    await fs.mkdir(dir, { recursive: true, mode });
  },
  remove: (file) => fs.rm(file, { force: true }),
  async exists(file) {
    return fs.access(file).then(() => true, () => false);
  },
  // { size, mtimeMs, isFile, isDirectory } ou null se não existe.
  async stat(file) {
    try {
      const info = await fs.stat(file);
      return { size: info.size, mtimeMs: info.mtimeMs, isFile: info.isFile(), isDirectory: info.isDirectory() };
    } catch {
      return null;
    }
  },
  async readdir(dir) {
    try {
      return await fs.readdir(dir);
    } catch {
      return [];
    }
  },
  // Arquivos (não pastas) sob `root` cujo nome termina em `suffix`, em qualquer profundidade.
  async listFiles(root, suffix) {
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true, recursive: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
      .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
  },
  async readRange(file, start, length) {
    const handle = await fs.open(file, 'r');
    try {
      const buffer = new Uint8Array(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },
  async readLines(file, onLine) {
    const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) onLine(line);
  },

  // Devolve { status, header(nome), text }. Falha de rede lança erro com
  // code 'timeout' ou 'network'.
  async request({ method = 'GET', url, headers = {}, body, timeoutMs, insecureLocal = false }) {
    if (insecureLocal) return localRequest({ method, url, headers, body, timeoutMs });
    let response;
    try {
      response = await fetch(url, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw failure(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network');
    }
    let text = '';
    try {
      text = await response.text();
    } catch {
      text = '';
    }
    return { status: response.status, header: (name) => response.headers.get(name), text };
  },

  // Devolve { ok, stdout, stderr, notFound, timedOut }.
  exec(argv, timeoutMs) {
    return new Promise((resolve) => {
      execFile(argv[0], argv.slice(1), { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          notFound: error?.code === 'ENOENT',
          timedOut: Boolean(error?.killed)
        });
      });
    });
  },

  // Chama onChange(nome do arquivo) a cada alteração sob as pastas; devolve a função de parar.
  watchTree(dirs, onChange) {
    const watchers = [];
    for (const dir of dirs) {
      try {
        const watcher = watch(dir, { recursive: true, persistent: false }, (_event, file) => onChange(String(file ?? '')));
        watcher.on('error', () => watcher.close());
        watchers.push(watcher);
      } catch {
        // pasta ausente ou sem permissão
      }
    }
    return () => watchers.forEach((watcher) => watcher.close());
  },

  log: (line) => console.error(line)
};
