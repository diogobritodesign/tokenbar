// Ponto de entrada no GJS: o coletor embutido na extensão do GNOME, para quem
// não instalou o Node. Uso: gjs -m tokenbar-collector.js [--once | ...]
//
// Só importações síncronas aqui em cima: o laço principal tem de começar fora
// de qualquer importação assíncrona, senão ele espera por si mesmo e trava.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

const loop = new GLib.MainLoop(null, false);
let exitCode = 0;

// Rodando dentro da extensão: a entrada padrão é um cano ligado ao
// gnome-shell. Quando ele fecha (o shell saiu), encerramos também.
if (GLib.getenv('TOKENBAR_EXIT_WITH_PARENT')) {
    const stdin = Gio.UnixInputStream.new(0, false);
    const waitForClose = () => stdin.read_bytes_async(4096, GLib.PRIORITY_DEFAULT, null, (stream, result) => {
        let bytes = null;
        try {
            bytes = stream.read_bytes_finish(result);
        } catch {
            bytes = null;
        }
        if (!bytes || bytes.get_size() === 0)
            System.exit(0);
        waitForClose();
    });
    waitForClose();
}

(async () => {
    // A plataforma precisa estar registrada antes dos módulos que a usam.
    const {setPlatform} = await import('../src/platform/index.js');
    const {gjsPlatform} = await import('../src/platform/gjs.js');
    setPlatform(gjsPlatform);
    const {run} = await import('../src/cli.js');
    exitCode = await run(System.programArgs, {print: text => print(text)});
})()
    .catch(error => {
        printerr(`tokenbar: ${error?.message ?? error}`);
        exitCode = 1;
    })
    .finally(() => loop.quit());

loop.run();
System.exit(exitCode);
