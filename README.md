# LFR Planejamento Online V3

Kanban semanal e mensal preparado para **GitHub Pages + Supabase**.

## Recursos incluídos

- Login por e-mail e senha com Supabase Auth.
- Banco de dados online PostgreSQL.
- Sincronização em tempo real entre computadores.
- Múltiplos responsáveis na mesma tarefa.
- Conclusão individual: o responsável fica riscado no cartão.
- Conclusão automática da tarefa quando todos terminam.
- Visualização semanal e mensal.
- Filtros, busca, prioridades, categorias e tarefas atrasadas.
- Arrastar tarefas entre colunas.
- Tema claro e escuro.
- Backup e importação JSON.
- RLS: somente usuários autenticados do espaço de trabalho acessam os dados.
- Publicação automática pelo GitHub Actions.

---

# Instalação simples

## Parte 1 — Criar o banco no Supabase

1. Crie um projeto no Supabase.
2. Abra **SQL Editor**.
3. Abra o arquivo `supabase/schema.sql` deste projeto.
4. Copie todo o conteúdo, cole no SQL Editor e clique em **Run**.
5. O resultado final deve mostrar cinco tabelas com `rowsecurity = true`.
6. Opcionalmente execute `supabase/sample_data.sql` para criar exemplos.

O arquivo SQL já cria:

- `workspaces`
- `workspace_members`
- `people`
- `tasks`
- `task_assignees`
- políticas RLS
- índices
- GRANT explícito para a Data API
- publicação Realtime
- função administrativa para liberar usuários no espaço compartilhado

## Parte 2 — Criar os usuários

Para manter o Kanban privado, a configuração padrão do site não permite cadastro público.

1. No Supabase, abra **Authentication > Users**.
2. Use a opção de adicionar ou convidar usuário.
3. Cadastre cada pessoa que poderá entrar no Kanban.
4. Abra `supabase/add_user.sql`.
5. Troque `usuario@empresa.com` pelo e-mail exato que você criou.
6. Execute o arquivo no **SQL Editor**.

Usuários que já existiam antes da execução de `schema.sql` são incluídos automaticamente. Usuários criados depois precisam ser liberados com `add_user.sql`. Isso impede que um cadastro público consiga entrar sozinho no quadro.

## Parte 3 — Obter a configuração do Supabase

1. Abra **Project Settings > API** no Supabase.
2. Copie a **Project URL**.
3. Copie a **Publishable key**. Em projetos antigos, ela pode aparecer como `anon key`.
4. Abra `docs/config.js`.
5. Substitua:

```javascript
supabaseUrl: "COLE_AQUI_A_PROJECT_URL",
publishableKey: "COLE_AQUI_A_PUBLISHABLE_KEY",
```

Não altere o `workspaceId`, porque ele corresponde ao UUID criado por `schema.sql`.

Nunca coloque a chave `service_role` ou uma secret key no GitHub. A Publishable key pode ficar no navegador porque a proteção real é feita pelas políticas RLS.

## Parte 4 — Enviar ao GitHub

### Pelo navegador

1. Crie um repositório no GitHub, por exemplo `lfr-planejamento-online`.
2. Envie todo o conteúdo desta pasta, incluindo `.github`, `docs` e `supabase`.
3. Confirme que a branch principal se chama `main`.
4. Abra **Settings > Pages**.
5. Em **Source**, selecione **GitHub Actions**.
6. Abra a aba **Actions** e aguarde a execução `Publicar Kanban no GitHub Pages` terminar.
7. O endereço ficará parecido com:

```text
https://SEU-USUARIO.github.io/lfr-planejamento-online/
```

### Pelo GitHub Desktop

1. Extraia o ZIP.
2. No GitHub Desktop, escolha **Add existing repository** ou crie um repositório usando esta pasta.
3. Publique o repositório.
4. Faça commit e push depois de editar `docs/config.js`.
5. Ative GitHub Actions em **Settings > Pages**.

## Parte 5 — Configurar as URLs do Auth

Depois de saber o endereço publicado:

1. No Supabase, abra **Authentication > URL Configuration**.
2. Defina **Site URL** com o endereço completo do GitHub Pages.
3. Adicione o mesmo endereço em **Redirect URLs**.

Exemplo:

```text
https://SEU-USUARIO.github.io/lfr-planejamento-online/
```

## Atualizações futuras

Sempre que você alterar e enviar arquivos para a branch `main`, o GitHub Actions publica automaticamente a nova versão.

## Estrutura

```text
.github/workflows/pages.yml  publicação automática
docs/index.html              interface
docs/styles.css              aparência
docs/app.js                  funções e integração Supabase
docs/config.js               URL e chave publicável
supabase/schema.sql           banco, segurança e Realtime
supabase/sample_data.sql      dados opcionais
supabase/add_user.sql         libera cada usuário no quadro
```

## Segurança

- Nenhuma chave administrativa está no site.
- Acesso anônimo foi removido das tabelas.
- Todas as tabelas expostas têm RLS ativado.
- As políticas exigem que o usuário pertença ao espaço de trabalho.
- `service_role` nunca deve ser enviada ao navegador ou ao GitHub.
- O cadastro público está desativado no `config.js`.

## Licença

Uso interno e adaptação permitidos. Desenvolvido para o projeto LFR por Guilherme Sollo.
