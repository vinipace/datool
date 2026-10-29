# Plano: WhatsApp via Evolution no Datool

Data: 26/10/2026. Estado: implementação em validação. Produção e teste com aparelho ainda pendentes; consultar `ops/evolution/README.md` para o procedimento operacional.

## Resultado esperado

O administrador conecta um número por QR Code em Canais → WhatsApp → Via Evolution (não oficial). As novas conversas entram no Inbox e podem ser atendidas pelo agente ou por uma pessoa. O Datool gerencia a infraestrutura, as sessões e a reconexão.

Deploy inicial: um app Evolution separado no Dokku, no mesmo servidor do Datool, condicionado à capacidade medida. Uma instância lógica por número; conectar outro número não cria container nem dispara deploy.

## Escopo da primeira entrega

- Atendimento individual receptivo por texto; transferência para humano e retorno explícito à IA.
- QR Code, número confirmado, estado da conexão, pausa, reconexão e desconexão.
- Isolamento por organização/projeto, limites por conexão e liberação por lista de projetos.
- Aviso de conexão não oficial, registro do aceite e atribuição à Evolution nas configurações.
- Mensagens de tipos ainda não suportados aparecem como tais, sem inventar conteúdo ou acionar uma resposta de IA sem contexto.
- Fora desta entrega: campanhas, prospecção, grupos, chamadas, importação de histórico, suporte completo a mídia, servidor fornecido pelo cliente e balanceamento entre vários servidores.

## Base existente e decisões

`src/lib/build/channels.ts` já define contratos normalizados; `src/server/build/channels/service.ts` mantém fila durável, deduplicação e envio. O WhatsApp atual depende da Meta em autorização, envio, recibos e operações. Não basta trocar a URL de destino.

Manter `channel=whatsapp` e introduzir um discriminador persistido e validado de provedor (`meta` ou `evolution`). Conexões existentes são migradas explicitamente para Meta. Uma conexão não troca de provedor em uso; a troca exige desconexão e novo vínculo. Preservar métricas e identificação visual de WhatsApp, mostrando o provedor nas configurações.

Adicionar tabela de vínculo Evolution com conexão/projeto, identificador do servidor, nome opaco da instância, identidade confirmada do número e estado de autenticação. Reutilizar o armazenamento criptografado de credenciais. O servidor é escolhido na configuração do operador, nunca por URL arbitrária enviada pelo cliente.

Separar estado desejado (ativo/pausado/desconectado) do estado observado da sessão (aguardando QR/conectando/conectado/reconectando/erro). Um evento atrasado não pode reativar uma conexão pausada ou revogada.

Um mesmo número não pode atender duas conexões ativas no Datool, inclusive entre provedores. Verificar a identidade retornada pelo provedor, com exclusividade transacional. Examinar os dados Meta existentes antes de definir o backfill; número exibido não validado não é prova de identidade. Conflitos exigem resolução sem reassociar silenciosamente uma organização.

## Etapa 1 — Preparar implementação e validar o contrato externo

1. Selecionar uma base de código e branch `codex/…`, preservando as alterações locais existentes, especialmente os editores de canais e Inbox. Reutilizar um checkout isolado adequado quando disponível. Não incluir trabalho alheio por acidente.
2. Ler as instruções locais e os guias relevantes do Next instalado antes de escrever rotas/UI.
3. Selecionar release/commit da Evolution e imagem com digest fixo; verificar arquitetura do host, licença daquela revisão, dependências e migrações. Não usar `latest` em produção.
4. Subir essa imagem fora da produção com PostgreSQL/Redis e armazenamento descartáveis. Verificar criação, QR, estado, webhook autenticado, envio, recibos, logout, exclusão e comportamento em timeout.
5. Capturar fixtures sanitizadas do contrato efetivamente observado. Validar identificadores WhatsApp (inclusive JIDs/LIDs), eventos próprios, histórico e reconexão; não presumir que todo identificador seja um telefone.
6. Confirmar configurações de persistência, permissões de arquivos, retenção e telemetria. A documentação pode divergir da imagem escolhida.

