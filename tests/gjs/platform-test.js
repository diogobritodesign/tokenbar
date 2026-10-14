// Testes da implementação GJS da plataforma. Roda com:
//   gjs -m tests/gjs/platform-test.js PORTA PASTA
// (o scripts/gjs-test.sh sobe o servidor local e prepara a pasta).
import GLib from 'gi://GLib';
import System from 'system';

import {gjsPlatform as platform} from '../../collector/src/platform/gjs.js';

const [port, folder] = System.programArgs;
const base = `http://127.0.0.1:${port}`;
let failures = 0;
const check = (label, ok, detail = '') => {
    print(`  ${ok ? 'ok   ' : 'FALHA'} ${label}${ok ? '' : ` ${detail}`}`);
    if (!ok)
        failures += 1;
};
const loop = new GLib.MainLoop(null, false);

(async () => {
    print('Plataforma GJS: rede');
    let response = await platform.request({url: `${base}/ok`, headers: {accept: 'application/json', 'x-teste': 'sim'}, timeoutMs: 5000});
    check('200 com corpo JSON', response.status === 200 && JSON.parse(response.text).ok === true, `${response.status} ${response.text}`);
    check('cabeçalhos enviados chegam ao servidor', JSON.parse(response.text).header === 'sim', response.text);
    response = await platform.request({url: `${base}/limit`, timeoutMs: 5000});
    check('429 vira número, com Retry-After legível', response.status === 429 && response.header('retry-after') === '120', `${response.status} ${response.header('retry-after')}`);
    response = await platform.request({url: `${base}/fail`, timeoutMs: 5000});
    check('500 também', response.status === 500);
    response = await platform.request({method: 'POST', url: `${base}/echo`, headers: {'content-type': 'application/json'}, body: '{"a":1}', timeoutMs: 5000, insecureLocal: true});
    check('POST com corpo', response.status === 200 && response.text === '{"a":1}', response.text);
    response = await platform.request({url: `${base}/redirect`, timeoutMs: 5000});
    check('redirecionamento não é seguido', response.status === 302, String(response.status));
    let error = null;
    try {
        await platform.request({url: `${base}/slow`, timeoutMs: 1000});
    } catch (e) {
        error = e;
    }
    check('demora além do limite vira "timeout"', error?.code === 'timeout', String(error?.code));
    error = null;
    try {
        await platform.request({url: 'http://127.0.0.1:1/', timeoutMs: 2000});
    } catch (e) {
        error = e;
    }
    check('porta fechada vira "network"', error?.code === 'network', String(error?.code));

    print('Plataforma GJS: processos');
    let result = await platform.exec(['sh', '-c', 'echo saida; echo erro >&2; exit 3'], 5000);
    check('captura saída, erro e falha', !result.ok && result.stdout === 'saida\n' && result.stderr === 'erro\n', JSON.stringify(result));
    result = await platform.exec(['comando-que-nao-existe-tokenbar'], 5000);
    check('programa ausente', result.notFound === true, JSON.stringify(result));
    result = await platform.exec(['sleep', '5'], 300);
    check('tempo esgotado encerra o processo', result.timedOut === true && !result.ok, JSON.stringify(result));

    print('Plataforma GJS: arquivos');
    const file = `${folder}/a/b/dados.jsonl`;
    await platform.mkdirp(`${folder}/a/b`);
    await platform.writeText(file, 'linha 1\nlinha 2\nfim', 0o600);
    check('lê o que escreveu', await platform.readText(file) === 'linha 1\nlinha 2\nfim');
    const info = await platform.stat(file);
    check('stat: tamanho, tipo e data', info.size === 19 && info.isFile && !info.isDirectory && Math.abs(info.mtimeMs - Date.now()) < 60000, JSON.stringify(info));
    check('stat de algo ausente é null', await platform.stat(`${folder}/nada`) === null);
    check('lê um trecho em bytes', new TextDecoder().decode(await platform.readRange(file, 8, 7)) === 'linha 2');
    const lines = [];
    await platform.readLines(file, line => lines.push(line));
    check('lê linha a linha', JSON.stringify(lines) === '["linha 1","linha 2","fim"]', JSON.stringify(lines));
    await platform.writeText(`${folder}/a/outro.txt`, 'x');
    check('lista arquivos por sufixo em qualquer profundidade', JSON.stringify(await platform.listFiles(folder, '.jsonl')) === JSON.stringify([file]));
    check('lista uma pasta', JSON.stringify((await platform.readdir(`${folder}/a`)).sort()) === '["b","outro.txt"]');
    await platform.rename(`${folder}/a/outro.txt`, `${folder}/a/renomeado.txt`);
    check('renomeia', await platform.exists(`${folder}/a/renomeado.txt`) && !(await platform.exists(`${folder}/a/outro.txt`)));
    await platform.remove(`${folder}/a/renomeado.txt`);
    check('remove', !(await platform.exists(`${folder}/a/renomeado.txt`)));
    check('ambiente e pasta pessoal', platform.env().HOME === platform.home() && platform.pid() > 1);

    print('Plataforma GJS: observar pastas');
    const seen = [];
    const stop = platform.watchTree([folder], name => seen.push(name));
    await new Promise(resolve => setTimeout(resolve, 200));
    await platform.mkdirp(`${folder}/nova/sub`);
    await new Promise(resolve => setTimeout(resolve, 300));
    await platform.writeText(`${folder}/nova/sub/conversa.jsonl`, '{}\n');
    await new Promise(resolve => setTimeout(resolve, 600));
    stop();
    check('vê arquivo novo dentro de pasta criada depois', seen.includes('conversa.jsonl'), JSON.stringify(seen));
})()
    .catch(error => {
        print(`  FALHA erro inesperado: ${error?.message}\n${error?.stack}`);
        failures += 1;
    })
    .finally(() => loop.quit());

loop.run();
print(failures === 0 ? '\nplataforma GJS: todas as verificações passaram' : `\nplataforma GJS: ${failures} verificação(ões) falharam`);
System.exit(failures);
