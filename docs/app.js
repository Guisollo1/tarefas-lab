import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.8/+esm';

const CONFIG = window.KANBAN_CONFIG || {};
const THEME_KEY = 'lfr_planejamento_online_theme';
const CACHE_KEY = 'lfr_planejamento_online_cache_v3';
const statusOrder = ['planejado', 'afazer', 'andamento', 'concluido'];
const statusLabels = { planejado:'Planejado', afazer:'A fazer', andamento:'Em andamento', concluido:'Concluído' };
const priorityColors = { alta:'#d94b45', media:'#e09f1f', baixa:'#2f8e67' };

const $ = (id) => document.getElementById(id);
const esc = (value='') => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch]));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let supabase = null;
let session = null;
let realtimeChannel = null;
let reloadTimer = null;
let state = { people:[], tasks:[] };
let viewMode = 'week';
let cursorDate = new Date();
let selectedPerson = 'all';
let selectedDay = 'all';
let editingTaskId = null;
let draggedTaskId = null;
let loadingDepth = 0;

function isConfigured(){
  return Boolean(
    CONFIG.supabaseUrl && CONFIG.publishableKey && CONFIG.workspaceId &&
    !CONFIG.supabaseUrl.includes('COLE_AQUI') &&
    !CONFIG.publishableKey.includes('COLE_AQUI')
  );
}

function localISO(date){
  const y=date.getFullYear(); const m=String(date.getMonth()+1).padStart(2,'0'); const d=String(date.getDate()).padStart(2,'0');
  return `${y}-${m}-${d}`;
}
function parseISO(value){ const [y,m,d]=value.split('-').map(Number); return new Date(y,m-1,d); }
function addDays(date,days){ const result=new Date(date); result.setDate(result.getDate()+days); return result; }
function startOfWeek(date){ const result=new Date(date); const day=result.getDay(); result.setDate(result.getDate()+(day===0?-6:1-day)); result.setHours(0,0,0,0); return result; }
function endOfWeek(date){ return addDays(startOfWeek(date),6); }
function formatShortDate(value){ return value ? parseISO(value).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'}) : 'Sem data'; }
function initials(name=''){ return name.trim().split(/\s+/).slice(0,2).map(p=>p[0]?.toUpperCase()||'').join(''); }
function getPerson(id){ return state.people.find(p=>p.id===id) || {id:'none',name:'Responsável removido',color:'#778395'}; }
function getTaskAssignees(task){ return Array.isArray(task.assignees) ? task.assignees : []; }
function taskHasPerson(task,personId){ return getTaskAssignees(task).some(item=>item.personId===personId); }
function assigneeNames(task){ return getTaskAssignees(task).map(item=>getPerson(item.personId).name); }

function setLoading(active,text='Sincronizando dados...'){
  loadingDepth = Math.max(0, loadingDepth + (active ? 1 : -1));
  $('loadingText').textContent=text;
  $('loadingCover').classList.toggle('hidden', loadingDepth===0);
}
function setAuthMessage(message,isError=false){
  $('authMessage').textContent=message;
  $('authMessage').classList.toggle('error',isError);
}
function showToast(message){
  const toast=$('toast'); toast.textContent=message; toast.classList.add('show');
  clearTimeout(showToast.timer); showToast.timer=setTimeout(()=>toast.classList.remove('show'),2600);
}
function setConnection(status,label){
  const badge=$('connectionBadge'); badge.className=`connection-badge ${status}`; badge.querySelector('span').textContent=label;
}
function friendlyError(error){
  const message=error?.message || String(error || 'Erro desconhecido');
  if(message.includes('Invalid login credentials')) return 'E-mail ou senha incorretos.';
  if(message.includes('Email not confirmed')) return 'Confirme seu e-mail antes de entrar.';
  if(message.includes('permission denied')) return 'Permissão negada. Execute novamente o arquivo supabase/schema.sql.';
  if(message.includes('Failed to fetch')) return 'Não foi possível alcançar o Supabase. Confira a internet e a configuração.';
  return message;
}

function periodRange(){
  if(viewMode==='week') return {start:startOfWeek(cursorDate),end:endOfWeek(cursorDate)};
  return {start:new Date(cursorDate.getFullYear(),cursorDate.getMonth(),1),end:new Date(cursorDate.getFullYear(),cursorDate.getMonth()+1,0)};
}
function isInPeriod(task){
  if(!task.dueDate) return false;
  const date=parseISO(task.dueDate); const {start,end}=periodRange(); return date>=start && date<=end;
}
function isOverdue(task){
  if(!task.dueDate || task.status==='concluido') return false;
  const taskDate=parseISO(task.dueDate); const current=new Date(); current.setHours(0,0,0,0); return taskDate<current;
}
function filteredTasks(){
  const term=$('searchInput').value.trim().toLowerCase(); const priority=$('priorityFilter').value; const category=$('categoryFilter').value;
  return state.tasks
    .filter(isInPeriod)
    .filter(t=>selectedPerson==='all' || taskHasPerson(t,selectedPerson))
    .filter(t=>selectedDay==='all' || t.dueDate===selectedDay)
    .filter(t=>priority==='all' || t.priority===priority)
    .filter(t=>category==='all' || (t.category||'')===category)
    .filter(t=>!term || [t.title,t.description,t.category,...assigneeNames(t)].join(' ').toLowerCase().includes(term))
    .sort((a,b)=>(a.dueDate||'').localeCompare(b.dueDate||'') || a.title.localeCompare(b.title,'pt-BR'));
}

async function initialize(){
  const savedTheme=localStorage.getItem(THEME_KEY); if(savedTheme==='dark') document.body.classList.add('dark');
  bindEvents();
  $('signupBtn').classList.toggle('hidden',!CONFIG.allowSignup);

  if(!isConfigured()){
    $('configurationHelp').classList.remove('hidden');
    setAuthMessage('Configure o arquivo config.js antes de entrar.',true);
    $('loginForm').querySelectorAll('input,button').forEach(el=>el.disabled=true);
    return;
  }

  supabase=createClient(CONFIG.supabaseUrl,CONFIG.publishableKey,{
    auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}
  });

  const {data,error}=await supabase.auth.getSession();
  if(error) setAuthMessage(friendlyError(error),true);
  session=data?.session||null;

  supabase.auth.onAuthStateChange(async (_event,newSession)=>{
    session=newSession;
    if(session) await enterApplication(); else leaveApplication();
  });

  if(session) await enterApplication();
}