Saída: imagem escolhida, contrato validado e critérios conhecidos para distinguir falha de envio de resultado incerto. O pareamento real depende de um número de teste autorizado e do titular escanear o QR.

## Etapa 2 — Conexão e isolamento

1. Criar migração aditiva com o próximo número disponível no momento da implementação; adicionar provedor e vínculo Evolution sem alterar os dados específicos da Meta.
2. Implementar cliente HTTP interno e operações de criar, obter QR, consultar estado, pausar, reconectar e desconectar. Usar as permissões e o registro de operações existentes em `src/server/build/operations/index.ts`.
3. Criação idempotente: requisições repetidas e timeout não podem deixar múltiplas instâncias para a mesma conexão. Manter reconciliação de operações incompletas e limpeza de pareamentos abandonados.
4. Criar segredo de webhook por conexão e token de instância quando suportado pela imagem validada. Reservar a chave global ao provisionamento no backend. Não expor credenciais em navegador, logs, traces ou ferramentas de leitura.
5. Exibir QR somente a usuários com permissão para administrar a conexão; usar resposta sem cache e validade limitada. Não incluir QR em auditorias persistentes.
6. Pausar mantém a sessão e registra novas mensagens no Inbox, mas impede automação. Desconectar bloqueia envios imediatamente, invalida a geração da sessão, cancela jobs pertinentes e executa logout/limpeza remota. Se a limpeza falhar, manter estado pendente e tentar novamente sem reativar envios.

Saída: duas organizações de teste não conseguem consultar QR, estado ou operar a instância uma da outra; reconectar não duplica vínculos.

## Etapa 3 — Mensagens, Inbox e atendimento

1. Criar uma rota de webhook Evolution separada. Autenticar antes de resolver o tenant; conferir instância, conexão e geração ativa contra o banco. Nunca aceitar project/organization IDs do payload como autorização.
2. Validar tamanho/formato e persistir o evento antes de confirmar recebimento. Reaproveitar a fila existente, sem executar o agente dentro do webhook.
3. Normalizar texto e identidades; deduplicar por conexão e identificador externo. Ignorar grupos/status para execução; impedir que histórico inicial e mensagens antigas disparem o agente.
4. Distinguir mensagem do cliente, eco de envio Datool e envio manual pelo celular. Correlacionar ecos aos envios já registrados. Uma mensagem humana não deve gerar outra resposta do bot; usar os controles existentes de ownership para pausar a IA inclusive quando uma resposta já estiver na fila.
5. Selecionar o adaptador de envio por provedor. Manter regras de template/janela da Meta somente no provedor Meta. Para Evolution, impor no servidor a política do piloto: responder apenas a conversa individual iniciada pelo cliente, ainda aberta e com mensagem recebida nas últimas 24 horas. Esse prazo é uma restrição de produto do piloto, não uma autorização da Meta para uso não oficial.
6. Aplicar essa política no momento de enfileirar e de enviar, inclusive para respostas humanas, ferramentas, campanhas e retomadas agendadas. Respeitar bloqueio, opt-out, pausa e ownership. Não depender apenas de ocultar botões.
7. Tratar confirmações de envio, entrega e leitura separadamente. Em timeout após possível aceitação, registrar resultado incerto e reconciliar; não reenviar automaticamente sem evidência de que não foi enviado. Revalidar validade/ownership antes de liberar mensagens atrasadas após reconexão.

Saída: uma mensagem recebida produz uma conversa e no máximo uma resposta automática; repetição, reconexão e intervenção humana não causam duplicação ou envio indevido. Não prometer entrega exatamente uma vez se o provedor não oferecer tal garantia.

## Etapa 4 — Interface

- No editor de WhatsApp, oferecer Meta e Evolution com identificação clara. Manter o fluxo oficial e suas operações funcionando.
- Exibir aviso e aceite versionado, atribuição à Evolution, QR, expiração/renovação, número conectado e último estado confirmado.
- Oferecer controles de pausa, reconexão e desconexão, distinguindo pausa do agente de sessão desconectada.
- Exibir indisponibilidade e envio incerto no Inbox sem marcar entrega não confirmada.
- Usar catálogo e componentes compartilhados, tokens semânticos e padrões existentes; verificar teclado/foco, mobile, carregamento, vazio e erro.

