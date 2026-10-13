// Preço de tabela da API da Anthropic, em US$ por milhão de tokens.
// Serve para estimar quanto o uso do dia custaria se fosse cobrado por token;
// numa assinatura (Pro/Max) esse valor NÃO é o que se paga.
//
// Conferido em 2026-10-06. Colunas: prefixo do id, entrada, saída, leitura de cache.
const MODELS = [
  ['claude-fable-5', 10, 50, 0.25],
  ['claude-mythos-5', 10, 50, 0.25],
  ['claude-opus-5-5', 4, 20, 0.2],
  ['claude-opus-5', 5, 25, 0.5],
  ['claude-opus-4', 5, 25, 0.5],
  ['claude-sonnet-5', 2, 10, 0.2],
  ['claude-sonnet-4', 3, 15, 0.3],
  ['claude-haiku-5', 0.1, 0.5, 0.01],
  ['claude-haiku-4', 1, 5, 0.1]
];

// Escrita de cache custa um múltiplo do preço de entrada, conforme a duração.
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;

function priceFor(model) {
  const id = String(model || '');
  return MODELS.find(([prefix]) => id.startsWith(prefix)) || null;
}

// Custo em US$ de uma mensagem, ou null quando o modelo não está na tabela.
export function messageCostUsd(model, { input, output, cacheWrite5m, cacheWrite1h, cacheRead }) {
  const price = priceFor(model);
  if (!price) return null;
  const [, inputPrice, outputPrice, cacheReadPrice] = price;
  return (
    (input * inputPrice +
      output * outputPrice +
      cacheWrite5m * inputPrice * CACHE_WRITE_5M +
      cacheWrite1h * inputPrice * CACHE_WRITE_1H +
      cacheRead * cacheReadPrice) /
    1e6
  );
}
