import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.8/+esm';

const CONFIG = window.KANBAN_CONFIG || {};
const THEME_KEY = 'lfr_planejamento_online_theme';
const CACHE_KEY = 'lfr_planejamento_online_cache_v5';
const statusOrder = ['planejado', 'afazer', 'andamento', 'concluido'];
const statusLabels = { planejado:'Planejado', afazer:'A fazer', andamento:'Em andamento', concluido:'Concluído' };
const priorityColors = { alta:'#d94b45', media:'#e09f1f', baixa:'#2f8e67' };
const eventTypeLabels = { visita:'Visita', visita_tecnica:'Visita técnica', apresentacao:'Apresentação', manutencao:'Manutenção', queda_luz:'Queda de luz', treinamento:'Treinamento', reuniao:'Reunião', auditoria:'Auditoria', seguranca:'Segurança', outro:'Outro' };
const defaultColors = ['#0b5cab','#7a4cb2','#2f8e67','#c56c24','#d94b45','#0b7a75','#526172','#8c6d1f'];

const $ = (id) => document.getElementById(id);
const esc = (value='') => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch]));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let supabase = null;
let session = null;
let realtimeChannel = null;
let reloadTimer = null;
let state = { people:[], tasks:[], events:[] };
let viewMode = 'week';
let cursorDate = new Date();
let selectedPerson = 'all';
let selectedDay = 'all';
let editingTaskId = null;
let editingEventId = null;
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
function isEventInPeriod(event){ if(!event.eventDate) return false; const date=parseISO(event.eventDate); const {start,end}=periodRange(); return date>=start && date<=end; }
function filteredEvents(){ return state.events.filter(isEventInPeriod).sort((a,b)=>(a.eventDate||'').localeCompare(b.eventDate||'') || (a.title||'').localeCompare(b.title||'', 'pt-BR')); }
function normalizeText(value){ return String(value||'').trim(); }
function splitNames(value){ return normalizeText(value).split(/[;,|]/).map(v=>v.trim()).filter(Boolean); }
function statusFromText(value){ const raw=normalizeText(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,''); if(['planejado','planejamento'].includes(raw))return 'planejado'; if(['afazer','fazer','pendente'].includes(raw))return 'afazer'; if(['andamento','emandamento','fazendo'].includes(raw))return 'andamento'; if(['concluido','concluida','feito','finalizado'].includes(raw))return 'concluido'; return statusOrder.includes(value)?value:'afazer'; }
function priorityFromText(value){ const raw=normalizeText(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,''); if(raw.startsWith('alt'))return 'alta'; if(raw.startsWith('baix'))return 'baixa'; return 'media'; }
function eventTypeFromText(value){ const raw=normalizeText(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'_'); const map={visita:'visita',visita_tecnica:'visita_tecnica',visitatecnica:'visita_tecnica',apresentacao:'apresentacao',manutencao:'manutencao',queda_luz:'queda_luz',quedadeluz:'queda_luz',treinamento:'treinamento',reuniao:'reuniao',auditoria:'auditoria',seguranca:'seguranca',outro:'outro'}; return map[raw]||map[raw.replace(/_/g,'')]||'outro'; }
function excelDateToISO(value){ if(!value) return localISO(new Date()); if(value instanceof Date) return localISO(value); if(typeof value==='number' && window.XLSX){ const parsed=window.XLSX.SSF.parse_date_code(value); if(parsed) return localISO(new Date(parsed.y,parsed.m-1,parsed.d)); } const text=normalizeText(value); const m=text.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/); if(m){ const y=Number(m[3].length===2?'20'+m[3]:m[3]); return localISO(new Date(y,Number(m[2])-1,Number(m[1]))); } if(/^\d{4}-\d{2}-\d{2}$/.test(text)) return text; const date=new Date(text); return isNaN(date)?localISO(new Date()):localISO(date); }

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
  state={people:[],tasks:[],events:[]}; setAuthMessage('Entre com o usuário cadastrado no Supabase.');
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
    const [peopleResult,tasksResult,assigneeResult,eventsResult]=await Promise.all([
      supabase.from('people').select('id,name,color,active,created_at,updated_at').eq('workspace_id',CONFIG.workspaceId).eq('active',true).order('name'),
      supabase.from('tasks').select('id,title,description,due_date,priority,status,category,created_at,updated_at').eq('workspace_id',CONFIG.workspaceId).order('due_date'),
      supabase.from('task_assignees').select('task_id,person_id,done,done_at,done_by').eq('workspace_id',CONFIG.workspaceId),
      supabase.from('lab_events').select('id,event_date,event_type,title,description,participants,impact,created_at,updated_at').eq('workspace_id',CONFIG.workspaceId).order('event_date',{ascending:true})
    ]);
    for(const result of [peopleResult,tasksResult,assigneeResult,eventsResult]) if(result.error) throw result.error;
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
      })),
      events:(eventsResult.data||[]).map(e=>({
        id:e.id,eventDate:e.event_date,eventType:e.event_type,title:e.title,description:e.description||'',participants:e.participants||'',impact:e.impact||'',createdAt:e.created_at,updatedAt:e.updated_at
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
    .on('postgres_changes',{event:'*',schema:'public',table:'lab_events'},scheduleReload)
    .subscribe(status=>{
      if(status==='SUBSCRIBED') setConnection('online','Online');
      else if(status==='CHANNEL_ERROR' || status==='TIMED_OUT') setConnection('offline','Reconectando');
      else if(status==='CLOSED') setConnection('offline','Desconectado');
    });
}
function scheduleReload(){ clearTimeout(reloadTimer); reloadTimer=setTimeout(()=>loadData(false),220); }

function render(){ renderPeriodTitle(); renderMonthStrip(); renderPeople(); renderCategoryFilter(); renderBoard(); renderMetrics(); renderEventsPanel(); }
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

function renderEventsPanel(){
  const panel=$('eventsPanel'); if(!panel) return;
  const events=filteredEvents(); $('eventsCount').textContent=events.length;
  panel.innerHTML='';
  if(!events.length){ panel.innerHTML='<div class="empty">Nenhuma ocorrência neste período.</div>'; return; }
  events.slice(0,8).forEach(event=>{
    const btn=document.createElement('button'); btn.type='button'; btn.className='event-item';
    btn.innerHTML=`<div class="event-item-top"><span class="event-type">${esc(eventTypeLabels[event.eventType]||'Outro')}</span><span class="event-date">${formatShortDate(event.eventDate)}</span></div><div class="event-title">${esc(event.title)}</div>${event.description?`<div class="event-desc">${esc(event.description)}</div>`:''}`;
    btn.addEventListener('click',()=>openEventModal(event.id)); panel.appendChild(btn);
  });
  if(events.length>8){ const more=document.createElement('div'); more.className='sheet-template'; more.textContent=`+ ${events.length-8} ocorrência(s) no período. Exportar relatório para ver tudo.`; panel.appendChild(more); }
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
  const backup={version:4,exportedAt:new Date().toISOString(),people:state.people.map(p=>({id:p.id,name:p.name,color:p.color})),tasks:state.tasks.map(t=>({id:t.id,title:t.title,description:t.description,assignees:t.assignees,dueDate:t.dueDate,priority:t.priority,status:t.status,category:t.category})),events:state.events.map(e=>({id:e.id,eventDate:e.eventDate,eventType:e.eventType,title:e.title,description:e.description,participants:e.participants,impact:e.impact}))};
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
    if(Array.isArray(backup.events)){
      for(const oldEvent of backup.events){
        const {error:eventError}=await supabase.from('lab_events').insert({workspace_id:CONFIG.workspaceId,event_date:oldEvent.eventDate||localISO(new Date()),event_type:eventTypeFromText(oldEvent.eventType),title:String(oldEvent.title||'Ocorrência importada').trim(),description:oldEvent.description||null,participants:oldEvent.participants||null,impact:oldEvent.impact||null,created_by:session.user.id,updated_by:session.user.id});
        if(eventError) throw eventError;
      }
    }
    await loadData(false);showToast('Backup importado com sucesso.');
  }catch(error){console.error(error);showToast(friendlyError(error));}finally{$('importFile').value='';setLoading(false);}
}


function openEventModal(eventId=null){
  editingEventId=eventId; const event=state.events.find(e=>e.id===eventId);
  $('eventModalTitle').textContent=event?'Editar ocorrência':'Nova ocorrência';
  $('eventDate').value=event?.eventDate||defaultTaskDate(); $('eventType').value=event?.eventType||'visita'; $('eventTitle').value=event?.title||''; $('eventDescription').value=event?.description||''; $('eventParticipants').value=event?.participants||''; $('eventImpact').value=event?.impact||'';
  $('deleteEventBtn').classList.toggle('hidden',!event); $('eventModalBackdrop').classList.remove('hidden'); setTimeout(()=>$('eventTitle').focus(),30);
}
function closeEventModal(){ $('eventModalBackdrop').classList.add('hidden'); editingEventId=null; $('eventForm').reset(); }
async function saveEvent(event){
  event.preventDefault(); const payload={workspace_id:CONFIG.workspaceId,event_date:$('eventDate').value,event_type:$('eventType').value,title:$('eventTitle').value.trim(),description:$('eventDescription').value.trim()||null,participants:$('eventParticipants').value.trim()||null,impact:$('eventImpact').value.trim()||null,updated_by:session.user.id};
  if(!payload.event_date || !payload.title){showToast('Preencha data e título da ocorrência.');return;}
  setLoading(true,editingEventId?'Atualizando ocorrência...':'Criando ocorrência...');
  try{ if(editingEventId){const {error}=await supabase.from('lab_events').update(payload).eq('workspace_id',CONFIG.workspaceId).eq('id',editingEventId); if(error) throw error;} else {const {error}=await supabase.from('lab_events').insert({...payload,created_by:session.user.id}); if(error) throw error;} closeEventModal(); await loadData(false); showToast('Ocorrência salva.'); }catch(error){console.error(error);showToast(friendlyError(error));}finally{setLoading(false);}
}
async function deleteEvent(){
  if(!editingEventId)return; const event=state.events.find(e=>e.id===editingEventId); if(!event || !confirm(`Excluir a ocorrência "${event.title}"?`)) return;
  setLoading(true,'Excluindo ocorrência...'); try{const {error}=await supabase.from('lab_events').delete().eq('workspace_id',CONFIG.workspaceId).eq('id',editingEventId); if(error) throw error; closeEventModal(); await loadData(false); showToast('Ocorrência excluída.');}catch(error){showToast(friendlyError(error));}finally{setLoading(false);}
}
function taskRowsForSheet(tasks=state.tasks){
  return tasks.map(t=>({
    'ID':t.id,'Título':t.title,'Descrição':t.description,'Data':t.dueDate,'Prioridade':t.priority,'Status':statusLabels[t.status]||t.status,'Categoria':t.category,
    'Responsáveis':assigneeNames(t).join('; '),'Responsáveis concluídos':getTaskAssignees(t).filter(a=>a.done).map(a=>getPerson(a.personId).name).join('; '),'Progresso':`${getTaskAssignees(t).filter(a=>a.done).length}/${getTaskAssignees(t).length}`
  }));
}
function eventRowsForSheet(events=state.events){
  return events.map(e=>({'ID':e.id,'Data':e.eventDate,'Tipo':eventTypeLabels[e.eventType]||e.eventType,'Título':e.title,'Descrição':e.description,'Participantes / visitantes':e.participants,'Impacto / providência':e.impact}));
}
function peopleRowsForSheet(){ return state.people.map(p=>({'ID':p.id,'Nome':p.name,'Cor':p.color})); }
function getWeeklyData(){ const start=startOfWeek(cursorDate); const end=endOfWeek(cursorDate); const tasks=state.tasks.filter(t=>{const d=parseISO(t.dueDate);return d>=start&&d<=end;}); const events=state.events.filter(e=>{const d=parseISO(e.eventDate);return d>=start&&d<=end;}); return {start,end,tasks,events}; }
function exportSpreadsheet(){
  if(!window.XLSX){showToast('Biblioteca de planilha não carregou. Confira a internet.');return;}
  const {start,end,tasks,events}=getWeeklyData(); const wb=window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb,window.XLSX.utils.json_to_sheet(taskRowsForSheet(state.tasks)),'Tarefas');
  window.XLSX.utils.book_append_sheet(wb,window.XLSX.utils.json_to_sheet(peopleRowsForSheet()),'Responsaveis');
  window.XLSX.utils.book_append_sheet(wb,window.XLSX.utils.json_to_sheet(eventRowsForSheet(state.events)),'Ocorrencias');
  const resumo=[{'Indicador':'Período','Valor':`${localISO(start)} a ${localISO(end)}`},{'Indicador':'Tarefas da semana','Valor':tasks.length},{'Indicador':'Concluídas','Valor':tasks.filter(t=>t.status==='concluido').length},{'Indicador':'Em andamento','Valor':tasks.filter(t=>t.status==='andamento').length},{'Indicador':'Atrasadas','Valor':tasks.filter(isOverdue).length},{'Indicador':'Ocorrências','Valor':events.length}];
  window.XLSX.utils.book_append_sheet(wb,window.XLSX.utils.json_to_sheet(resumo),'Resumo Semana');
  window.XLSX.writeFile(wb,`LFR_Planejamento_${localISO(new Date())}.xlsx`);
  showToast('Planilha exportada.');
}
async function ensurePersonByName(name,oldToNew=null){
  const clean=normalizeText(name); if(!clean) return null;
  let person=state.people.find(p=>p.name.trim().toLowerCase()===clean.toLowerCase());
  if(person) return person.id;
  const color=defaultColors[state.people.length%defaultColors.length];
  const {data,error}=await supabase.from('people').insert({workspace_id:CONFIG.workspaceId,name:clean,color,created_by:session.user.id}).select('id,name,color').single(); if(error) throw error;
  person=data; state.people.push(person); return person.id;
}
async function importSpreadsheet(file){
  if(!file)return; if(!window.XLSX){showToast('Biblioteca de planilha não carregou. Confira a internet.');return;} if(!confirm('Importar esta planilha para o Supabase? Os registros serão adicionados ao conteúdo atual.'))return;
  setLoading(true,'Importando planilha para o Supabase...');
  try{
    const buffer=await file.arrayBuffer(); const wb=window.XLSX.read(buffer,{type:'array',cellDates:true});
    const peopleSheet=wb.Sheets['Responsaveis']||wb.Sheets['Responsáveis']; const tasksSheet=wb.Sheets['Tarefas']; const eventsSheet=wb.Sheets['Ocorrencias']||wb.Sheets['Ocorrências'];
    const oldToNew=new Map();
    if(peopleSheet){ for(const row of window.XLSX.utils.sheet_to_json(peopleSheet,{defval:''})){ const id=await ensurePersonByName(row['Nome']||row['Responsável']||row['Responsavel']); if(row['ID']) oldToNew.set(String(row['ID']),id); } }
    if(tasksSheet){
      const rows=window.XLSX.utils.sheet_to_json(tasksSheet,{defval:'',raw:false});
      for(const row of rows){
        const title=normalizeText(row['Título']||row['Titulo']||row['Tarefa']); if(!title) continue;
        const due=excelDateToISO(row['Data']||row['Data para fazer']||row['Prazo']);
        const assigneeNamesList=splitNames(row['Responsáveis']||row['Responsaveis']||row['Responsável']||row['Responsavel']);
        const doneNames=new Set(splitNames(row['Responsáveis concluídos']||row['Responsaveis concluidos']||row['Concluídos']||row['Concluidos']).map(n=>n.toLowerCase()));
        const personIds=[]; for(const name of assigneeNamesList){ const id=await ensurePersonByName(name); if(id) personIds.push(id); }
        if(!personIds.length && state.people[0]) personIds.push(state.people[0].id);
        const status=statusFromText(row['Status']);
        const {data,error}=await supabase.from('tasks').insert({workspace_id:CONFIG.workspaceId,title,description:normalizeText(row['Descrição']||row['Descricao'])||null,due_date:due,priority:priorityFromText(row['Prioridade']),status,category:normalizeText(row['Categoria'])||null,created_by:session.user.id,updated_by:session.user.id}).select('id').single(); if(error) throw error;
        const assignments=personIds.map(personId=>{ const name=getPerson(personId).name.toLowerCase(); const done=status==='concluido'||doneNames.has(name); return {workspace_id:CONFIG.workspaceId,task_id:data.id,person_id:personId,done,done_at:done?new Date().toISOString():null,done_by:done?session.user.id:null}; });
        if(assignments.length){const {error:assignError}=await supabase.from('task_assignees').insert(assignments); if(assignError) throw assignError;}
      }
    }
    if(eventsSheet){
      const rows=window.XLSX.utils.sheet_to_json(eventsSheet,{defval:'',raw:false});
      for(const row of rows){ const title=normalizeText(row['Título']||row['Titulo']||row['Ocorrência']||row['Ocorrencia']); if(!title) continue; const {error}=await supabase.from('lab_events').insert({workspace_id:CONFIG.workspaceId,event_date:excelDateToISO(row['Data']),event_type:eventTypeFromText(row['Tipo']),title,description:normalizeText(row['Descrição']||row['Descricao'])||null,participants:normalizeText(row['Participantes / visitantes']||row['Participantes']||row['Visitantes'])||null,impact:normalizeText(row['Impacto / providência']||row['Impacto']||row['Providência']||row['Providencia'])||null,created_by:session.user.id,updated_by:session.user.id}); if(error) throw error; }
    }
    await loadData(false); showToast('Planilha importada com sucesso.');
  }catch(error){console.error(error);showToast(friendlyError(error));}finally{$('importSheetFile').value='';setLoading(false);}
}
function reportPresentationRange(referenceDate=new Date()){
  const reference=new Date(referenceDate); reference.setHours(0,0,0,0);
  const currentWeekStart=startOfWeek(reference);
  const isMonday=reference.getDay()===1;
  const presentationDate=isMonday ? reference : addDays(currentWeekStart,7);
  const start=isMonday ? addDays(currentWeekStart,-7) : currentWeekStart;
  const end=addDays(start,6);
  return {start,end,presentationDate};
}
function dataBetween(start,end){
  const tasks=state.tasks.filter(task=>{
    if(!task.dueDate)return false;
    const date=parseISO(task.dueDate); return date>=start&&date<=end;
  }).sort((a,b)=>(a.dueDate||'').localeCompare(b.dueDate||'')||(a.title||'').localeCompare(b.title||'','pt-BR'));
  const events=state.events.filter(event=>{
    if(!event.eventDate)return false;
    const date=parseISO(event.eventDate); return date>=start&&date<=end;
  }).sort((a,b)=>(a.eventDate||'').localeCompare(b.eventDate||'')||(a.title||'').localeCompare(b.title||'','pt-BR'));
  return {tasks,events};
}
function reportDate(value){
  if(!value)return 'Sem data';
  const date=value instanceof Date?value:parseISO(value);
  return date.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric'});
}
function reportSafe(value,fallback='Não informado'){
  const clean=String(value||'').replace(/\r?\n/g,' ').replace(/\s+/g,' ').trim();
  return clean||fallback;
}
function taskAssigneeReport(task){
  const assignees=getTaskAssignees(task);
  if(!assignees.length)return 'Sem responsável';
  return assignees.map(item=>`${getPerson(item.personId).name} (${item.done?'concluiu':'pendente'})`).join('; ');
}
function appendTaskList(lines,title,tasks){
  lines.push('',title, '-'.repeat(title.length));
  if(!tasks.length){ lines.push('Nenhuma tarefa registrada nesta seção.'); return; }
  tasks.forEach((task,index)=>{
    lines.push(`${index+1}. ${reportDate(task.dueDate)} | ${statusLabels[task.status]||task.status} | ${reportSafe(task.title)}`);
    lines.push(`   Responsáveis: ${taskAssigneeReport(task)}`);
    lines.push(`   Prioridade: ${reportSafe(task.priority,'Média')} | Categoria: ${reportSafe(task.category)}`);
    if(task.description)lines.push(`   Descrição: ${reportSafe(task.description)}`);
  });
}
function generateWeeklyTextReport(){
  const {start,end,presentationDate}=reportPresentationRange(new Date());
  const {tasks,events}=dataBetween(start,end);
  const nextWeekStart=new Date(presentationDate); const nextWeekEnd=addDays(nextWeekStart,6);
  const nextWeekTasks=dataBetween(nextWeekStart,nextWeekEnd).tasks.filter(task=>task.status!=='concluido');
  const completed=tasks.filter(task=>task.status==='concluido');
  const inProgress=tasks.filter(task=>task.status==='andamento');
  const pending=tasks.filter(task=>task.status==='planejado'||task.status==='afazer');
  const overdue=tasks.filter(isOverdue);
  const eventCounts=events.reduce((acc,event)=>{
    const label=eventTypeLabels[event.eventType]||'Outro'; acc[label]=(acc[label]||0)+1; return acc;
  },{});
  const lines=[];
  lines.push('LFR 4.0 — RELATÓRIO SEMANAL DO LABORATÓRIO');
  lines.push('='.repeat(52));
  lines.push(`Apresentação: segunda-feira, ${reportDate(presentationDate)}`);
  lines.push(`Período relatado: ${reportDate(start)} a ${reportDate(end)} (segunda a domingo)`);
  lines.push(`Gerado em: ${new Date().toLocaleString('pt-BR')}`);
  lines.push('Fonte: Kanban LFR Planejamento Online / Supabase');

  lines.push('', '1. RESUMO EXECUTIVO', '-------------------');
  lines.push(`Tarefas registradas no período: ${tasks.length}`);
  lines.push(`Tarefas concluídas: ${completed.length}`);
  lines.push(`Tarefas em andamento: ${inProgress.length}`);
  lines.push(`Tarefas planejadas ou a fazer: ${pending.length}`);
  lines.push(`Tarefas atrasadas e não concluídas: ${overdue.length}`);
  lines.push(`Ocorrências registradas: ${events.length}`);
  if(Object.keys(eventCounts).length){
    lines.push(`Tipos de ocorrência: ${Object.entries(eventCounts).map(([name,count])=>`${name}: ${count}`).join(' | ')}`);
  }else{
    lines.push('Tipos de ocorrência: nenhuma ocorrência registrada.');
  }

  lines.push('', '2. OCORRÊNCIAS DA SEMANA', '------------------------');
  if(!events.length){
    lines.push('Nenhuma ocorrência registrada no período.');
  }else{
    events.forEach((event,index)=>{
      lines.push(`${index+1}. ${reportDate(event.eventDate)} | ${eventTypeLabels[event.eventType]||'Outro'} | ${reportSafe(event.title)}`);
      lines.push(`   Descrição: ${reportSafe(event.description)}`);
      lines.push(`   Participantes / visitantes: ${reportSafe(event.participants)}`);
      lines.push(`   Impacto / providência: ${reportSafe(event.impact)}`);
    });
  }

  appendTaskList(lines,'3. TAREFAS CONCLUÍDAS',completed);
  appendTaskList(lines,'4. TAREFAS EM ANDAMENTO',inProgress);
  appendTaskList(lines,'5. TAREFAS PLANEJADAS, PENDENTES OU A FAZER',pending);

  lines.push('', '6. RESUMO POR RESPONSÁVEL', '-------------------------');
  const peopleSummary=state.people.map(person=>{
    const assigned=tasks.filter(task=>taskHasPerson(task,person.id));
    const individualDone=assigned.filter(task=>getTaskAssignees(task).some(item=>item.personId===person.id&&item.done)).length;
    return {name:person.name,total:assigned.length,done:individualDone,pending:assigned.length-individualDone};
  }).filter(item=>item.total>0).sort((a,b)=>b.total-a.total||a.name.localeCompare(b.name,'pt-BR'));
  if(!peopleSummary.length){
    lines.push('Nenhum responsável com tarefa registrada no período.');
  }else{
    peopleSummary.forEach((item,index)=>lines.push(`${index+1}. ${item.name}: ${item.total} atribuição(ões), ${item.done} concluída(s), ${item.pending} pendente(s).`));
  }

  appendTaskList(lines,`7. PRÓXIMOS PASSOS — ${reportDate(nextWeekStart)} A ${reportDate(nextWeekEnd)}`,nextWeekTasks);

  lines.push('', '8. OBSERVAÇÕES PARA A APRESENTAÇÃO', '----------------------------------');
  lines.push('• Confirmar se todas as ocorrências relevantes foram cadastradas.');
  lines.push('• Destacar impactos, providências tomadas e pendências que precisam de apoio.');
  lines.push('• Revisar este texto antes de copiar os pontos principais para os slides da reunião.');
  lines.push('', 'desenvolvido por Guilherme Sollo');

  const content='\ufeff'+lines.join('\r\n');
  const blob=new Blob([content],{type:'text/plain;charset=utf-8'});
  const url=URL.createObjectURL(blob); const anchor=document.createElement('a');
  anchor.href=url; anchor.download=`LFR_Relatorio_Semanal_${localISO(start)}_a_${localISO(end)}.txt`;
  document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
  showToast(`Relatório TXT gerado: ${reportDate(start)} a ${reportDate(end)}.`);
}