async function enterApplication(){
  if(!session?.user) return;
  const {data:membership,error:membershipError}=await supabase
    .from('workspace_members')
    .select('role')
    .eq('workspace_id',CONFIG.workspaceId)
    .eq('user_id',session.user.id)
    .maybeSingle();
  if(membershipError){
    setAuthMessage(friendlyError(membershipError),true);
    await supabase.auth.signOut();
    return;
  }
  if(!membership){
    const email=session.user.email||'este usuário';
    await supabase.auth.signOut();
    setAuthMessage(`${email} ainda não foi liberado no Kanban. Execute supabase/add_user.sql no Supabase.`,true);
    return;
  }
  document.body.classList.remove('auth-mode');
  $('authView').classList.add('hidden');
  $('appRoot').classList.remove('hidden');
  $('userEmail').textContent=session.user.email||'Usuário';
  setConnection('','Conectando');
  await loadData(true);
  subscribeRealtime();
}
function leaveApplication(){
  if(realtimeChannel && supabase){ supabase.removeChannel(realtimeChannel); realtimeChannel=null; }
  $('appRoot').classList.add('hidden'); $('authView').classList.remove('hidden'); document.body.classList.add('auth-mode');
  state={people:[],tasks:[]}; setAuthMessage('Entre com o usuário cadastrado no Supabase.');
}

async function login(event){
  event.preventDefault(); if(!supabase) return;
  const email=$('loginEmail').value.trim(); const password=$('loginPassword').value;
  setAuthMessage('Entrando...');
  const {error}=await supabase.auth.signInWithPassword({email,password});
  if(error) setAuthMessage(friendlyError(error),true);
}
async function signup(){
  if(!CONFIG.allowSignup || !supabase) return;
  const email=$('loginEmail').value.trim(); const password=$('loginPassword').value;
  if(!email || password.length<6){ setAuthMessage('Informe um e-mail e uma senha com pelo menos 6 caracteres.',true); return; }
  const {data,error}=await supabase.auth.signUp({email,password,options:{emailRedirectTo:window.location.href}});
  if(error){ setAuthMessage(friendlyError(error),true); return; }
  setAuthMessage(data.session?'Conta criada e conectada.':'Conta criada. Confira o e-mail de confirmação.');
}
async function logout(){ if(supabase) await supabase.auth.signOut(); }

