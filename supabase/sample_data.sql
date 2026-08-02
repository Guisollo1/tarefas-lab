-- DADOS DE EXEMPLO OPCIONAIS
-- Execute depois de supabase/schema.sql apenas se desejar exemplos.

begin;

insert into public.people(id,workspace_id,name,color)
values
('21111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','Guilherme Sollo','#0b5cab'),
('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','Equipe LFR','#0b7a75'),
('23333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','Responsável 3','#7a4cb2')
on conflict do nothing;

insert into public.tasks(id,workspace_id,title,description,due_date,priority,status,category)
values
('31111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','Planejar atividades da semana','Definir prioridades, responsáveis e datas de entrega.',current_date,'alta','andamento','Planejamento'),
('32222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','Atualizar registros do laboratório','Conferir os dados pendentes antes do fechamento.',current_date+1,'media','afazer','Laboratório')
on conflict do nothing;

insert into public.task_assignees(workspace_id,task_id,person_id,done)
values
('11111111-1111-4111-8111-111111111111','31111111-1111-4111-8111-111111111111','21111111-1111-4111-8111-111111111111',false),
('11111111-1111-4111-8111-111111111111','31111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',false),
('11111111-1111-4111-8111-111111111111','32222222-2222-4222-8222-222222222222','23333333-3333-4333-8333-333333333333',false)
on conflict do nothing;

commit;
