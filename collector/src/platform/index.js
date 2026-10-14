// Tudo o que o coletor precisa do sistema (arquivos, rede, processos,
// observar pastas) passa por aqui, para o mesmo código rodar no Node (serviço
// do systemd) e no GJS (embutido na extensão do GNOME).
//
// Cada ambiente registra sua implementação com setPlatform(). No Node isso
// acontece sozinho ao importar este módulo; o ponto de entrada do GJS
// registra a dele antes de importar o resto.
export const platform = {};

export function setPlatform(implementation) {
  Object.assign(platform, implementation);
}

if (globalThis.process?.versions?.node) {
  setPlatform((await import('./node.js')).nodePlatform);
}
