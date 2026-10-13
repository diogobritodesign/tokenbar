# Como contribuir

[English](CONTRIBUTING.md) · **Português**

Issues e pull requests são bem-vindos, em português ou inglês. Ao contribuir,
você concorda que a sua contribuição fica sob a
[GPL-3.0-or-later](LICENSE), como o resto do projeto.

## Regras básicas

- **Nunca se passar por outro programa.** O TokenBar lê o que cada ferramenta
  já guarda na sua máquina e se identifica com honestidade (`tokenbar/x.y`).
  Um provedor que só responde a um User-Agent falsificado ou ao cliente OAuth
  de outro aplicativo fica fora do escopo.
- **Somente leitura.** O coletor nunca escreve nos arquivos de uma ferramenta
  e nunca renova o token de outro programa.
- **Nenhum segredo em disco ou em log.** O `tests/collect.test.js` garante
  isso para tudo o que o coletor grava.
- **Nada pesado no processo do shell.** A extensão só lê o `state.json` (de
  forma assíncrona) e desenha; toda leitura de disco e rede fica no coletor.

## Rodando os testes

```sh
npm test                   # coletor + lógica pura de formatação (Node, sem GNOME)
scripts/ui-test.sh         # aciona a extensão de verdade num GNOME Shell headless e isolado
scripts/preview.sh --demo  # abre um shell aninhado com dados de demonstração
```

O `scripts/ui-test.sh` precisa do GNOME Shell 48 ou mais novo instalado. Ele
roda numa sessão D-Bus própria, com pastas temporárias de configuração, cache
e dados, então não toca na sua sessão nem nas suas configurações.

## Adicionando um provedor

1. Crie `collector/src/providers/<nome>.js` exportando uma lista de objetos
   com `id`, `label`, `name`, `exists()`, `fetchLimits()` e `usageToday()`.
   Lance `CollectError(status, mensagem)` com uma mensagem curta para o
   usuário, vinda de `collector/src/i18n.js`.
2. Registre em `listProviders()`, em `collector/src/collect.js`.
3. Exporte a função pura que converte a resposta e cubra em
   `tests/providers.test.js`.

Uma janela tem o formato
`{ kind, label, usedPct, resetsAt, windowMinutes?, group? }`.

## Traduções

Os textos da interface ficam em `extension/tokenbar@tokenbar/lib/i18n.js` e as
mensagens do coletor em `collector/src/i18n.js`, como pares
`[português, inglês]`. O `tests/i18n.test.js` falha se uma chave estiver sem
um dos idiomas, se os marcadores forem diferentes ou se o código usar uma
chave que não está na tabela.

## Atualizando os preços

Os preços da API por modelo ficam em `collector/src/pricing.js`. Atualize a
tabela e a data de conferência juntas, e ajuste `tests/pricing.test.js`.