async function loadData(showCover=false){
  if(!supabase || !session) return;
  if(showCover) setLoading(true,'Carregando o Kanban online...');
  try{
    const [peopleResult,tasksResult,assigneeResult]=await Promise.all([
      supabase.from('people').select('id,name,color,active,created_at,updated_at').eq('workspace_id',CONFIG.workspaceId).eq('active',true).order('name'),
      supabase.from('tasks').select('id,title,description,due_date,priority,status,category,created_at,updated_at').eq('workspace_id',CONFIG.workspaceId).order('due_date'),
      supabase.from('task_assignees').select('task_id,person_id,done,done_at,done_by').eq('workspace_id',CONFIG.workspaceId)
    ]);
    for(const result of [peopleResult,tasksResult,assigneeResult]) if(result.error) throw result.error;
    const assignmentsByTask=new Map();
    for(const row of assigneeResult.data||[]){
      const list=assignmentsByTask.get(row.task_id)||[];
      list.push({personId:row.person_id,done:Boolean(row.done),doneAt:row.done_at,doneBy:row.done_by});
      assignmentsByTask.set(row.task_id,list);
    }
    state={
      people:(peopleResult.data||[]).map(p=>({...p})),
      tasks:(tasksResult.data||[]).map(t=>({
        id:t.id,title:t.title,description:t.description||'',dueDate:t.due_date,priority:t.priority,status:t.status,category:t.category||'',
        createdAt:t.created_at,updatedAt:t.updated_at,assignees:assignmentsByTask.get(t.id)||[]
      }))
    };
    localStorage.setItem(CACHE_KEY,JSON.stringify(state));
    render(); setConnection('online','Online');
  }catch(error){
    console.error(error); setConnection('offline','Sem conexão');
    const cached=localStorage.getItem(CACHE_KEY);
    if(cached){ try{state=JSON.parse(cached);render();showToast('Exibindo o último conteúdo salvo neste navegador.');}catch{} }
    else showToast(friendlyError(error));
  }finally{ if(showCover) setLoading(false); }
}

function subscribeRealtime(){
  if(realtimeChannel) supabase.removeChannel(realtimeChannel);
  realtimeChannel=supabase.channel(`kanban-${CONFIG.workspaceId}`)
    .on('postgres_changes',{event:'*',schema:'public',table:'people'},scheduleReload)
    .on('postgres_changes',{event:'*',schema:'public',table:'tasks'},scheduleReload)
    .on('postgres_changes',{event:'*',schema:'public',table:'task_assignees'},scheduleReload)
    .subscribe(status=>{
      if(status==='SUBSCRIBED') setConnection('online','Online');
      else if(status==='CHANNEL_ERROR' || status==='TIMED_OUT') setConnection('offline','Reconectando');
      else if(status==='CLOSED') setConnection('offline','Desconectado');
    });
}
function scheduleReload(){ clearTimeout(reloadTimer); reloadTimer=setTimeout(()=>loadData(false),220); }

