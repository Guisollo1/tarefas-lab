-- LIBERAR UM USUÁRIO NO KANBAN
-- 1. Crie ou convide a pessoa em Authentication > Users.
-- 2. Troque o e-mail abaixo pelo e-mail exato do usuário.
-- 3. Execute este arquivo no SQL Editor.

select private.add_user_to_lfr_workspace(
  'usuario@empresa.com',
  'member'
);

-- Para tornar a pessoa proprietária, troque member por owner.
