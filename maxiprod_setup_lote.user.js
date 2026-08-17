// ==UserScript==
// @name         Maxiprod - ICMS e Setup automático em lote (API)
// @namespace    http://tampermonkey.net/
// @version      4.6
// @description  Consulta o Setup pela API GraphQL e aplica/salva automaticamente os itens selecionados
// @updateURL    https://cdn.jsdelivr.net/gh/3PProjetos/maxiprod-setup@main/maxiprod_setup_lote.user.js
// @downloadURL  https://cdn.jsdelivr.net/gh/3PProjetos/maxiprod-setup@main/maxiprod_setup_lote.user.js
// @match        https://sistema.maxiprod.com.br/*
// @connect      api.maxiprod.com.br
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const API_URL = 'https://api.maxiprod.com.br/graphql/';
  const TOKEN_KEY = 'maxiprod_graphql_token';
  const BTN_INDIVIDUAL_ID = 'tm-acrescimo-icms';
  const BTN_LOTE_ID = 'tm-acrescimo-icms-lote';
  const BTN_TESTE_BG_ID = 'tm-acrescimo-icms-bg-teste';
  // A API do Maxiprod usa o mesmo DbContext em chamadas simultâneas.
  // Manter em 1 evita o erro "A second operation was started...".
  const MAX_CONSULTAS_SIMULTANEAS = 1;
  const SETUPS = [
    { nome: 'ICMS 7%', valor: 136.65 },
    { nome: 'ICMS 12%', valor: 145.70 },
    { nome: 'ICMS 17%', valor: 156.03 }
  ];

  // No modelo interno do Maxiprod estes campos não são booleanos comuns:
  // o POST da própria tela envia "S" ou "N" (um único caractere).
  const CAMPOS_SIM_NAO = new Set([
    'AdicionarPedidoClienteNasInformacoesAdicionais',
    'AlterarQuantidadeUnidadeEstoqueManualmente',
    'ComLancamentoContabil',
    'ComPagamento',
    'ComparaDiferencaPrecoUltimaCompra',
    'GerarLcsAdicionaisMovimentacao',
    'GerarLcsAdicionaisValorItem',
    'IncluirLoteNasInformacoesAdicionaisDoProduto',
    'IncluirNForiginalNasInformacoesAdicionais',
    'IsOperacaoComEntregaFutura',
    'MovimentarEstoque',
    'ReabrirPDIT',
    'RecebeRateioOutrosValores',
    'TemRastreabilidadeDeProduto',
    'TemValorContabil',
    'UnidadeMedidaCompraIndivisivel',
    'UnidadeMedidaEngenhariaIndivisivel',
    'UnidadeMedidaVendaIndivisivel',
    'VaiLivrosFiscaiServico'
  ]);

  // Campos de enumeração que o servidor aceita somente como código de uma letra.
  // O valor do próprio formulário sempre tem prioridade; o padrão só é usado
  // quando o HTML recebido não informa o código interno do componente visual.
  const CAMPOS_CODIGO_UM_CARACTERE = new Set([
    'CFOPEntradaSaida',
    'EntradaSaida',
    'EstadoNotaFiscal',
    'EstadoQuantidadeUnidadeEstoque',
    'Finalidade',
    'ModoAbatimentoTitulo',
    'ModoCalculoQuantidade',
    'Tipo',
    'TipoDestinoMovimentacao',
    'TipoEstocagemItem',
    'TipoFaturamentoOperacaoFiscal',
    'TipoOrigemMovimentacao',
    'TipoPrazoEntrega',
    'ValorFixoDesconto'
  ]);

  const CODIGO_PADRAO_QUANDO_AUSENTE = {
    ModoAbatimentoTitulo: 'Q'
  };

  let loteEmExecucao = false;

  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function esperarCondicao(teste, timeout = 15000, intervalo = 100) {
    const inicio = Date.now();
    while (Date.now() - inicio < timeout) {
      try {
        const resultado = teste();
        if (resultado) return resultado;
      } catch (erro) {
        console.debug('[TM Setup] Aguardando:', erro);
      }
      await wait(intervalo);
    }
    return null;
  }

  function normalizarTexto(texto) {
    return String(texto || '').normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function normalizarCodigo(codigo) {
    return String(codigo || '').trim().toUpperCase();
  }

  function elementoVisivel(elemento) {
    return Boolean(elemento && elemento.isConnected &&
      (elemento.offsetWidth || elemento.offsetHeight || elemento.getClientRects().length));
  }

  function parseBr(valor) {
    if (valor === null || valor === undefined || valor === '') return NaN;
    let texto = String(valor).trim().replace(/[^\d,.-]/g, '');
    if (texto.includes(',')) texto = texto.replace(/\./g, '').replace(',', '.');
    return Number(texto);
  }

  function formatBr(valor, casas = 4) {
    return Number(valor).toLocaleString('pt-BR', {
      minimumFractionDigits: casas,
      maximumFractionDigits: casas
    });
  }

  function formatMoedaBr(valor) {
    return Number(valor).toLocaleString('pt-BR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function extrairPercentualSetup(texto) {
    const encontrado = String(texto || '').match(
      /\[SETUP\s*:\s*(\d+(?:[.,]\d+)?)\]/i
    );
    if (!encontrado) return null;
    const percentual = parseBr(encontrado[1]);
    return Number.isFinite(percentual) && percentual >= 0 ? percentual : null;
  }

  function lerTokenSalvo() {
    return String(GM_getValue(TOKEN_KEY, '') || '').trim();
  }

  function solicitarToken(motivo = '') {
    const token = prompt(
      `${motivo ? `${motivo}\n\n` : ''}` +
      'Cole o token da API GraphQL do Maxiprod.\n\n' +
      'Ele será guardado somente no Tampermonkey deste navegador.',
      ''
    );
    if (token === null) return null;
    const limpo = String(token).trim().replace(/^Basic\s+/i, '');
    if (!limpo) return null;
    GM_setValue(TOKEN_KEY, limpo);
    return limpo;
  }

  function obterToken() {
    return lerTokenSalvo() || solicitarToken();
  }

  function erroDeAutenticacao(mensagem) {
    const texto = normalizarTexto(mensagem);
    return texto.includes('token de acesso') || texto.includes('unauthorized') ||
      texto.includes('nao autorizado') || texto.includes('authentication');
  }

  function executarGraphQL(query, token) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: API_URL,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Basic ${token}`
        },
        data: JSON.stringify({ query }),
        timeout: 30000,
        onload(resposta) {
          let corpo;
          try {
            corpo = JSON.parse(resposta.responseText || '{}');
          } catch (_) {
            reject(new Error(`A API retornou uma resposta inválida (${resposta.status}).`));
            return;
          }

          const mensagens = Array.isArray(corpo.errors)
            ? corpo.errors.map(erro =>
              erro?.extensions?.message || erro?.message || 'Erro desconhecido')
            : [];

          if (resposta.status < 200 || resposta.status >= 300 || mensagens.length) {
            const mensagem = mensagens.join('\n') || `Erro HTTP ${resposta.status}`;
            const erro = new Error(mensagem);
            erro.autenticacao = resposta.status === 401 || erroDeAutenticacao(mensagem);
            reject(erro);
            return;
          }
          resolve(corpo.data || {});
        },
        ontimeout: () => reject(new Error('A consulta à API excedeu 30 segundos.')),
        onerror: () => reject(new Error('Não foi possível conectar à API GraphQL.'))
      });
    });
  }

  function montarConsultaSetup(codigo) {
    return `query BuscarSetup {
      itensDasPropostasDeVenda(
        take: 1
        where: { item: { codigo: { eq: ${JSON.stringify(codigo)} } } }
      ) {
        items { item { codigo observacoesTecnicas } }
      }
    }`;
  }

  async function consultarSetupsComToken(codigos, token) {
    const mapa = new Map();
    let proximoIndice = 0;
    let erroFatal = null;

    async function trabalhador() {
      while (!erroFatal) {
        const indice = proximoIndice++;
        if (indice >= codigos.length) return;

        const codigo = codigos[indice];

        try {
          const dados = await executarGraphQL(montarConsultaSetup(codigo), token);
          const cadastro = dados?.itensDasPropostasDeVenda?.items?.[0]?.item || null;
          const observacoesTecnicas = cadastro?.observacoesTecnicas ?? '';

          mapa.set(codigo, {
            encontrado: Boolean(cadastro),
            observacoesTecnicas,
            percentual: extrairPercentualSetup(observacoesTecnicas),
            erro: ''
          });
        } catch (erro) {
          if (erro.autenticacao) {
            erroFatal = erro;
            throw erro;
          }

          mapa.set(codigo, {
            encontrado: false,
            observacoesTecnicas: '',
            percentual: null,
            erro: erro.message || String(erro)
          });
        }
      }
    }

    const quantidadeTrabalhadores = Math.min(
      MAX_CONSULTAS_SIMULTANEAS,
      codigos.length
    );

    await Promise.all(
      Array.from({ length: quantidadeTrabalhadores }, () => trabalhador())
    );

    return mapa;
  }

  async function consultarSetups(codigosOriginais) {
    const codigos = Array.from(new Set(
      codigosOriginais.map(normalizarCodigo).filter(Boolean)
    ));

    let token = obterToken();
    if (!token) throw new Error('Token da API não informado.');

    try {
      return await consultarSetupsComToken(codigos, token);
    } catch (erro) {
      if (!erro.autenticacao) throw erro;

      GM_deleteValue(TOKEN_KEY);
      token = solicitarToken('O token foi recusado, expirou ou não tem permissão.');
      if (!token) throw new Error('Token da API não informado.');
      return consultarSetupsComToken(codigos, token);
    }
  }

  function buscarPorPrefixo(seletor) {
    const elementos = Array.from(document.querySelectorAll(seletor));
    return elementos.find(elementoVisivel) || elementos.at(-1) || null;
  }

  const getInput = prefixo => buscarPorPrefixo(`input[id^="${prefixo}"]`);
  const getSelect = prefixo => buscarPorPrefixo(`select[id^="${prefixo}"]`);
  const getCheckbox = prefixo =>
    buscarPorPrefixo(`input[type="checkbox"][id^="${prefixo}"]`);

  function encontrarRaizModalDoItem() {
    const quantidade = getInput('Quantidade__');
    if (!quantidade) return null;
    const modal = quantidade.closest('.t-window, [role="dialog"], .ui-dialog, .modal');
    if (modal) return modal;

    let atual = quantidade.parentElement;
    while (atual && atual !== document.body) {
      const texto = normalizarTexto(atual.innerText);
      if (texto.includes('salvar e fechar') && texto.includes('valor unitario')) return atual;
      atual = atual.parentElement;
    }
    return quantidade.closest('form') || document;
  }

  function encontrarInputCodigoItem() {
    const raiz = encontrarRaizModalDoItem();
    if (!raiz) return null;
    const inputs = Array.from(
      raiz.querySelectorAll('input[type="text"], input:not([type])')
    ).filter(input => !input.disabled && !input.readOnly && elementoVisivel(input));

    return inputs.find(input => /^Codigo__/i.test(input.id || input.name || '')) ||
      inputs.find(input => {
        const id = normalizarTexto(`${input.id} ${input.name}`);
        return id.includes('codigo') && !id.includes('externo');
      }) || null;
  }

  function getFormattedElement(input) {
    if (!input) return null;
    const caixa = input.closest('.t-widget, .t-numerictextbox') || input.parentElement;
    return caixa?.querySelector('.t-formatted-value') || null;
  }

  function getFormattedTextFromInput(input) {
    return getFormattedElement(input)?.textContent?.trim() || input?.value || '';
  }

  function setNativeValue(input, valor) {
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input), 'value'
    )?.set;
    if (setter) setter.call(input, valor);
    else input.value = valor;
  }

  function setInputValue(input, valor) {
    if (!input) return false;
    input.focus();
    setNativeValue(input, valor);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    input.blur();

    const formatado = getFormattedElement(input);
    if (formatado) {
      const numero = parseBr(valor);
      formatado.textContent = Number.isFinite(numero) ? formatBr(numero, 2) : valor;
    }
    return true;
  }

  function marcarCheckboxSeNecessario(checkbox) {
    if (!checkbox) return false;
    if (checkbox.checked) return true;
    checkbox.click();
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function selecionarAcrescimoPercentualSeNecessario(select) {
    if (!select) return false;
    const atual = normalizarTexto(select.options?.[select.selectedIndex]?.textContent);
    if (atual.includes('acrescimo') && atual.includes('%')) return true;

    const opcao = Array.from(select.options).find(item => {
      const texto = normalizarTexto(item.textContent);
      return texto.includes('acrescimo') && texto.includes('%');
    });
    if (!opcao) return false;
    select.value = opcao.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function calcularPercentual(quantidade, valorTotal, valorUnitario,
    valorSetup, percentualDoSetup) {
    const acrescimoAplicado = valorSetup * (percentualDoSetup / 100);
    const novoValorUnitario = (valorTotal + acrescimoAplicado) / quantidade;
    return ((novoValorUnitario - valorUnitario) / valorUnitario) * 100;
  }

  async function zerarCampoERecalcular(input) {
    const atual = parseBr(getFormattedTextFromInput(input));
    if (!Number.isFinite(atual) || Math.abs(atual) < 0.000001) return;
    setInputValue(input, '0,0000');
    await wait(180);
  }

  function escolherSetup() {
    const opcoes = SETUPS.map((setup, indice) =>
      `${indice + 1} - ${setup.nome} (R$ ${formatMoedaBr(setup.valor)})`
    ).join('\n');
    const entrada = prompt(`Escolha o ICMS digitando 1, 2 ou 3:\n\n${opcoes}`, '2');
    if (entrada === null) return null;
    const indice = Number(String(entrada).trim()) - 1;
    if (!Number.isInteger(indice) || indice < 0 || indice >= SETUPS.length) {
      alert('Opção inválida. Digite 1, 2 ou 3.');
      return null;
    }
    return SETUPS[indice];
  }

  async function calcularEInserirComSetup(setup, percentualDoSetup) {
    const quantidadeInput = getInput('Quantidade__');
    const valorTotalInput = getInput('ValorTotalSemIPI__');
    const valorUnitarioInput = getInput('ValorUnitarioMoedaOriginal__');
    const acrescimoInput = getInput('AcrescimoDescontoInterno__');

    if (!quantidadeInput || !valorTotalInput || !valorUnitarioInput || !acrescimoInput) {
      return { ok: false, erro: 'Não encontrei os campos da janela do item.' };
    }
    if (!Number.isFinite(percentualDoSetup)) {
      return { ok: false, erro: 'Percentual do Setup inválido.' };
    }

    marcarCheckboxSeNecessario(getCheckbox('PossuiAcrescimoDescontoInterno__'));
    await wait(100);
    const tipoSelect = getSelect('TipoAlteracaoValorUnitario__');
    if (tipoSelect && !selecionarAcrescimoPercentualSeNecessario(tipoSelect)) {
      return { ok: false, erro: 'Não encontrei Acréscimo (%) no campo de seleção.' };
    }
    await wait(100);
    await zerarCampoERecalcular(acrescimoInput);
    await wait(150);

    const quantidade = parseBr(getFormattedTextFromInput(quantidadeInput));
    const valorTotal = parseBr(getFormattedTextFromInput(valorTotalInput));
    const valorUnitario = parseBr(getFormattedTextFromInput(valorUnitarioInput));

    if (!Number.isFinite(quantidade) || quantidade <= 0) {
      return { ok: false, erro: 'Quantidade inválida.' };
    }
    if (!Number.isFinite(valorTotal)) return { ok: false, erro: 'Valor total inválido.' };
    if (!Number.isFinite(valorUnitario) || valorUnitario <= 0) {
      return { ok: false, erro: 'Valor unitário inválido.' };
    }

    const calculado = calcularPercentual(
      quantidade, valorTotal, valorUnitario, setup.valor, percentualDoSetup
    );
    if (!Number.isFinite(calculado)) {
      return { ok: false, erro: 'O percentual calculado é inválido.' };
    }

    const formatado = formatBr(calculado, 4);
    if (!setInputValue(acrescimoInput, formatado)) {
      return { ok: false, erro: 'Não consegui preencher o campo de acréscimo.' };
    }
    await wait(250);
    console.log('[TM Setup] Cálculo concluído:', {
      setup: setup.nome, percentualDoSetup, quantidade, valorTotal,
      valorUnitario, percentualCalculado: calculado
    });
    return { ok: true, percentualCalculado: calculado };
  }

  function encontrarGradeProdutos() {
    const candidatos = Array.from(
      document.querySelectorAll('.t-grid, [class*="grid"], table')
    ).filter(elementoVisivel);

    const gradesCompativeis = [];

    for (const candidato of candidatos) {
      const cabecalho = normalizarTexto(
        Array.from(candidato.querySelectorAll('th')).map(th => th.textContent).join(' ')
      );
      if (cabecalho.includes('codigo') &&
          cabecalho.includes('descricao do produto/servico')) {
        const grade = candidato.closest('.t-grid') || candidato;
        if (elementoVisivel(grade) && !gradesCompativeis.includes(grade)) {
          gradesCompativeis.push(grade);
        }
      }
    }

    return gradesCompativeis.sort((a, b) => {
      const linhasA = a.querySelectorAll('tbody tr').length;
      const linhasB = b.querySelectorAll('tbody tr').length;
      return linhasB - linhasA;
    })[0] || null;
  }

  async function atualizarGradeProdutosSemFechar() {
    const grade = encontrarGradeProdutos();
    if (!grade) return false;

    const candidatos = Array.from(grade.querySelectorAll(
      'a, button, [role="button"], .t-refresh, [class*="refresh"]'
    ));
    const atualizar = candidatos.find(elemento => {
      const descricao = normalizarTexto([
        elemento.textContent,
        elemento.title,
        elemento.getAttribute?.('aria-label'),
        elemento.getAttribute?.('class'),
        elemento.getAttribute?.('href')
      ].join(' '));
      return /atualizar|recarregar|refresh|t-refresh/.test(descricao);
    });

    if (atualizar) {
      const controle = atualizar.closest('a, button, [role="button"]') || atualizar;
      controle.click();
      await wait(1200);
      return true;
    }

    try {
      const pagina = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      const jq = pagina.jQuery;
      const instancia = jq && (jq(grade).data('tGrid') || jq(grade).data('kendoGrid'));

      if (typeof instancia?.ajaxRequest === 'function') {
        instancia.ajaxRequest();
        await wait(1200);
        return true;
      }
      if (typeof instancia?.dataSource?.read === 'function') {
        await instancia.dataSource.read();
        instancia.refresh?.();
        await wait(500);
        return true;
      }
    } catch (erro) {
      console.warn('[TM Setup BG] Não foi possível atualizar a grade:', erro);
    }

    return false;
  }

  function obterMapaColunas(grade) {
    const textos = Array.from(grade.querySelectorAll('thead th'))
      .map(th => normalizarTexto(th.textContent));
    let codigo = textos.findIndex(texto => texto === 'codigo');
    let numero = textos.findIndex(texto => texto === '#');
    if (codigo < 0) codigo = textos.findIndex(texto => texto.includes('codigo'));
    if (numero < 0) numero = textos.findIndex(texto => texto.endsWith('#'));
    return { codigo, numero };
  }

  function obterLinhasDaGrade(grade) {
    return Array.from(grade.querySelectorAll('tbody tr'))
      .filter(linha => linha.querySelectorAll('td').length > 0)
      .filter(elementoVisivel);
  }

  function lerItemDaLinha(linha, mapa) {
    const celulas = Array.from(linha.querySelectorAll(':scope > td'));
    if (!celulas.length) return null;
    const checkbox = linha.querySelector('input[type="checkbox"]');
    const celulaCodigo = mapa.codigo >= 0 ? celulas[mapa.codigo] :
      celulas.find(celula => /[A-Z0-9]+-[A-Z0-9-]+/i.test(celula.innerText));
    if (!celulaCodigo) return null;

    const textoNumero = mapa.numero >= 0 ? celulas[mapa.numero]?.innerText : '';
    return {
      linha,
      checkbox,
      codigo: normalizarCodigo(celulaCodigo.innerText),
      numero: String(textoNumero || '').match(/\d+/)?.[0] || ''
    };
  }

  function obterItensSelecionados() {
    const grade = encontrarGradeProdutos();
    if (!grade) return { itens: [], erro: 'Não encontrei a grade Produtos/serviços.' };
    const mapa = obterMapaColunas(grade);
    const itens = obterLinhasDaGrade(grade).map(linha => lerItemDaLinha(linha, mapa))
      .filter(item => item?.checkbox?.checked)
      .map(item => ({ codigo: item.codigo, numero: item.numero }));
    return { itens, erro: null };
  }

  function localizarLinhaDoItem(item) {
    const grade = encontrarGradeProdutos();
    if (!grade) return null;
    const mapa = obterMapaColunas(grade);
    const candidatos = obterLinhasDaGrade(grade).map(linha => lerItemDaLinha(linha, mapa))
      .filter(Boolean).filter(atual => atual.codigo === item.codigo);
    if (item.numero) {
      const exato = candidatos.find(atual => atual.numero === item.numero);
      if (exato) return exato.linha;
    }
    return candidatos[0]?.linha || null;
  }

  function encontrarControleEditar(linha) {
    const seletores = [
      'a.t-grid-edit', '.t-grid-edit', 'a[title*="Editar" i]',
      'button[title*="Editar" i]', 'a[aria-label*="Editar" i]',
      'button[aria-label*="Editar" i]', 'a[class*="edit" i]',
      'button[class*="edit" i]'
    ];
    for (const seletor of seletores) {
      const encontrado = linha.querySelector(seletor);
      if (encontrado) return encontrado.closest('a, button, [onclick]') || encontrado;
    }

    for (const elemento of linha.querySelectorAll('a, button, [onclick], img, span')) {
      const descricao = normalizarTexto([
        elemento.title, elemento.getAttribute?.('aria-label'),
        elemento.getAttribute?.('alt'), elemento.getAttribute?.('src'),
        elemento.getAttribute?.('class'), elemento.getAttribute?.('onclick'),
        elemento.getAttribute?.('href')
      ].join(' '));
      if (/editar|alterar|edit|pencil|lapis/.test(descricao)) {
        return elemento.closest('a, button, [onclick]') || elemento;
      }
    }

    const celulaAcoes = Array.from(linha.querySelectorAll(':scope > td'))[1];
    const controles = Array.from(
      celulaAcoes?.querySelectorAll('a, button, [onclick]') || []
    ).filter(elementoVisivel);
    return controles.filter(controle => !/excluir|delete|remove/.test(normalizarTexto([
      controle.title, controle.className, controle.getAttribute?.('href'),
      controle.getAttribute?.('onclick')
    ].join(' ')))).at(-1) || controles.at(-1) || null;
  }

  function extrairUrlEdicao(controle) {
    if (!controle) return null;

    const textos = [
      controle.href,
      controle.getAttribute?.('href'),
      controle.getAttribute?.('data-url'),
      controle.getAttribute?.('data-href'),
      controle.getAttribute?.('onclick'),
      controle.outerHTML
    ].filter(Boolean);

    for (const textoOriginal of textos) {
      const texto = String(textoOriginal).replace(/&amp;/g, '&');
      const encontrado = texto.match(
        /(https?:\/\/[^'"\s]+\/ItemNotaFiscal\/Edit\?[^'"\s)]+|\/?ItemNotaFiscal\/Edit\?[^'"\s)]+)/i
      );

      if (encontrado) {
        const caminho = encontrado[1].startsWith('http') || encontrado[1].startsWith('/')
          ? encontrado[1]
          : `/${encontrado[1]}`;
        const url = new URL(caminho, location.origin);
        url.searchParams.set('_', String(Date.now()));
        return url.href;
      }
    }

    return null;
  }

  function serializarDadoSeguro(valor, profundidade = 0, visitados = new WeakSet()) {
    if (valor === null || valor === undefined) return '';
    if (typeof valor === 'string' || typeof valor === 'number' ||
        typeof valor === 'boolean') return String(valor);
    if (typeof valor !== 'object' || profundidade > 3) return '';
    if (visitados.has(valor)) return '';
    visitados.add(valor);

    const partes = [];
    for (const chave of Object.keys(valor).slice(0, 300)) {
      let conteudo;
      try { conteudo = valor[chave]; } catch (_) { continue; }
      if (typeof conteudo === 'function') continue;
      partes.push(`${chave}:${serializarDadoSeguro(
        conteudo, profundidade + 1, visitados
      )}`);
    }
    return partes.join(' ');
  }

  function obterDadosInternosDaLinha(linha) {
    const dados = [];
    const grade = linha.closest('.t-grid, [class*="grid"]');
    const indice = Array.from(linha.parentElement?.children || []).indexOf(linha);
    const pagina = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const jq = pagina.jQuery;

    if (jq) {
      try { dados.push(jq(linha).data()); } catch (_) { /* segue */ }
      try {
        const instancia = grade && (jq(grade).data('tGrid') || jq(grade).data('kendoGrid'));
        if (instancia) {
          if (typeof instancia.dataItem === 'function') dados.push(instancia.dataItem(linha));
          if (Array.isArray(instancia.data) && indice >= 0) dados.push(instancia.data[indice]);
          const visualizacao = instancia.dataSource?.view?.();
          if (Array.isArray(visualizacao) && indice >= 0) dados.push(visualizacao[indice]);
        }
      } catch (_) { /* segue */ }
    }

    return dados.filter(Boolean);
  }

  function extrairIdEdicaoDosDados(valor, profundidade = 0, visitados = new WeakSet()) {
    if (!valor || typeof valor !== 'object' || profundidade > 4) return null;
    if (visitados.has(valor)) return null;
    visitados.add(valor);

    for (const chave of [
      'Id', 'id', 'ItemNotaFiscalId', 'itemNotaFiscalId',
      'IdItemNotaFiscal', 'idItemNotaFiscal'
    ]) {
      const id = String(valor[chave] ?? '').match(/^\d{8,}$/)?.[0];
      if (id) return id;
    }

    for (const chave of Object.keys(valor).slice(0, 300)) {
      let filho;
      try { filho = valor[chave]; } catch (_) { continue; }
      const encontrado = extrairIdEdicaoDosDados(
        filho, profundidade + 1, visitados
      );
      if (encontrado) return encontrado;
    }
    return null;
  }

  function obterIdEmpresaDaPagina() {
    const campo = document.querySelector(
      'input[name="IdEmpresa"], input[id="IdEmpresa"], input[name$=".IdEmpresa"]'
    );
    const candidatos = [
      campo?.value,
      new URL(location.href).searchParams.get('idEmpresa'),
      document.body?.innerHTML?.match(
        /["']IdEmpresa["'][^>]{0,160}value=["'](\d+)["']/i
      )?.[1]
    ];
    return candidatos.map(valor => String(valor || ''))
      .find(valor => /^\d{8,}$/.test(valor)) || '';
  }

  function construirUrlEdicaoPeloId(id) {
    if (!/^\d{8,}$/.test(String(id || ''))) return null;
    const url = new URL('/ItemNotaFiscal/Edit', location.origin);
    url.searchParams.set('id', String(id));
    url.searchParams.set('bloquear', 'false');
    const idEmpresa = obterIdEmpresaDaPagina();
    if (idEmpresa) url.searchParams.set('idEmpresa', idEmpresa);
    url.searchParams.set('_Modal', 'true');
    url.searchParams.set('_', String(Date.now()));
    return url.href;
  }

  function extrairUrlEdicaoDaLinha(linha) {
    const urlDoControle = extrairUrlEdicao(encontrarControleEditar(linha));
    if (urlDoControle) return urlDoControle;

    for (const elemento of [linha, ...linha.querySelectorAll('*')]) {
      const textos = [elemento.href, elemento.outerHTML];
      for (const atributo of Array.from(elemento.attributes || [])) {
        textos.push(atributo.value);
      }
      for (const texto of textos.filter(Boolean)) {
        const url = extrairUrlEdicao({
          href: texto,
          getAttribute: () => texto,
          outerHTML: texto
        });
        if (url) return url;
      }
    }

    const dadosInternos = obterDadosInternosDaLinha(linha);
    for (const dado of dadosInternos) {
      const texto = serializarDadoSeguro(dado);
      const url = extrairUrlEdicao({
        href: texto,
        getAttribute: () => texto,
        outerHTML: texto
      });
      if (url) return url;
    }

    for (const dado of dadosInternos) {
      const url = construirUrlEdicaoPeloId(extrairIdEdicaoDosDados(dado));
      if (url) return url;
    }

    const idEmAtributo = Array.from(linha.querySelectorAll('*'))
      .flatMap(elemento => Array.from(elemento.attributes || []))
      .map(atributo => atributo.value)
      .map(valor => String(valor).match(/(?:^|\D)(\d{12,})(?:\D|$)/)?.[1])
      .find(Boolean);
    return construirUrlEdicaoPeloId(idEmAtributo);
  }

  function obterUrlEdicaoDoItem(item) {
    const linha = localizarLinhaDoItem(item);
    if (!linha) throw new Error(`Não encontrei a linha ${item.numero || item.codigo}.`);

    const url = extrairUrlEdicaoDaLinha(linha);
    if (!url) {
      throw new Error(`Não consegui identificar a URL de edição do item ${item.codigo}.`);
    }

    return url;
  }

  function converterFormularioEmObjeto(formulario) {
    const payload = {};
    const dados = new FormData(formulario);

    for (const [nome, valor] of dados.entries()) {
      if (!nome || valor instanceof File) continue;
      payload[nome] = valor;
    }

    const botoes = formulario.querySelectorAll(
      'button[name], input[type="button"][name], input[type="submit"][name]'
    );

    for (const botao of botoes) {
      if (!botao.name) continue;
      payload[botao.name] = botao.value || botao.textContent?.trim() || '';
    }

    const controlesPorNome = new Map();
    for (const controle of Array.from(formulario.elements || [])) {
      if (!controle.name) continue;
      if (!controlesPorNome.has(controle.name)) controlesPorNome.set(controle.name, []);
      controlesPorNome.get(controle.name).push(controle);
    }

    for (const [nome, controles] of controlesPorNome) {
      const checkbox = controles.find(controle => controle.type === 'checkbox');
      const exigeUmCaractere = CAMPOS_SIM_NAO.has(nome) ||
        CAMPOS_CODIGO_UM_CARACTERE.has(nome) || controles.some(controle => {
        const limites = [
          controle.maxLength,
          controle.getAttribute?.('maxlength'),
          controle.getAttribute?.('data-val-length-max'),
          controle.getAttribute?.('data-val-stringlength-max')
        ];
        return limites.some(limite => Number(limite) === 1);
      });

      if (checkbox) {
        payload[nome] = exigeUmCaractere
          ? (checkbox.checked ? 'S' : 'N')
          : (checkbox.checked ? 'True' : 'False');
        continue;
      }

      const ultimoNome = nome.split('.').at(-1) || nome;
      const campoDeId = /^id(?:$|[A-Z_])/i.test(ultimoNome) || /Id$/i.test(ultimoNome);
      const campoNumerico = !campoDeId && controles.some(controle =>
        controle.type === 'number' ||
        controle.hasAttribute?.('data-val-number') ||
        controle.closest?.('.t-numerictextbox, [class*="numeric"]')
      );

      if (campoNumerico) {
        const textoNumero = String(payload[nome] ?? '').trim();
        if (!textoNumero) {
          payload[nome] = null;
        } else {
          const numero = parseBr(textoNumero);
          if (!Number.isFinite(numero)) {
            throw new Error(`Valor numérico inválido no campo ${nome}: ${textoNumero}.`);
          }
          payload[nome] = numero;
        }
        continue;
      }

      const textoAtual = String(payload[nome] ?? '').trim();
      const atual = textoAtual.toLowerCase();
      if (exigeUmCaractere && (atual === 'true' || atual === 'false')) {
        payload[nome] = atual === 'true' ? 'S' : 'N';
        continue;
      }

      if (exigeUmCaractere && textoAtual.length !== 1) {
        const candidatos = controles.flatMap(controle => [
          controle.value,
          controle.getAttribute?.('value'),
          controle.getAttribute?.('data-value'),
          controle.selectedOptions?.[0]?.value
        ]).map(valor => String(valor ?? '').trim())
          .filter(valor => valor.length === 1);

        if (candidatos.length) {
          payload[nome] = candidatos[0].toUpperCase();
        } else if (textoAtual.length > 1) {
          payload[nome] = textoAtual.charAt(0).toUpperCase();
        } else if (CODIGO_PADRAO_QUANDO_AUSENTE[nome]) {
          payload[nome] = CODIGO_PADRAO_QUANDO_AUSENTE[nome];
        }
      }
    }

    // Este campo tem regra própria no servidor: aceita exclusivamente Q ou V.
    // Alguns componentes do formulário devolvem o rótulo visível em vez do código.
    const modoAbatimento = normalizarTexto(payload.ModoAbatimentoTitulo);
    payload.ModoAbatimentoTitulo =
      modoAbatimento === 'v' || modoAbatimento.includes('valor') ? 'V' : 'Q';

    return payload;
  }

  async function carregarPayloadDoItem(urlEdicao) {
    const resposta = await fetch(urlEdicao, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        Accept: 'text/html, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest'
      }
    });

    if (!resposta.ok) {
      throw new Error(`Falha ao carregar o item em segundo plano (HTTP ${resposta.status}).`);
    }

    const html = await resposta.text();
    const documento = new DOMParser().parseFromString(html, 'text/html');
    const formularios = Array.from(documento.querySelectorAll('form'));
    const formulario = formularios.find(form =>
      form.querySelector('[name="Id"]') &&
      form.querySelector('[name="IdNotaFiscal"]') &&
      form.querySelector('[name="IdItem"]')
    );

    if (!formulario) {
      throw new Error('A resposta de edição não contém o formulário esperado.');
    }

    const payload = converterFormularioEmObjeto(formulario);
    const obrigatorios = ['Id', 'IdNotaFiscal', 'IdItem', 'Quantidade', 'ValorUnitarioInterno'];
    const ausentes = obrigatorios.filter(nome =>
      payload[nome] === undefined || payload[nome] === null || payload[nome] === ''
    );

    if (ausentes.length) {
      throw new Error(`Campos ausentes no formulário: ${ausentes.join(', ')}.`);
    }

    return payload;
  }

  function prepararPayloadComSetup(payloadOriginal, setup, percentualDoSetup) {
    const payload = { ...payloadOriginal };
    const quantidade = parseBr(payload.Quantidade);
    const valorUnitarioBase = parseBr(payload.ValorUnitarioInterno);
    const valorTotalBase = quantidade * valorUnitarioBase;

    if (!Number.isFinite(quantidade) || quantidade <= 0) {
      throw new Error('Quantidade inválida no formulário carregado.');
    }
    if (!Number.isFinite(valorUnitarioBase) || valorUnitarioBase <= 0) {
      throw new Error('Valor unitário interno inválido no formulário carregado.');
    }

    const percentual = calcularPercentual(
      quantidade,
      valorTotalBase,
      valorUnitarioBase,
      setup.valor,
      percentualDoSetup
    );

    if (!Number.isFinite(percentual)) {
      throw new Error('O percentual calculado para o teste em segundo plano é inválido.');
    }

    const percentualArredondado = Number(percentual.toFixed(4));
    const valorUnitarioNovo = valorUnitarioBase * (1 + percentualArredondado / 100);
    const valorTotalNovo = Number((quantidade * valorUnitarioNovo).toFixed(2));

    payload.PossuiAcrescimoDescontoInterno = 'True';
    payload.TipoAlteracaoValorUnitario = '2';
    // Garantia extra: o servidor deve receber números, nunca textos como "100,0000".
    payload.Quantidade = quantidade;
    payload.ValorUnitarioInterno = valorUnitarioBase;
    payload.AcrescimoDescontoInterno = percentualArredondado;
    payload.ValorUnitarioMoedaOriginal = Number(valorUnitarioNovo.toFixed(10));
    payload.ValorTotalSemIPI = valorTotalNovo;
    payload.ValorTotalComDesconto = valorTotalNovo;
    payload.btnSalvarFechar = payload.btnSalvarFechar || 'Salvar e fechar';
    payload.bloquear = 'false';

    return {
      payload,
      percentual: percentualArredondado,
      valorUnitarioNovo,
      valorTotalNovo
    };
  }

  async function enviarPayloadDoItem(payload) {
    const resposta = await fetch('/ItemNotaFiscal/Edit?_ExecuteResult=true', {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/json; charset=utf-8',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: JSON.stringify(payload)
    });

    let resultado;
    try {
      resultado = await resposta.json();
    } catch (_) {
      throw new Error(`O salvamento retornou uma resposta inválida (HTTP ${resposta.status}).`);
    }

    const mensagens = Array.isArray(resultado?.Messages)
      ? resultado.Messages.map(item => item?.Message || item?.Text || String(item))
      : [];

    if (!resposta.ok || resultado?.AccessDenied || resultado?.Value !== true) {
      throw new Error(
        mensagens.join('\n') || resultado?.Title ||
        `O Maxiprod recusou o salvamento (HTTP ${resposta.status}).`
      );
    }

    return resultado;
  }

  async function processarLoteEmSegundoPlano() {
    if (loteEmExecucao) return;

    const selecao = obterItensSelecionados();
    if (selecao.erro) return alert(selecao.erro);
    if (!selecao.itens.length) {
      return alert('Selecione pelo menos um item para o lote em segundo plano.');
    }

    const setup = escolherSetup();
    if (!setup) return;

    loteEmExecucao = true;
    const botao = document.getElementById(BTN_TESTE_BG_ID);
    if (botao) {
      botao.disabled = true;
      botao.textContent = 'API…';
    }

    let salvos = 0;
    const erros = [];
    let statusFinal = '';

    try {
      const mapa = await consultarSetups(selecao.itens.map(item => item.codigo));

      for (let indice = 0; indice < selecao.itens.length; indice++) {
        const item = selecao.itens[indice];
        if (botao) botao.textContent = `${indice + 1}/${selecao.itens.length}`;

        const cadastro = mapa.get(item.codigo);
        const erroCadastro = mensagemDoCadastro(item.codigo, cadastro);
        if (erroCadastro) {
          erros.push(erroCadastro);
          continue;
        }

        try {
          const urlEdicao = obterUrlEdicaoDoItem(item);
          const payloadOriginal = await carregarPayloadDoItem(urlEdicao);
          const preparado = prepararPayloadComSetup(
            payloadOriginal,
            setup,
            cadastro.percentual
          );

          const retorno = await enviarPayloadDoItem(preparado.payload);
          console.log('[TM Setup BG] Item salvo:', { item, preparado, retorno });
          salvos++;
          await wait(120);
        } catch (erroItem) {
          console.error('[TM Setup BG] Erro no item:', item, erroItem);
          erros.push(`Item ${item.numero || item.codigo} (${item.codigo}): ` +
            `${erroItem.message || erroItem}`);
        }
      }

      const gradeAtualizada = await atualizarGradeProdutosSemFechar();

      if (erros.length) {
        const resumo = [
          'Lote concluído com ocorrências.', '',
          `${salvos} de ${selecao.itens.length} item(ns) salvo(s).`,
          gradeAtualizada
            ? 'A grade foi atualizada e a proposta permaneceu aberta.'
            : 'A proposta permaneceu aberta. Use o botão circular da grade para atualizar.'
        ];
        resumo.push('', `${erros.length} ocorrência(s):`, ...erros.slice(0, 12));
        if (erros.length > 12) resumo.push(`... e mais ${erros.length - 12}.`);
        alert(resumo.join('\n'));
      } else {
        statusFinal = `✓ ${salvos}/${selecao.itens.length}`;
      }
    } catch (erro) {
      console.error('[TM Setup BG] Falha geral no lote:', erro);
      alert(`Lote em segundo plano interrompido.\n\n` +
        `${salvos} de ${selecao.itens.length} item(ns) salvo(s).\n\n` +
        `Erro: ${erro.message || erro}`);
    } finally {
      loteEmExecucao = false;
      if (botao) {
        botao.disabled = false;
        if (statusFinal) {
          botao.textContent = statusFinal;
          botao.style.background = '#238636';
          botao.style.color = '#fff';
          setTimeout(() => {
            if (!loteEmExecucao && botao.isConnected) {
              botao.textContent = 'Setup';
              botao.style.background = '#f2c94c';
              botao.style.color = '#1f2937';
            }
          }, 4000);
        } else {
          botao.textContent = 'Setup';
          botao.style.background = '#f2c94c';
          botao.style.color = '#1f2937';
        }
      }
    }
  }

  function textoDoControle(controle) {
    return normalizarTexto(controle?.textContent || controle?.value ||
      controle?.title || controle?.getAttribute?.('aria-label'));
  }

  function encontrarControlePorTexto(raiz, texto) {
    if (!raiz) return null;
    return Array.from(raiz.querySelectorAll(
      'button, input[type="button"], input[type="submit"], a'
    )).find(controle => textoDoControle(controle) === texto) || null;
  }

  async function abrirItem(item) {
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      const linha = await esperarCondicao(() => localizarLinhaDoItem(item), 8000);
      if (!linha) {
        if (tentativa === 3) {
          throw new Error(`Não encontrei a linha ${item.numero || item.codigo}.`);
        }
        await wait(700);
        continue;
      }

      const editar = encontrarControleEditar(linha);
      if (!editar || !editar.isConnected) {
        if (tentativa === 3) {
          throw new Error(`Não encontrei o lápis do item ${item.numero || item.codigo}.`);
        }
        await wait(700);
        continue;
      }

      linha.scrollIntoView({ block: 'center', inline: 'nearest' });
      await wait(120);
      editar.click();

      const abriu = await esperarCondicao(() => {
        const quantidade = getInput('Quantidade__');
        return elementoVisivel(quantidade) ? quantidade : null;
      }, 6500);

      if (abriu) {
        await wait(150);
        return;
      }

      console.warn('[TM Setup] Janela não abriu; repetindo clique:', {
        item,
        tentativa
      });
      await wait(800);
    }

    throw new Error(`A janela do item ${item.numero || item.codigo} não abriu após 3 tentativas.`);
  }

  async function salvarEFecharItem(item) {
    const quantidadeAntes = getInput('Quantidade__');
    const salvar = encontrarControlePorTexto(encontrarRaizModalDoItem(), 'salvar e fechar');
    if (!salvar) throw new Error('Não encontrei o botão Salvar e fechar.');
    salvar.click();

    const fechou = await esperarCondicao(
      () => !quantidadeAntes?.isConnected || !elementoVisivel(quantidadeAntes), 18000
    );
    if (!fechou) {
      throw new Error(`O Maxiprod não fechou o item ${item.numero || item.codigo}.`);
    }
    await esperarCondicao(() => localizarLinhaDoItem(item), 8000);
    await wait(650);
  }

  async function fecharItemComErro() {
    const quantidadeAntes = getInput('Quantidade__');
    if (!quantidadeAntes) return true;
    const fechar = encontrarControlePorTexto(encontrarRaizModalDoItem(), 'fechar');
    if (!fechar) return false;
    fechar.click();

    let fechou = await esperarCondicao(
      () => !quantidadeAntes.isConnected || !elementoVisivel(quantidadeAntes), 2500
    );
    if (fechou) return true;

    const dialogos = Array.from(document.querySelectorAll(
      '.t-window, [role="dialog"], .ui-dialog, .modal'
    )).filter(elementoVisivel);
    const confirmacao = dialogos.find(dialogo => {
      const texto = normalizarTexto(dialogo.innerText);
      return texto.includes('alterac') || texto.includes('deseja fechar');
    });
    encontrarControlePorTexto(confirmacao, 'sim')?.click();
    fechou = await esperarCondicao(
      () => !quantidadeAntes.isConnected || !elementoVisivel(quantidadeAntes), 5000
    );
    return Boolean(fechou);
  }

  function atualizarBotaoLote(texto, executando) {
    const botao = document.getElementById(BTN_LOTE_ID);
    if (!botao) return;
    botao.textContent = texto;
    botao.disabled = executando;
    botao.style.cursor = executando ? 'wait' : 'pointer';
    botao.style.opacity = executando ? '0.75' : '1';
  }

  function mensagemDoCadastro(codigo, cadastro) {
    if (cadastro?.erro) return `Item ${codigo}: erro na API — ${cadastro.erro}`;
    if (!cadastro?.encontrado) return `Item ${codigo}: não encontrado pela API.`;
    if (cadastro.percentual === null) {
      return `Item ${codigo}: não contém [setup: percentual] nas Observações técnicas.`;
    }
    return '';
  }

  async function calcularEInserirIndividual() {
    try {
      const codigo = normalizarCodigo(encontrarInputCodigoItem()?.value);
      if (!codigo) return alert('Não encontrei o Código do item aberto.');
      const setup = escolherSetup();
      if (!setup) return;
      const cadastro = (await consultarSetups([codigo])).get(codigo);
      const erroCadastro = mensagemDoCadastro(codigo, cadastro);
      if (erroCadastro) return alert(erroCadastro);
      const resultado = await calcularEInserirComSetup(setup, cadastro.percentual);
      if (!resultado.ok) alert(resultado.erro);
    } catch (erro) {
      console.error('[TM Setup] Erro individual:', erro);
      alert(`Erro: ${erro.message || erro}`);
    }
  }

  async function processarItensSelecionados() {
    if (loteEmExecucao) return;
    const selecao = obterItensSelecionados();
    if (selecao.erro) return alert(selecao.erro);
    if (!selecao.itens.length) {
      return alert('Nenhum item foi selecionado na grade Produtos/serviços.');
    }
    const setup = escolherSetup();
    if (!setup) return;

    loteEmExecucao = true;
    let salvos = 0;
    const erros = [];

    try {
      atualizarBotaoLote('API…', true);
      const mapa = await consultarSetups(selecao.itens.map(item => item.codigo));

      for (let indice = 0; indice < selecao.itens.length; indice++) {
        const item = selecao.itens[indice];
        atualizarBotaoLote(`${indice + 1}/${selecao.itens.length}`, true);
        const cadastro = mapa.get(item.codigo);
        const erroCadastro = mensagemDoCadastro(item.codigo, cadastro);
        if (erroCadastro) {
          erros.push(erroCadastro);
          continue;
        }

        try {
          await abrirItem(item);
          const resultado = await calcularEInserirComSetup(setup, cadastro.percentual);
          if (!resultado.ok) throw new Error(resultado.erro);
          await salvarEFecharItem(item);
          salvos++;
        } catch (erroItem) {
          console.error('[TM Setup] Erro no item:', item, erroItem);
          erros.push(`Item ${item.numero || item.codigo}: ${erroItem.message || erroItem}`);
          const recuperou = await fecharItemComErro();
          if (!recuperou && getInput('Quantidade__')) {
            erros.push('Não foi possível fechar a janela com erro; o lote foi interrompido.');
            break;
          }
        }
      }

      const resumo = [
        'Processamento concluído.', '',
        `${salvos} de ${selecao.itens.length} item(ns) salvo(s).`
      ];
      if (erros.length) {
        resumo.push('', `${erros.length} ocorrência(s):`, ...erros.slice(0, 12));
        if (erros.length > 12) resumo.push(`... e mais ${erros.length - 12}.`);
      }
      alert(resumo.join('\n'));
    } catch (erro) {
      console.error('[TM Setup] Erro geral:', erro);
      alert(`Processamento interrompido.\n\n${salvos} item(ns) salvo(s).\n\n` +
        `Erro: ${erro.message || erro}`);
    } finally {
      loteEmExecucao = false;
      atualizarBotaoLote('Lote %', false);
    }
  }

  function aplicarEstiloBotao(botao, bottom, cor) {
    Object.assign(botao.style, {
      position: 'fixed', right: '20px', bottom, minWidth: '62px', height: '52px',
      padding: '0 12px', borderRadius: '26px', border: '1px solid #2f6ea4',
      background: cor, color: '#fff', fontSize: '17px', fontWeight: 'bold',
      cursor: 'pointer', zIndex: '999999', boxShadow: '0 4px 12px rgba(0,0,0,.25)'
    });
  }

  function criarBotoes() {
    document.getElementById(BTN_INDIVIDUAL_ID)?.remove();
    document.getElementById(BTN_LOTE_ID)?.remove();
    if (!document.getElementById(BTN_TESTE_BG_ID)) {
      const testeBg = document.createElement('button');
      testeBg.id = BTN_TESTE_BG_ID;
      testeBg.type = 'button';
      testeBg.title = 'Aplicar Setup nos itens selecionados';
      testeBg.textContent = 'Setup';
      aplicarEstiloBotao(testeBg, '20px', '#f2c94c');
      testeBg.style.color = '#1f2937';
      testeBg.addEventListener('click', processarLoteEmSegundoPlano);
      document.body.appendChild(testeBg);
    }
  }

  function init() {
    GM_registerMenuCommand('Trocar token da API Maxiprod', () => {
      GM_deleteValue(TOKEN_KEY);
      if (solicitarToken()) alert('Novo token salvo.');
    });
    GM_registerMenuCommand('Apagar token da API Maxiprod', () => {
      GM_deleteValue(TOKEN_KEY);
      alert('Token apagado. O script solicitará um novo na próxima execução.');
    });
    criarBotoes();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