Saída: administrador conecta e gerencia o número inteiramente pelo Datool, sem acessar o painel Evolution.

## Etapa 5 — Preparar e provisionar no Dokku

Primeiro fazer inventário somente leitura: versão/plugins Dokku, arquitetura, acesso autorizado, CPU/RAM em uso e folga, disco, backups, rede e releases concorrentes. Definir limites de CPU/memória/conexões/disco e orçamento do piloto a partir dessas medidas. Não estimar números por servidor sem teste. Se não houver folga, usar outro servidor antes de ativar o piloto.

Topologia proposta (nomes lógicos, sujeitos a disponibilidade):

```text
Dokku no servidor existente
├── datool: web + workers existentes
├── datool-evolution: um processo permanente
├── evolution-db: PostgreSQL dedicado
├── evolution-redis: Redis dedicado
└── volume persistente da Evolution
```

1. Preparar runbook genérico em `ops/evolution/` com preflight, configuração, deploy, upgrade, rollback e remoção. Identidades, endereços, segredos e evidência real ficam no runbook privado do operador.
2. Provisionar com acesso administrativo já autorizado. A chave restrita atual aceita apenas operações do app Datool; ela não pode criar ou atualizar a Evolution. Não ampliar essa chave genericamente. Se automatizar releases, criar uma permissão separada e limitada ao novo app.
3. Criar PostgreSQL/Redis próprios, credenciais exclusivas, armazenamento persistente com UID/GID verificados na imagem e backups protegidos. Escolher explicitamente o local autoritativo das sessões; não depender de Redis descartável. Desabilitar armazenamento de histórico/contatos que não seja necessário ao piloto, conforme contrato testado.
4. Configurar rede privada entre os serviços, resolução estável e nenhuma porta pública de banco/Redis. Preferir API Evolution apenas na rede interna; se precisar de endpoint externo operacional, restringir acesso e usar TLS. O navegador usa somente o Datool. Webhooks chegam à rota autenticada do Datool.
5. Importar a imagem exata testada, com verificação de tamanho, disco, origem e digest. Adaptar os mecanismos de importação aprovados ao app novo; não copiar cegamente comandos exclusivos do Datool. Nenhuma compilação no host de produção.
6. Configurar um único processo proprietário das sessões e deploy que para o antigo antes de iniciar o novo. Validar `checks:disable` para esse processo na versão instalada; `checks:skip` não é substituto. Aceitar uma interrupção controlada durante upgrades e executar health/readiness pós-deploy explicitamente.
7. Configurar reinício, rotação de logs, alertas e coleta no serviço de logging já utilizado pelo operador. Não registrar payloads, QR, números completos ou credenciais. Acompanhar sessões conectadas, desconexões, fila atrasada, falhas/incerteza de envio, reinícios e consumo de recursos.
8. Registrar backup recuperável, imagem anterior e estratégia de retorno antes de qualquer upgrade com migração. Restauração é feita primeiro isolada, sem duas cópias da mesma sessão conectadas ao WhatsApp.

Saída: serviço saudável com dados persistentes, portas protegidas, recursos limitados e procedimento de recuperação exercitado. A saúde HTTP não comprova que um número esteja conectado.

## Etapa 6 — Verificar e liberar

Estender testes existentes quando cobrem o contrato; novos testes devem proteger riscos observáveis, seguindo a skill test-audit, sem duplicar a implementação. Referências atuais: `tests/build-channel-durable.test.ts`, `tests/build-channel-waits.test.ts` e `scripts/test-whatsapp-e2e.ts`.