function render(){ renderPeriodTitle(); renderMonthStrip(); renderPeople(); renderCategoryFilter(); renderBoard(); renderMetrics(); }
function renderPeriodTitle(){
  const {start,end}=periodRange();
  if(viewMode==='week'){
    const sameMonth=start.getMonth()===end.getMonth(); const sameYear=start.getFullYear()===end.getFullYear();
    $('periodTitle').textContent=sameMonth ? `${start.getDate()}–${end.getDate()} de ${start.toLocaleDateString('pt-BR',{month:'long',year:'numeric'})}` :
      sameYear ? `${start.toLocaleDateString('pt-BR',{day:'2-digit',month:'short'})} – ${end.toLocaleDateString('pt-BR',{day:'2-digit',month:'short',year:'numeric'})}` :
      `${start.toLocaleDateString('pt-BR')} – ${end.toLocaleDateString('pt-BR')}`;
  }else{
    const text=cursorDate.toLocaleDateString('pt-BR',{month:'long',year:'numeric'}); $('periodTitle').textContent=text.charAt(0).toUpperCase()+text.slice(1);
  }
}
function renderMonthStrip(){
  const strip=$('monthStrip'); strip.innerHTML=''; strip.classList.toggle('visible',viewMode==='week'); if(viewMode!=='week') return;
  const start=startOfWeek(cursorDate); const weekday=['Seg','Ter','Qua','Qui','Sex','Sáb','Dom'];
  for(let i=0;i<7;i++){
    const day=addDays(start,i); const iso=localISO(day); const count=state.tasks.filter(t=>t.dueDate===iso).length; const btn=document.createElement('button');
    btn.type='button'; btn.className='day-pill'; if(selectedDay===iso) btn.classList.add('active'); if(count) btn.classList.add('has-tasks');
    btn.innerHTML=`<small>${weekday[i]}</small><strong>${String(day.getDate()).padStart(2,'0')}</strong>${count?`<small>${count} tarefa${count>1?'s':''}</small>`:'<small>livre</small>'}`;
    btn.addEventListener('click',()=>{selectedDay=selectedDay===iso?'all':iso;renderBoard();renderMetrics();renderMonthStrip();}); strip.appendChild(btn);
  }
}
function renderPeople(){
  const wrapper=$('personFilters'); wrapper.innerHTML=''; $('peopleCount').textContent=state.people.length; const periodTasks=state.tasks.filter(isInPeriod);
  const allBtn=document.createElement('button'); allBtn.type='button'; allBtn.className=`person-filter ${selectedPerson==='all'?'active':''}`;
  allBtn.innerHTML=`<span class="avatar" style="background:#526172">T</span><span class="name">Todos</span><small>${periodTasks.length}</small>`;
  allBtn.addEventListener('click',()=>{selectedPerson='all';render();closeSidebarOnMobile();}); wrapper.appendChild(allBtn);
  state.people.forEach(person=>{
    const count=periodTasks.filter(t=>taskHasPerson(t,person.id)).length; const btn=document.createElement('button'); btn.type='button'; btn.className=`person-filter ${selectedPerson===person.id?'active':''}`;
    btn.innerHTML=`<span class="avatar" style="background:${esc(person.color)}">${esc(initials(person.name))}</span><span class="name">${esc(person.name)}</span><small>${count}</small>`;
    btn.addEventListener('click',()=>{selectedPerson=person.id;render();closeSidebarOnMobile();}); wrapper.appendChild(btn);
  });
}
function renderCategoryFilter(){
  const select=$('categoryFilter'); const current=select.value; const categories=[...new Set(state.tasks.map(t=>(t.category||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'pt-BR'));
  select.innerHTML='<option value="all">Todas as categorias</option>'+categories.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join(''); if(categories.includes(current)) select.value=current;
}
function renderBoard(){
  const tasks=filteredTasks();
  statusOrder.forEach(status=>{ const list=tasks.filter(t=>t.status===status); const col=$(`col-${status}`); $(`count-${status}`).textContent=list.length; col.innerHTML='';
    if(!list.length) col.innerHTML='<div class="empty">Nenhuma tarefa nesta etapa.</div>'; else list.forEach(task=>col.appendChild(taskCard(task))); });
}
function taskCard(task){
  const assignments=getTaskAssignees(task); const doneCount=assignments.filter(a=>a.done).length; const late=isOverdue(task); const card=document.createElement('article');
  card.className=`task-card ${late?'overdue':''}`; card.draggable=true; card.dataset.id=task.id;
  const assigneesHtml=assignments.map(item=>{ const person=getPerson(item.personId); return `<button class="assignee-chip ${item.done?'done':''}" type="button" data-person-id="${esc(person.id)}" title="Clique para ${item.done?'reabrir':'concluir'} a participação de ${esc(person.name)}"><span class="avatar" style="background:${esc(person.color)}">${esc(initials(person.name))}</span><span class="assignee-chip-name">${esc(person.name)}</span><span class="assignee-chip-check">${item.done?'✓':'○'}</span></button>`; }).join('');
  card.innerHTML=`<div class="task-top"><i class="priority" style="background:${priorityColors[task.priority]||priorityColors.media}" title="Prioridade ${esc(task.priority)}"></i><div class="task-title">${esc(task.title)}</div></div>
    ${task.description?`<div class="task-description">${esc(task.description)}</div>`:''}${task.category?`<div class="tags"><span class="tag">${esc(task.category)}</span></div>`:''}
    <div class="assignee-list">${assigneesHtml||'<span style="font-size:11px;color:var(--muted)">Sem responsável</span>'}</div>
    <div class="assignee-progress">${doneCount}/${assignments.length} responsável${assignments.length===1?'':'is'} concluíram</div>
    <div class="task-footer"><div class="date-chip ${late?'late':''}">${late?'⚠ ':''}${formatShortDate(task.dueDate)}</div><div style="font-size:10px;color:var(--muted)">${statusLabels[task.status]}</div></div>`;
  card.addEventListener('click',event=>{ if(event.target.closest('.assignee-chip')) return; openTaskModal(task.id); });
  card.querySelectorAll('.assignee-chip').forEach(button=>button.addEventListener('click',async event=>{event.stopPropagation();await toggleAssigneeDone(task.id,button.dataset.personId);}));
  card.addEventListener('dragstart',event=>{draggedTaskId=task.id;card.classList.add('dragging');event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',task.id);});
  card.addEventListener('dragend',()=>{draggedTaskId=null;card.classList.remove('dragging');document.querySelectorAll('.column').forEach(c=>c.classList.remove('drag-over'));});
  return card;
}
function renderMetrics(){
  const tasks=filteredTasks(); const done=tasks.filter(t=>t.status==='concluido').length; const late=tasks.filter(isOverdue).length; const progress=tasks.filter(t=>t.status==='andamento').length; const percent=tasks.length?Math.round(done/tasks.length*100):0;
  $('metricTotal').textContent=tasks.length;$('metricDone').textContent=done;$('metricLate').textContent=late;$('metricProgress').textContent=progress;$('metricPercent').textContent=`${percent}%`;$('metricBar').style.width=`${percent}%`;
}

function renderTaskAssigneePicker(assignments=[]){
  const selected=new Set(assignments.map(a=>a.personId)); const picker=$('taskAssigneePicker'); picker.innerHTML='';
  if(!state.people.length){picker.innerHTML='<div class="empty" style="grid-column:1/-1">Cadastre um responsável primeiro.</div>';return;}
  state.people.forEach(person=>{ const wrap=document.createElement('div'); wrap.className='assignee-option'; const inputId=`assignee_${person.id}`;
    wrap.innerHTML=`<input id="${inputId}" type="checkbox" value="${esc(person.id)}" ${selected.has(person.id)?'checked':''}><label for="${inputId}"><span class="avatar" style="background:${esc(person.color)}">${esc(initials(person.name))}</span><span>${esc(person.name)}</span></label>`; picker.appendChild(wrap); });
}
function selectedAssigneeIds(){ return [...$('taskAssigneePicker').querySelectorAll('input[type="checkbox"]:checked')].map(input=>input.value); }
function openTaskModal(taskId=null){
  if(!state.people.length){showToast('Cadastre pelo menos um responsável.');openTeamModal();return;}
  editingTaskId=taskId; const task=state.tasks.find(t=>t.id===taskId); $('taskModalTitle').textContent=task?'Editar tarefa':'Nova tarefa'; $('taskTitle').value=task?.title||''; $('taskDescription').value=task?.description||'';
  const initial=task?.assignees || (selectedPerson!=='all'?[{personId:selectedPerson}]:[]); renderTaskAssigneePicker(initial); $('taskDueDate').value=task?.dueDate||defaultTaskDate(); $('taskPriority').value=task?.priority||'media'; $('taskStatus').value=task?.status||'afazer'; $('taskCategory').value=task?.category||'';
  $('deleteTaskBtn').classList.toggle('hidden',!task); $('taskModalBackdrop').classList.remove('hidden'); setTimeout(()=>$('taskTitle').focus(),30);
}
function closeTaskModal(){ $('taskModalBackdrop').classList.add('hidden'); editingTaskId=null; $('taskForm').reset(); }
function defaultTaskDate(){ if(selectedDay!=='all') return selectedDay; const {start,end}=periodRange(); const current=new Date(); return localISO(current>=start&&current<=end?current:start); }

async function saveTask(event){
  event.preventDefault(); const assigneeIds=selectedAssigneeIds();
  const payload={workspace_id:CONFIG.workspaceId,title:$('taskTitle').value.trim(),description:$('taskDescription').value.trim()||null,due_date:$('taskDueDate').value,priority:$('taskPriority').value,status:$('taskStatus').value,category:$('taskCategory').value.trim()||null,updated_by:session.user.id};
  if(!payload.title || !payload.due_date || !assigneeIds.length){showToast('Preencha título, data e pelo menos um responsável.');return;}
  const wasEditing=Boolean(editingTaskId);
  setLoading(true,wasEditing?'Atualizando tarefa...':'Criando tarefa...');
  try{
    let taskId=editingTaskId;
    if(taskId){ const {error}=await supabase.from('tasks').update(payload).eq('id',taskId).eq('workspace_id',CONFIG.workspaceId); if(error) throw error; }
    else{ const {data,error}=await supabase.from('tasks').insert({...payload,created_by:session.user.id}).select('id').single(); if(error) throw error; taskId=data.id; }

    const existing=state.tasks.find(t=>t.id===taskId)?.assignees||[]; const existingIds=new Set(existing.map(a=>a.personId)); const selectedSet=new Set(assigneeIds);
    const removed=[...existingIds].filter(id=>!selectedSet.has(id)); const added=assigneeIds.filter(id=>!existingIds.has(id));
    if(removed.length){ const {error}=await supabase.from('task_assignees').delete().eq('workspace_id',CONFIG.workspaceId).eq('task_id',taskId).in('person_id',removed); if(error) throw error; }
    if(added.length){ const rows=added.map(personId=>({workspace_id:CONFIG.workspaceId,task_id:taskId,person_id:personId,done:false})); const {error}=await supabase.from('task_assignees').insert(rows); if(error) throw error; }
    if(payload.status==='concluido'){
      const {error}=await supabase.from('task_assignees').update({done:true,done_at:new Date().toISOString(),done_by:session.user.id}).eq('workspace_id',CONFIG.workspaceId).eq('task_id',taskId); if(error) throw error;
    }
    closeTaskModal(); await loadData(false); showToast(wasEditing?'Tarefa atualizada.':'Tarefa criada.');
  }catch(error){console.error(error);showToast(friendlyError(error));}
  finally{setLoading(false);}
}
async function deleteTask(){
  if(!editingTaskId) return; const task=state.tasks.find(t=>t.id===editingTaskId); if(!task || !confirm(`Excluir a tarefa "${task.title}"?`)) return;
  setLoading(true,'Excluindo tarefa...'); try{ const {error}=await supabase.from('tasks').delete().eq('id',editingTaskId).eq('workspace_id',CONFIG.workspaceId); if(error) throw error; closeTaskModal(); await loadData(false); showToast('Tarefa excluída.'); }catch(error){showToast(friendlyError(error));}finally{setLoading(false);}
}
async function toggleAssigneeDone(taskId,personId){
  const task=state.tasks.find(t=>t.id===taskId); const assignment=task?.assignees.find(a=>a.personId===personId); if(!assignment) return; const next=!assignment.done;
  try{
    const {error}=await supabase.from('task_assignees').update({done:next,done_at:next?new Date().toISOString():null,done_by:next?session.user.id:null}).eq('workspace_id',CONFIG.workspaceId).eq('task_id',taskId).eq('person_id',personId); if(error) throw error;
    const {data,error:fetchError}=await supabase.from('task_assignees').select('done').eq('workspace_id',CONFIG.workspaceId).eq('task_id',taskId); if(fetchError) throw fetchError;
    const allDone=data.length>0 && data.every(row=>row.done); let targetStatus=task.status;
    if(allDone) targetStatus='concluido'; else if(task.status==='concluido') targetStatus='andamento';
    if(targetStatus!==task.status){ const {error:statusError}=await supabase.from('tasks').update({status:targetStatus,updated_by:session.user.id}).eq('workspace_id',CONFIG.workspaceId).eq('id',taskId); if(statusError) throw statusError; }
    await loadData(false); showToast(next?'Participação concluída.':'Participação reaberta.');
  }catch(error){showToast(friendlyError(error));}
}
async function moveTask(taskId,newStatus){
  const task=state.tasks.find(t=>t.id===taskId); if(!task || task.status===newStatus) return;
  try{
    const {error}=await supabase.from('tasks').update({status:newStatus,updated_by:session.user.id}).eq('workspace_id',CONFIG.workspaceId).eq('id',taskId); if(error) throw error;
    if(newStatus==='concluido'){
      const {error:assignmentError}=await supabase.from('task_assignees').update({done:true,done_at:new Date().toISOString(),done_by:session.user.id}).eq('workspace_id',CONFIG.workspaceId).eq('task_id',taskId); if(assignmentError) throw assignmentError;
    }
    await loadData(false); showToast(`Movida para ${statusLabels[newStatus]}.`);
  }catch(error){showToast(friendlyError(error));}
}

function openTeamModal(){renderTeamEditor();$('teamModalBackdrop').classList.remove('hidden');setTimeout(()=>$('newPersonName').focus(),30);}
function closeTeamModal(){$('teamModalBackdrop').classList.add('hidden');render();}
function renderTeamEditor(){
  const list=$('teamEditorList'); list.innerHTML=''; if(!state.people.length){list.innerHTML='<div class="empty">Nenhum responsável cadastrado.</div>';return;}
  state.people.forEach(person=>{ const used=state.tasks.filter(t=>taskHasPerson(t,person.id)).length; const row=document.createElement('div'); row.className='team-row';
    row.innerHTML=`<span class="avatar" style="background:${esc(person.color)}">${esc(initials(person.name))}</span><div><strong style="font-size:13px">${esc(person.name)}</strong><div style="font-size:11px;color:var(--muted)">${used} tarefa${used===1?'':'s'}</div></div><button class="btn small" type="button">Remover</button>`;
    row.querySelector('button').addEventListener('click',()=>removePerson(person.id)); list.appendChild(row); });
}
async function addPerson(){
  const name=$('newPersonName').value.trim(); const color=$('newPersonColor').value; if(!name){showToast('Digite o nome do responsável.');return;}
  if(state.people.some(p=>p.name.toLowerCase()===name.toLowerCase())){showToast('Esse responsável já existe.');return;}
  try{const {error}=await supabase.from('people').insert({workspace_id:CONFIG.workspaceId,name,color,created_by:session.user.id});if(error)throw error;$('newPersonName').value='';await loadData(false);renderTeamEditor();showToast('Responsável adicionado.');}catch(error){showToast(friendlyError(error));}
}
async function removePerson(id){
  const person=getPerson(id); const used=state.tasks.filter(t=>taskHasPerson(t,id)).length; if(used){showToast(`Retire ${person.name} de ${used} tarefa(s) antes de remover.`);return;} if(!confirm(`Remover ${person.name}?`))return;
  try{const {error}=await supabase.from('people').delete().eq('workspace_id',CONFIG.workspaceId).eq('id',id);if(error)throw error;if(selectedPerson===id)selectedPerson='all';await loadData(false);renderTeamEditor();showToast('Responsável removido.');}catch(error){showToast(friendlyError(error));}
}

function setMode(mode){viewMode=mode;selectedDay='all';$('weekModeBtn').classList.toggle('active',mode==='week');$('monthModeBtn').classList.toggle('active',mode==='month');render();}
function shiftPeriod(direction){cursorDate=viewMode==='week'?addDays(cursorDate,7*direction):new Date(cursorDate.getFullYear(),cursorDate.getMonth()+direction,1);selectedDay='all';render();}
function resetFilters(){selectedPerson='all';selectedDay='all';$('searchInput').value='';$('priorityFilter').value='all';$('categoryFilter').value='all';render();showToast('Filtros limpos.');}
function closeSidebarOnMobile(){if(window.innerWidth<=850)$('sidebar').classList.remove('open');}

function exportData(){
  const backup={version:3,exportedAt:new Date().toISOString(),people:state.people.map(p=>({id:p.id,name:p.name,color:p.color})),tasks:state.tasks.map(t=>({id:t.id,title:t.title,description:t.description,assignees:t.assignees,dueDate:t.dueDate,priority:t.priority,status:t.status,category:t.category}))};
  const blob=new Blob([JSON.stringify(backup,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`LFR_Planejamento_Online_Backup_${localISO(new Date())}.json`;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);showToast('Backup exportado.');
}
async function importBackup(file){
  if(!file)return; if(!confirm('Importar este backup para o Supabase? Os registros serão adicionados ao conteúdo atual.'))return;
  setLoading(true,'Importando backup para o Supabase...');
  try{
    const backup=JSON.parse(await file.text()); if(!Array.isArray(backup.people)||!Array.isArray(backup.tasks))throw new Error('Arquivo de backup inválido.');
    const oldToNew=new Map();
    for(const oldPerson of backup.people){
      let found=state.people.find(p=>p.name.trim().toLowerCase()===String(oldPerson.name||'').trim().toLowerCase());
      if(!found){const {data,error}=await supabase.from('people').insert({workspace_id:CONFIG.workspaceId,name:String(oldPerson.name||'Responsável').trim(),color:oldPerson.color||'#0b5cab',created_by:session.user.id}).select('id,name,color').single();if(error)throw error;found=data;state.people.push(found);}
      oldToNew.set(oldPerson.id,found.id);
    }
    for(const oldTask of backup.tasks){
      const rawAssignees=Array.isArray(oldTask.assignees)?oldTask.assignees:(oldTask.assigneeId?[{personId:oldTask.assigneeId,done:oldTask.status==='concluido'}]:[]);
      const {data,error}=await supabase.from('tasks').insert({workspace_id:CONFIG.workspaceId,title:String(oldTask.title||'Tarefa importada').trim(),description:oldTask.description||null,due_date:oldTask.dueDate||localISO(new Date()),priority:['alta','media','baixa'].includes(oldTask.priority)?oldTask.priority:'media',status:statusOrder.includes(oldTask.status)?oldTask.status:'afazer',category:oldTask.category||null,created_by:session.user.id,updated_by:session.user.id}).select('id').single(); if(error)throw error;
      const rows=rawAssignees.map(a=>({workspace_id:CONFIG.workspaceId,task_id:data.id,person_id:oldToNew.get(a.personId),done:Boolean(a.done),done_at:a.done?new Date().toISOString():null,done_by:a.done?session.user.id:null})).filter(r=>r.person_id);
      if(rows.length){const {error:assignmentError}=await supabase.from('task_assignees').insert(rows);if(assignmentError)throw assignmentError;}
    }
    await loadData(false);showToast('Backup importado com sucesso.');
  }catch(error){console.error(error);showToast(friendlyError(error));}finally{$('importFile').value='';setLoading(false);}
}

function bindEvents(){
  $('loginForm').addEventListener('submit',login);$('signupBtn').addEventListener('click',signup);$('logoutBtn').addEventListener('click',logout);
  $('weekModeBtn').addEventListener('click',()=>setMode('week'));$('monthModeBtn').addEventListener('click',()=>setMode('month'));$('prevPeriodBtn').addEventListener('click',()=>shiftPeriod(-1));$('nextPeriodBtn').addEventListener('click',()=>shiftPeriod(1));$('todayBtn').addEventListener('click',()=>{cursorDate=new Date();selectedDay='all';render();});
  [$('newTaskBtn'),$('toolbarNewTaskBtn')].forEach(btn=>btn.addEventListener('click',()=>openTaskModal()));[$('teamBtn'),$('managePeopleBtn')].forEach(btn=>btn.addEventListener('click',openTeamModal));
  $('closeTaskModalBtn').addEventListener('click',closeTaskModal);$('cancelTaskBtn').addEventListener('click',closeTaskModal);$('taskForm').addEventListener('submit',saveTask);$('deleteTaskBtn').addEventListener('click',deleteTask);
  $('closeTeamModalBtn').addEventListener('click',closeTeamModal);$('doneTeamBtn').addEventListener('click',closeTeamModal);$('addPersonBtn').addEventListener('click',addPerson);$('newPersonName').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();addPerson();}});
  $('searchInput').addEventListener('input',()=>{renderBoard();renderMetrics();});$('priorityFilter').addEventListener('change',()=>{renderBoard();renderMetrics();});$('categoryFilter').addEventListener('change',()=>{renderBoard();renderMetrics();});$('clearFiltersBtn').addEventListener('click',resetFilters);
  $('exportBtn').addEventListener('click',exportData);$('importBtn').addEventListener('click',()=>$('importFile').click());$('importFile').addEventListener('change',event=>importBackup(event.target.files?.[0]));
  $('mobileSidebarBtn').addEventListener('click',()=>$('sidebar').classList.toggle('open'));
  $('taskModalBackdrop').addEventListener('click',event=>{if(event.target===$('taskModalBackdrop'))closeTaskModal();});$('teamModalBackdrop').addEventListener('click',event=>{if(event.target===$('teamModalBackdrop'))closeTeamModal();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'){if(!$('taskModalBackdrop').classList.contains('hidden'))closeTaskModal();if(!$('teamModalBackdrop').classList.contains('hidden'))closeTeamModal();$('sidebar').classList.remove('open');}});
  $('themeBtn').addEventListener('click',()=>{document.body.classList.toggle('dark');localStorage.setItem(THEME_KEY,document.body.classList.contains('dark')?'dark':'light');});
  document.querySelectorAll('.column').forEach(column=>{
    column.addEventListener('dragover',event=>{event.preventDefault();event.dataTransfer.dropEffect='move';column.classList.add('drag-over');});column.addEventListener('dragleave',()=>column.classList.remove('drag-over'));
    column.addEventListener('drop',event=>{event.preventDefault();column.classList.remove('drag-over');const taskId=event.dataTransfer.getData('text/plain')||draggedTaskId;moveTask(taskId,column.dataset.status);});
  });
}

initialize().catch(error=>{console.error(error);setAuthMessage(friendlyError(error),true);});