function bindEvents(){
  $('loginForm').addEventListener('submit',login);$('signupBtn').addEventListener('click',signup);$('logoutBtn').addEventListener('click',logout);
  $('weekModeBtn').addEventListener('click',()=>setMode('week'));$('monthModeBtn').addEventListener('click',()=>setMode('month'));$('prevPeriodBtn').addEventListener('click',()=>shiftPeriod(-1));$('nextPeriodBtn').addEventListener('click',()=>shiftPeriod(1));$('todayBtn').addEventListener('click',()=>{cursorDate=new Date();selectedDay='all';render();});
  [$('newTaskBtn'),$('toolbarNewTaskBtn')].forEach(btn=>btn.addEventListener('click',()=>openTaskModal()));[$('teamBtn'),$('managePeopleBtn')].forEach(btn=>btn.addEventListener('click',openTeamModal));
  $('closeTaskModalBtn').addEventListener('click',closeTaskModal);$('cancelTaskBtn').addEventListener('click',closeTaskModal);$('taskForm').addEventListener('submit',saveTask);$('deleteTaskBtn').addEventListener('click',deleteTask);
  $('closeTeamModalBtn').addEventListener('click',closeTeamModal);$('doneTeamBtn').addEventListener('click',closeTeamModal);$('addPersonBtn').addEventListener('click',addPerson);$('newPersonName').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();addPerson();}});
  $('searchInput').addEventListener('input',()=>{renderBoard();renderMetrics();});$('priorityFilter').addEventListener('change',()=>{renderBoard();renderMetrics();});$('categoryFilter').addEventListener('change',()=>{renderBoard();renderMetrics();});$('clearFiltersBtn').addEventListener('click',resetFilters);
  $('exportBtn').addEventListener('click',exportData);$('importBtn').addEventListener('click',()=>$('importFile').click());$('importFile').addEventListener('change',event=>importBackup(event.target.files?.[0]));
  $('exportSheetBtn').addEventListener('click',exportSpreadsheet);$('importSheetBtn').addEventListener('click',()=>$('importSheetFile').click());$('importSheetFile').addEventListener('change',event=>importSpreadsheet(event.target.files?.[0]));$('weeklyTxtBtn').addEventListener('click',generateWeeklyTextReport);
  $('newEventBtn').addEventListener('click',()=>openEventModal());$('closeEventModalBtn').addEventListener('click',closeEventModal);$('cancelEventBtn').addEventListener('click',closeEventModal);$('eventForm').addEventListener('submit',saveEvent);$('deleteEventBtn').addEventListener('click',deleteEvent);
  $('mobileSidebarBtn').addEventListener('click',()=>$('sidebar').classList.toggle('open'));
  $('taskModalBackdrop').addEventListener('click',event=>{if(event.target===$('taskModalBackdrop'))closeTaskModal();});$('teamModalBackdrop').addEventListener('click',event=>{if(event.target===$('teamModalBackdrop'))closeTeamModal();});$('eventModalBackdrop').addEventListener('click',event=>{if(event.target===$('eventModalBackdrop'))closeEventModal();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'){if(!$('taskModalBackdrop').classList.contains('hidden'))closeTaskModal();if(!$('teamModalBackdrop').classList.contains('hidden'))closeTeamModal();if(!$('eventModalBackdrop').classList.contains('hidden'))closeEventModal();$('sidebar').classList.remove('open');}});
  $('themeBtn').addEventListener('click',()=>{document.body.classList.toggle('dark');localStorage.setItem(THEME_KEY,document.body.classList.contains('dark')?'dark':'light');});
  document.querySelectorAll('.column').forEach(column=>{
    column.addEventListener('dragover',event=>{event.preventDefault();event.dataTransfer.dropEffect='move';column.classList.add('drag-over');});column.addEventListener('dragleave',()=>column.classList.remove('drag-over'));
    column.addEventListener('drop',event=>{event.preventDefault();column.classList.remove('drag-over');const taskId=event.dataTransfer.getData('text/plain')||draggedTaskId;moveTask(taskId,column.dataset.status);});
  });
}

initialize().catch(error=>{console.error(error);setAuthMessage(friendlyError(error),true);});