| Prova | Critério de aceite |
| --- | --- |
| Isolamento | Um tenant não opera outro; webhook sem autenticação, com instância trocada ou sessão antiga é rejeitado. |
| Lifecycle | Criar duas vezes não duplica; QR expira; logout revoga sessão; eventos atrasados não desfazem pausa/desconexão. |
| Mensagens | Deduplicação, histórico sem auto-resposta, IDs corretos e eco sem loop; envio incerto não dispara retry cego. |
| Atendimento | Texto do cliente chega ao Inbox; agente responde; humano assume e interrompe resposta pendente; celular manual é tratado corretamente. |
| Política | Campanhas, ferramentas e jobs não contornam a restrição receptiva; opt-out e conversa encerrada impedem envio. |
| Regressão | WhatsApp Meta, Telegram e web continuam funcionando; migração preserva conexões existentes. |
| Operação | Reiniciar/substituir container recupera a sessão válida; revogação pelo celular exige reconectar; backup é restaurável. |
| UI e CI | `bun run check:styles`, typecheck, lint/format scoped e gates aplicáveis do repositório passam; estados visuais são inspecionados. |

Sequência de publicação:

1. Passar contrato e testes locais com serviços descartáveis, incluindo ensaio da imagem Evolution.
2. Provisionar Evolution no Dokku sem números de clientes e verificar rede, persistência e saúde.
3. Publicar o Datool pelo fluxo CircleCI vigente, usando a mesma imagem verificada; recurso permanece desabilitado por padrão. Confirmar revisão, migrações e todos os processos necessários, inclusive buildworker.
4. Liberar um projeto interno e conectar número de teste autorizado. Fazer conversa real a partir de outro número, confirmar recebimento real da resposta e testar handoff, desconexão e reinício.
5. Observar por 48 horas como período inicial de piloto, incluindo impacto sobre Datool. Esse período não comprova estabilidade futura nem ausência de banimento.
6. Expandir para até três números voluntários, condicionado à folga medida, sem campanhas. Aumentar limites só após medir memória, filas, erros e impacto.

Separar evidências no relatório: testes locais, CI, imagem implantada, sessão autenticada, envio aceito pelo provedor e mensagem efetivamente recebida no aparelho. Não declarar um desses resultados a partir de outro.

## Retorno e interrupção

- Desabilitar a admissão/automação Evolution por configuração, mantendo a Meta e outros canais ativos. O controle deve valer também para jobs existentes; definir retenção de mensagens já recebidas durante a pausa.
- Drenar ou suspender envios com registro de status; não descartar a fila nem reenviar mensagens incertas.
- Parar apenas o app Evolution se houver pressão de recursos no servidor. Não apagar banco, volume ou credenciais no rollback.
- Reverter imagem somente se compatível com o esquema atual; caso contrário, executar recuperação do backup conforme ensaio e avaliar perda de dados. Nunca assumir rollback de banco automático.

## Pendências para a execução

Release/digest da Evolution; compatibilidade e contrato efetivo; capacidade e versão Dokku do servidor; acesso de provisionamento do novo app; número de teste e titular para escanear; política de retenção/backups e limite inicial de recursos. Essas informações não impedem iniciar a implementação isolada, mas precisam estar resolvidas antes da ativação correspondente. A licença deve ser verificada na revisão escolhida e a interface deve cumprir suas atribuições; o risco de conexão não oficial continua existindo.

## Referências verificadas

- [Criação de instância](https://docs.evolutionfoundation.com.br/evolution-api/create-instance), [QR e conexão](https://docs.evolutionfoundation.com.br/evolution-api/connect-instance) e [webhooks](https://docs.evolutionfoundation.com.br/evolution-api/set-webhook).
- [Composição Docker upstream](https://github.com/evolution-foundation/evolution-api/blob/main/docker-compose.yaml) e [configuração upstream](https://github.com/evolution-foundation/evolution-api/blob/main/.env.example); confirmar novamente na revisão selecionada.
- [Dokku: parada anterior ao novo processo](https://dokku.com/docs/deployment/zero-downtime-deploys/#skipping-and-disabling-checks) e [armazenamento persistente](https://dokku.com/docs/advanced-usage/persistent-storage/).
- Contratos locais: `docs/dokku.md`, `ops/dokku-deploy/README.md`, `migrations/0045_build_channels.sql`, `migrations/0055_whatsapp_channel.sql`, `src/server/build/channels/`, `src/server/build/operations/index.ts` e `components/build/channels/`.
