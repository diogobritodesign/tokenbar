// Textos da interface em português e inglês. Módulo puro (sem GNOME), para
// também rodar nos testes em Node.

export const STRINGS = {
    // formatação
    'reset.soon': ['reseta em instantes', 'resets any moment'],
    'reset.in': ['reseta em {time}', 'resets in {time}'],
    'age.seconds': ['atualizado há {n} s', 'updated {n} s ago'],
    'age.minutes': ['atualizado há {n} min', 'updated {n} min ago'],
    'age.hours': ['atualizado há {n} h', 'updated {n} h ago'],
    'age.days': ['atualizado há {n} d', 'updated {n} d ago'],
    'pace.exhausted': ['limite atingido', 'limit reached'],
    'pace.runsOut': ['esgota em ~{time}', 'runs out in ~{time}'],

    // painel
    'refresh': ['Atualizar', 'Refresh'],
    'refreshing': ['Atualizando…', 'Refreshing…'],
    'refresh.failed': ['Falhou — tentar de novo', 'Failed — try again'],
    'settings': ['Configurações', 'Settings'],
    'back': ['Voltar', 'Back'],
    'warn.noData': ['sem dados — o coletor ainda não gravou state.json', 'no data — the collector has not written state.json yet'],
    'warn.stale': ['dados desatualizados — coletor parado?', 'stale data — is the collector running?'],
    'warn.noAccounts': ['nenhuma conta encontrada ou habilitada', 'no account found or enabled'],
    'service.incident': ['{name} com instabilidade: {text}', '{name} is having issues: {text}'],
    'summary.title': ['Uso · preço de API', 'Usage · API prices'],
    'period.today': ['Hoje', 'Today'],
    'period.7': ['7 dias', '7 days'],
    'period.30': ['30 dias', '30 days'],
    'tokens': ['tokens', 'tokens'],
    'tokens.today': ['tokens hoje', 'tokens today'],
    'goal': ['meta de {amount} · {pct}% gasto', 'goal of {amount} · {pct}% spent'],
    'remaining': ['restante', 'left'],
    'used': ['usado', 'used'],
    'lastValue': ['{text} — mostrando o último valor', '{text} — showing the last known value'],
    'details.show': ['tokens, modelos e sessões de hoje', 'tokens, models and sessions today'],
    'details.hide': ['ocultar detalhes', 'hide details'],
    'details.tokens': ['Tokens hoje', 'Tokens today'],
    'details.inOut': ['entrada + saída', 'input + output'],
    'details.cacheWrite': ['escrita de cache', 'cache writes'],
    'details.cacheRead': ['leitura de cache', 'cache reads'],
    'details.partialCost': ['custo parcial: há uso de modelo sem preço na tabela', 'partial cost: some usage is from a model with no price in the table'],
    'details.models': ['Modelos hoje', 'Models today'],
    'details.sessions': ['Sessões hoje', 'Sessions today'],
    'unknownModel': ['desconhecido', 'unknown'],
    'noProject': ['sem projeto', 'no project'],

    // configurações
    'set.accounts': ['Contas', 'Accounts'],
    'set.collect': ['coletar', 'collect'],
    'set.inBar': ['na barra', 'in bar'],
    'set.display': ['Exibição', 'Display'],
    'set.language': ['Idioma', 'Language'],
    'lang.auto': ['Sistema', 'System'],
    'lang.pt': ['Português', 'Português'],
    'lang.en': ['English', 'English'],
    'set.blur': ['Desfoque do fundo', 'Background blur'],
    'set.dock': ['Ícone na dock', 'Dock icon'],
    'set.percentages': ['Percentuais', 'Percentages'],
    'display.remaining': ['Restante', 'Left'],
    'display.used': ['Usado', 'Used'],
    'set.currency': ['Moeda do custo', 'Cost currency'],
    'currency.brl': ['Reais (R$)', 'Reais (R$)'],
    'currency.usd': ['Dólares (US$)', 'Dollars ($)'],
    'set.topBar': ['Barra superior', 'Top bar'],
    'set.content': ['Conteúdo', 'Content'],
    'mode.full': ['Completo', 'Full'],
    'mode.dots': ['Só medidor', 'Rings only'],
    'mode.critical': ['Mais crítica', 'Most critical'],
    'set.position': ['Posição', 'Position'],
    'pos.left': ['Esquerda', 'Left'],
    'pos.center': ['Centro', 'Center'],
    'pos.right': ['Direita', 'Right'],
    'set.order': ['Ordem na barra', 'Order in the bar'],
    'set.alerts': ['Alertas', 'Alerts'],
    'set.warnAt': ['Amarelo com uso de', 'Yellow at usage of'],
    'set.critAbove': ['Vermelho com uso acima de', 'Red at usage above'],
    'set.goalDay': ['Meta de gasto por dia', 'Daily spending goal'],
    'set.goalMonth': ['Meta de gasto em 30 dias', '30-day spending goal'],
    'set.none': ['sem', 'off'],
    'set.notifications': ['Notificações', 'Notifications'],
    'set.notificationsHint': ['limite no vermelho, login expirado e meta do dia', 'red threshold, expired login and daily goal'],
    'set.data': ['Coletor e dados', 'Collector and data'],
    'set.interval': ['Intervalo de coleta', 'Collection interval'],
    'set.export': ['Exportar histórico (CSV)', 'Export history (CSV)'],
    'set.shortcut': ['Atalho para abrir o painel: Super + Alt + T', 'Shortcut to open the panel: Super + Alt + T'],

    // notificações
    'notify.exported': ['Histórico exportado', 'History exported'],
    'notify.exportFailed': ['Não foi possível exportar o histórico', 'Could not export the history'],
    'notify.loginExpired': ['{account}: login expirado', '{account}: login expired'],
    'notify.goalHit': ['Meta de gasto do dia atingida', 'Daily spending goal reached'],
    'notify.goalHitMonth': ['Meta de gasto dos 30 dias atingida', '30-day spending goal reached'],
    'notify.goalBody': ['{spent} de {goal}, a preço de API.', '{spent} of {goal}, at API prices.'],
    'notify.over': ['{name}: {pct}% usado', '{name}: {pct}% used'],
    'notify.overBody': ['Passou de {crit}%.', 'Went above {crit}%.'],
    'notify.overBodyReset': ['Passou de {crit}% — {reset}.', 'Went above {crit}% — {reset}.'],
    'notify.freed': ['{name} liberado', '{name} is available again'],
    'notify.freedBody': ['A janela resetou; uso em {pct}%.', 'The window reset; usage is at {pct}%.'],

    // atualizações e sobre
    'update.title': ['Atualização disponível', 'Update available'],
    'update.how': ['para atualizar: git pull && ./install.sh', 'to update: git pull && ./install.sh'],
    'update.auto': ['Um clique baixa e instala a versão nova.', 'One click downloads and installs the new version.'],
    'update.now': ['Atualizar agora', 'Update now'],
    'update.doneNow': ['Pronto! Já está valendo, não precisa sair da sessão.', 'Done! It is already in effect, no need to log out.'],
    'update.running': ['Baixando e instalando…', 'Downloading and installing…'],
    'update.done': ['Pronto! Saia e entre de novo na sessão para o painel novo carregar.', 'Done! Log out and back in to load the new panel.'],
    'update.failed': ['Não deu para atualizar sozinho. No terminal, na pasta do TokenBar: git pull && ./install.sh', 'Could not update automatically. In a terminal, in the TokenBar folder: git pull && ./install.sh'],
    'update.view': ['Ver novidades', 'See what changed'],
    'notify.update': ['TokenBar: atualização disponível', 'TokenBar: update available'],
    'set.about': ['Sobre', 'About'],
    'about.version': ['Versão {version}', 'Version {version}'],
    'about.createdBy': ['Criado por {name}', 'Created by {name}'],
    'about.site': ['Site do autor', "Author's website"],
    'about.code': ['Código no GitHub', 'Code on GitHub'],
    'about.license': ['Licença GPL-3.0', 'GPL-3.0 license'],
    'set.updateCheck': ['Avisar sobre atualizações', 'Notify about updates'],
    'set.updateCheckNow': ['Procurar agora', 'Check now'],
    'set.updateChecking': ['Procurando…', 'Checking…'],
    'set.upToDate': ['Você está na versão mais recente.', 'You are on the latest version.'],
    'set.updateUnknown': ['Instale pelo install.sh para receber avisos de versão nova.', 'Install with install.sh to get notified of new versions.'],

    // janela do app Extensões
    'prefs.title': ['As configurações ficam no painel', 'Settings live in the panel'],
    'prefs.body': [
        'Clique no TokenBar na barra superior (ou Super + Alt + T) e escolha "Configurações".',
        'Click TokenBar in the top bar (or press Super + Alt + T) and choose "Settings".',
    ],
};

export const LANGUAGES = ['pt', 'en'];

let current = 'en';

// 'pt' | 'en' definem o idioma; qualquer outro valor ('auto') segue a lista de
// idiomas do sistema: português se o primeiro for pt*, inglês caso contrário.
export function resolveLanguage(setting, systemLanguages = []) {
    if (LANGUAGES.includes(setting))
        return setting;
    return String(systemLanguages[0] ?? '').toLowerCase().startsWith('pt') ? 'pt' : 'en';
}

export function setLanguage(language) {
    current = LANGUAGES.includes(language) ? language : 'en';
}

export function getLanguage() {
    return current;
}

export function t(key, vars = {}) {
    const entry = STRINGS[key];
    if (!entry)
        return key;
    return entry[LANGUAGES.indexOf(current)].replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''));
}

// Separadores de número do idioma atual: [decimal, milhar].
export function numberSeparators() {
    return current === 'pt' ? [',', '.'] : ['.', ','];
}
