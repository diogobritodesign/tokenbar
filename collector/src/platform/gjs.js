// Implementação da plataforma para o GJS. Roda num processo separado do
// gnome-shell (filho da extensão), então operações de arquivo síncronas são
// aceitáveis aqui; rede e processos são assíncronos.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function fileOf(path) {
  return Gio.File.new_for_path(path);
}

function walk(dir, visitFile, visitDir) {
  let enumerator;
  try {
    enumerator = fileOf(dir).enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
  } catch {
    return;
  }
  let info;
  while ((info = enumerator.next_file(null))) {
    const child = GLib.build_filenamev([dir, info.get_name()]);
    if (info.get_file_type() === Gio.FileType.DIRECTORY) {
      visitDir?.(child);
      walk(child, visitFile, visitDir);
    } else {
      visitFile?.(child, info.get_name());
    }
  }
  enumerator.close(null);
}

export const gjsPlatform = {
  name: 'gjs',
  env() {
    const env = {};
    for (const name of GLib.listenv()) env[name] = GLib.getenv(name);
    return env;
  },
  home: () => GLib.get_home_dir(),
  pid: () => new Gio.Credentials().get_unix_pid(),

  async readText(path) {
    const [, contents] = fileOf(path).load_contents(null);
    return decoder.decode(contents);
  },
  async writeText(path, text, mode = 0o600) {
    const flags = mode === 0o600 ? Gio.FileCreateFlags.PRIVATE : Gio.FileCreateFlags.NONE;
    fileOf(path).replace_contents(encoder.encode(text), null, false, flags | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
  },
  async rename(from, to) {
    fileOf(from).move(fileOf(to), Gio.FileCopyFlags.OVERWRITE, null, null);
  },
  async mkdirp(dir, mode = 0o700) {
    GLib.mkdir_with_parents(dir, mode);
  },
  async remove(path) {
    try {
      fileOf(path).delete(null);
    } catch {
      // já não existe
    }
  },
  async exists(path) {
    return GLib.file_test(path, GLib.FileTest.EXISTS);
  },
  async stat(path) {
    try {
      const info = fileOf(path).query_info('standard::type,standard::size,time::modified,time::modified-usec', Gio.FileQueryInfoFlags.NONE, null);
      const modified = info.get_modification_date_time();
      return {
        size: info.get_size(),
        mtimeMs: modified ? modified.to_unix() * 1000 + Math.floor(modified.get_microsecond() / 1000) : 0,
        isFile: info.get_file_type() === Gio.FileType.REGULAR,
        isDirectory: info.get_file_type() === Gio.FileType.DIRECTORY
      };
    } catch {
      return null;
    }
  },
  async readdir(dir) {
    const names = [];
    try {
      const enumerator = fileOf(dir).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
      let info;
      while ((info = enumerator.next_file(null))) names.push(info.get_name());
      enumerator.close(null);
    } catch {
      // pasta ausente ou sem permissão
    }
    return names;
  },
  async listFiles(root, suffix) {
    const files = [];
    walk(root, (path, name) => {
      if (name.endsWith(suffix)) files.push(path);
    });
    return files;
  },
  async readRange(path, start, length) {
    const stream = fileOf(path).read(null);
    try {
      stream.seek(start, GLib.SeekType.SET, null);
      return stream.read_bytes(length, null).toArray();
    } finally {
      stream.close(null);
    }
  },
  async readLines(path, onLine) {
    const stream = new Gio.DataInputStream({ base_stream: fileOf(path).read(null) });
    try {
      let line;
      while (([line] = stream.read_line_utf8(null)) && line !== null) onLine(line);
    } finally {
      stream.close(null);
    }
  },

  // Devolve { status, header(nome), text }. Falha de rede lança erro com
  // code 'timeout' ou 'network'.
  async request({ method = 'GET', url, headers = {}, body, timeoutMs, insecureLocal = false }) {
    const session = new Soup.Session({ timeout: Math.max(1, Math.ceil(timeoutMs / 1000)) });
    const message = Soup.Message.new(method, url);
    if (!message) throw failure('network');
    message.set_flags(Soup.MessageFlags.NO_REDIRECT);
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === 'content-type') continue;
      message.request_headers.append(name, String(value));
    }
    if (body !== undefined) {
      message.set_request_body_from_bytes(headers['content-type'] ?? 'application/json', new GLib.Bytes(encoder.encode(body)));
    }
    if (insecureLocal) message.connect('accept-certificate', () => true);
    let bytes;
    try {
      bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
    } catch (error) {
      // TOKENBAR_DEBUG=1 mostra o motivo da falha de rede (a mensagem do GLib não traz credenciais).
      if (GLib.getenv('TOKENBAR_DEBUG')) printerr(`tokenbar: debug: ${url.replace(/\?.*$/, '')}: ${error?.message}`);
      throw failure(error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.TIMED_OUT) ? 'timeout' : 'network');
    }
    return {
      // status_code (número puro): get_status() devolve um enum que não conhece
      // alguns códigos, como o 429, e lança erro ao convertê-lo.
      status: message.status_code,
      header: (name) => message.response_headers.get_one(name),
      text: decoder.decode(bytes.toArray())
    };
  },

  // Devolve { ok, stdout, stderr, notFound, timedOut }.
  async exec(argv, timeoutMs) {
    let process;
    try {
      process = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    } catch (error) {
      const notFound = error?.matches?.(GLib.SpawnError, GLib.SpawnError.NOENT) ?? false;
      return { ok: false, stdout: '', stderr: '', notFound, timedOut: false };
    }
    let timedOut = false;
    const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
      timedOut = true;
      process.force_exit();
      return GLib.SOURCE_REMOVE;
    });
    try {
      const [stdout, stderr] = await process.communicate_utf8_async(null, null);
      return { ok: process.get_successful(), stdout: stdout ?? '', stderr: stderr ?? '', notFound: false, timedOut };
    } catch {
      return { ok: false, stdout: '', stderr: '', notFound: false, timedOut };
    } finally {
      if (!timedOut) GLib.source_remove(timer);
    }
  },

  // Gio.FileMonitor não é recursivo: um monitor por pasta, e pastas criadas
  // depois ganham o seu na hora.
  watchTree(dirs, onChange) {
    const monitors = new Map();
    const add = (dir) => {
      if (monitors.has(dir)) return;
      try {
        const monitor = fileOf(dir).monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
        monitor.connect('changed', (_monitor, file, _other, event) => {
          const path = file.get_path();
          if (event === Gio.FileMonitorEvent.CREATED && GLib.file_test(path, GLib.FileTest.IS_DIR)) {
            add(path);
            walk(path, null, add);
          }
          onChange(file.get_basename() ?? '');
        });
        monitors.set(dir, monitor);
      } catch {
        // pasta ausente ou sem permissão
      }
    };
    for (const dir of dirs) {
      if (!GLib.file_test(dir, GLib.FileTest.IS_DIR)) continue;
      add(dir);
      walk(dir, null, add);
    }
    return () => {
      for (const monitor of monitors.values()) monitor.cancel();
      monitors.clear();
    };
  },

  log: (line) => printerr(line)
};
