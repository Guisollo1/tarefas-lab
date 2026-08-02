import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.8/+esm';

const CONFIG = window.KANBAN_CONFIG || {};
const THEME_KEY = 'lfr_planejamento_online_theme';
const CACHE_KEY = 'lfr_planejamento_online_cache_v7';
const statusOrder = ['planejado', 'afazer', 'andamento', 'concluido'];
const statusLabels = { planejado:'Planejado', afazer:'A fazer', andamento:'Em andamento', concluido:'Concluído' };
const priorityColors = { alta:'#d94b45', media:'#e09f1f', baixa:'#2f8e67' };
const scheduleTypeLabels = { day:'Dia', week:'Semana', month:'Mês' };
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
let selectedDay = localISO(new Date());
let editingTaskId = null;
let editingTaskUnlocked = false;
let pastGuardResolver = null;
let pastGuardExpected = '';
let pastGuardAction = '';
let pastGuardTaskId = null;
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
function startOfMonth(date){ const result=new Date(date.getFullYear(),date.getMonth(),1); result.setHours(0,0,0,0); return result; }
function endOfMonth(date){ const result=new Date(date.getFullYear(),date.getMonth()+1,0); result.setHours(0,0,0,0); return result; }
function startOfDay(date){ const result=new Date(date); result.setHours(0,0,0,0); return result; }
function endOfDay(date){ const result=new Date(date); result.setHours(23,59,59,999); return result; }
function scheduleTypeOf(task){ return ['day','week','month'].includes(task?.scheduleType) ? task.scheduleType : 'day'; }
function taskPeriodStart(task){ return parseISO(task?.periodStart || task?.dueDate || localISO(new Date())); }
function taskPeriodEnd(task){ return parseISO(task?.periodEnd || task?.dueDate || localISO(new Date())); }
function taskCompletedDate(task){ const date=task?.completedAt ? new Date(task.completedAt) : null; return date && !Number.isNaN(date.getTime()) ? date : null; }
function rangesOverlap(aStart,aEnd,bStart,bEnd){ return startOfDay(aStart)<=endOfDay(bEnd) && endOfDay(aEnd)>=startOfDay(bStart); }
function sameLocalDay(a,b){ return localISO(a)===localISO(b); }
function taskVisibleOnDate(task,date){
  const selected=startOfDay(date); const start=taskPeriodStart(task); const end=taskPeriodEnd(task); const today=startOfDay(new Date());
  if(selected>=start && selected<=end) return true;
  const completed=taskCompletedDate(task);
  if(completed && sameLocalDay(completed,selected)) return true;
  return Boolean(task.repeatUntilDone && task.status!=='concluido' && selected>end && selected<=today);
}
function taskVisibleInRange(task,rangeStart,rangeEnd){
  const start=taskPeriodStart(task); const end=taskPeriodEnd(task); const visibleStart=startOfDay(rangeStart); const visibleEnd=endOfDay(rangeEnd);
  if(rangesOverlap(start,end,visibleStart,visibleEnd)) return true;
  const completed=taskCompletedDate(task);
  if(completed && completed>=visibleStart && completed<=visibleEnd) return true;
  if(task.repeatUntilDone && task.status!=='concluido'){
    const carryStart=startOfDay(addDays(end,1)); const carryEnd=endOfDay(new Date());
    return carryStart<=carryEnd && rangesOverlap(carryStart,carryEnd,visibleStart,visibleEnd);
  }
  return false;
}
function taskIsPastLocked(task){
  if(!task) return false;
  if(task.repeatUntilDone && task.status!=='concluido') return false;
  const today=startOfDay(new Date());
  const completed=taskCompletedDate(task);
  if(completed && completed>=today) return false;
  return taskPeriodEnd(task)<today;
}
function taskIsCarryover(task,referenceDate=null){
  if(!task?.repeatUntilDone || task.status==='concluido') return false;
  const reference=referenceDate ? startOfDay(referenceDate) : (selectedDay!=='all' ? parseISO(selectedDay) : startOfDay(new Date()));
  return reference>taskPeriodEnd(task) && reference<=startOfDay(new Date());
}
function scheduleRange(type,dateValue,monthValue){
  const safeType=['day','week','month'].includes(type)?type:'day';
  if(safeType==='month'){
    const monthText=String(monthValue||''); const match=monthText.match(/^(\d{4})-(\d{2})$/); const base=match?new Date(Number(match[1]),Number(match[2])-1,1):startOfMonth(new Date());
    return {type:safeType,start:startOfMonth(base),end:endOfMonth(base)};
  }
  const base=/^\d{4}-\d{2}-\d{2}$/.test(String(dateValue||''))?parseISO(dateValue):startOfDay(new Date());
  if(safeType==='week') return {type:safeType,start:startOfWeek(base),end:endOfWeek(base)};
  return {type:safeType,start:startOfDay(base),end:startOfDay(base)};
}
function scheduleRangeForTask(task){ return {type:scheduleTypeOf(task),start:taskPeriodStart(task),end:taskPeriodEnd(task)}; }
function capitalize(value=''){ return value ? value.charAt(0).toUpperCase()+value.slice(1) : ''; }
function taskPeriodLabel(task){
  const {type,start,end}=scheduleRangeForTask(task);
  if(type==='week') return `Semana ${start.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'})}–${end.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'})}`;
  if(type==='month') return capitalize(start.toLocaleDateString('pt-BR',{month:'long',year:'numeric'}));
  return `Dia ${start.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric'})}`;
}
function scheduleTypeFromText(value){
  const raw=normalizeText(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  if(raw.includes('sem')) return 'week'; if(raw.includes('mes')||raw==='month') return 'month'; return 'day';
}
function booleanFromText(value){ return ['1','true','sim','s','yes','x'].includes(normalizeText(value).toLowerCase()); }
function formatShortDate(value){ return value ? parseISO(value).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'}) : 'Sem data'; }
function normalizeTime(value){ const text=String(value||'12:00').trim(); const match=text.match(/^(\d{1,2}):(\d{2})/); if(!match)return '12:00'; return `${String(Math.min(23,Number(match[1]))).padStart(2,'0')}:${match[2]}`; }
function eventDateTime(event){ if(!event?.eventDate)return null; const [y,m,d]=event.eventDate.split('-').map(Number); const [hh,mm]=normalizeTime(event.eventTime).split(':').map(Number); return new Date(y,m-1,d,hh,mm,0,0); }
function formatEventDateTime(event){ const dt=eventDateTime(event); return dt ? dt.toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}) : 'Sem data e horário'; }
function initials(name=''){ return name.trim().split(/\s+/).slice(0,2).map(p=>p[0]?.toUpperCase()||'').join(''); }
function getPerson(id){ return state.people.find(p=>p.id===id) || {id:'none',name:'Responsável removido',color:'#778395'}; }
function getTaskAssignees(task){ return Array.isArray(task.assignees) ? task.assignees : []; }
function taskHasPerson(task,personId){ return getTaskAssignees(task).some(item=>item.personId===personId); }
function assigneeNames(task){ return getTaskAssignees(task).map(item=>getPerson(item.personId).name); }
function isEventInPeriod(event){ const date=eventDateTime(event); if(!date)return false; const {start,end}=periodRange(); const inclusiveEnd=new Date(end); inclusiveEnd.setHours(23,59,59,999); return date>=start && date<=inclusiveEnd; }
function filteredEvents(){ return state.events.filter(isEventInPeriod).sort((a,b)=>(eventDateTime(a)?.getTime()||0)-(eventDateTime(b)?.getTime()||0) || (a.title||'').localeCompare(b.title||'', 'pt-BR')); }
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
function isInPeriod(task){ const {start,end}=periodRange(); return taskVisibleInRange(task,start,end); }
function isOverdue(task){
  if(task.status==='concluido') return false;
  return taskPeriodEnd(task)<startOfDay(new Date());
}
function filteredTasks(){
  const term=$('searchInput').value.trim().toLowerCase(); const priority=$('priorityFilter').value; const category=$('categoryFilter').value;
  return state.tasks
    .filter(isInPeriod)
    .filter(t=>selectedPerson==='all' || taskHasPerson(t,selectedPerson))
    .filter(t=>selectedDay==='all' || taskVisibleOnDate(t,parseISO(selectedDay)))
    .filter(t=>priority==='all' || t.priority===priority)
    .filter(t=>category==='all' || (t.category||'')===category)
    .filter(t=>!term || [t.title,t.description,t.category,taskPeriodLabel(t),scheduleTypeLabels[scheduleTypeOf(t)],...assigneeNames(t)].join(' ').toLowerCase().includes(term))
    .sort((a,b)=>localISO(taskPeriodEnd(a)).localeCompare(localISO(taskPeriodEnd(b))) || a.title.localeCompare(b.title,'pt-BR'));
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
      supabase.from('tasks').select('id,title,description,due_date,period_start,period_end,schedule_type,repeat_until_done,completed_at,priority,status,category,created_at,updated_at').eq('workspace_id',CONFIG.workspaceId).order('due_date'),
      supabase.from('task_assignees').select('task_id,person_id,done,done_at,done_by').eq('workspace_id',CONFIG.workspaceId),
      supabase.from('lab_events').select('id,event_date,event_time,event_type,title,description,participants,impact,created_at,updated_at').eq('workspace_id',CONFIG.workspaceId).order('event_date',{ascending:true})
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
        id:t.id,title:t.title,description:t.description||'',dueDate:t.due_date,
        periodStart:t.period_start||t.due_date,periodEnd:t.period_end||t.due_date,scheduleType:t.schedule_type||'day',repeatUntilDone:Boolean(t.repeat_until_done),completedAt:t.completed_at||null,
        priority:t.priority,status:t.status,category:t.category||'',createdAt:t.created_at,updatedAt:t.updated_at,assignees:assignmentsByTask.get(t.id)||[]
      })),
      events:(eventsResult.data||[]).map(e=>({
        id:e.id,eventDate:e.event_date,eventTime:normalizeTime(e.event_time),eventType:e.event_type,title:e.title,description:e.description||'',participants:e.participants||'',impact:e.impact||'',createdAt:e.created_at,updatedAt:e.updated_at
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

function render(){ renderPeriodTitle(); renderCurrentContext(); renderMonthStrip(); renderPeople(); renderCategoryFilter(); renderBoard(); renderMetrics(); renderEventsPanel(); }
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
function renderCurrentContext(){
  const banner=$('currentDateBanner'); if(!banner) return;
  const today=new Date();
  if(viewMode==='week' && selectedDay!=='all'){
    const selected=parseISO(selectedDay); const isToday=sameLocalDay(selected,today);
    banner.innerHTML=`<span>${isToday?'📍 <strong>Hoje</strong>':'📅 <strong>Dia selecionado</strong>'}: ${selected.toLocaleDateString('pt-BR',{weekday:'long',day:'2-digit',month:'long',year:'numeric'})}</span><span class="context-detail">Exibe tarefas do dia, da semana, do mês e pendências repetitivas.</span>`;
  }else{
    const {start,end}=periodRange(); banner.innerHTML=`<span>🗓️ <strong>Período completo</strong>: ${start.toLocaleDateString('pt-BR')} a ${end.toLocaleDateString('pt-BR')}</span><span class="context-detail">Clique em um dia para focar a rotina diária.</span>`;
  }
}
function renderMonthStrip(){
  const strip=$('monthStrip'); strip.innerHTML=''; strip.classList.toggle('visible',viewMode==='week'); if(viewMode!=='week') return;
  const start=startOfWeek(cursorDate); const weekday=['Seg','Ter','Qua','Qui','Sex','Sáb','Dom'];
  for(let i=0;i<7;i++){
    const day=addDays(start,i); const iso=localISO(day); const count=state.tasks.filter(t=>taskVisibleOnDate(t,day)).length; const btn=document.createElement('button');
    btn.type='button'; btn.className='day-pill'; if(selectedDay===iso) btn.classList.add('active'); if(count) btn.classList.add('has-tasks');
    btn.innerHTML=`<small>${weekday[i]}</small><strong>${String(day.getDate()).padStart(2,'0')}</strong>${count?`<small>${count} tarefa${count>1?'s':''}</small>`:'<small>livre</small>'}`;
    btn.addEventListener('click',()=>{selectedDay=selectedDay===iso?'all':iso;renderCurrentContext();renderBoard();renderMetrics();renderMonthStrip();}); strip.appendChild(btn);
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
  const assignments=getTaskAssignees(task); const doneCount=assignments.filter(a=>a.done).length; const late=isOverdue(task); const locked=taskIsPastLocked(task); const carried=taskIsCarryover(task);
  const card=document.createElement('article');
  card.className=`task-card ${late?'overdue':''} ${locked?'history-locked':''}`; card.draggable=!locked; card.dataset.id=task.id;
  const assigneesHtml=assignments.map(item=>{ const person=getPerson(item.personId); return `<button class="assignee-chip ${item.done?'done':''}" type="button" data-person-id="${esc(person.id)}" title="${locked?'Período histórico protegido':`Clique para ${item.done?'reabrir':'concluir'} a participação de ${esc(person.name)}`}"><span class="avatar" style="background:${esc(person.color)}">${esc(initials(person.name))}</span><span class="assignee-chip-name">${esc(person.name)}</span><span class="assignee-chip-check">${item.done?'✓':'○'}</span></button>`; }).join('');
  const badges=[`<span class="schedule-badge">${esc(scheduleTypeLabels[scheduleTypeOf(task)])}: ${esc(taskPeriodLabel(task))}</span>`];
  if(task.repeatUntilDone) badges.push('<span class="repeat-badge">↻ Até concluir</span>');
  if(carried) badges.push(`<span class="carryover-badge">Trazida de ${taskPeriodEnd(task).toLocaleDateString('pt-BR')}</span>`);
  if(locked) badges.push('<span class="locked-badge">🔒 Histórico protegido</span>');
  card.innerHTML=`<div class="task-top"><i class="priority" style="background:${priorityColors[task.priority]||priorityColors.media}" title="Prioridade ${esc(task.priority)}"></i><div class="task-title">${esc(task.title)}</div></div>
    <div class="schedule-badges">${badges.join('')}</div>
    ${task.description?`<div class="task-description">${esc(task.description)}</div>`:''}${task.category?`<div class="tags"><span class="tag">${esc(task.category)}</span></div>`:''}
    <div class="assignee-list">${assigneesHtml||'<span style="font-size:11px;color:var(--muted)">Sem responsável</span>'}</div>
    <div class="assignee-progress">${doneCount}/${assignments.length} responsável${assignments.length===1?'':'is'} concluíram</div>
    <div class="task-footer"><div class="date-chip ${late?'late':''}">${late?'⚠ ':''}${esc(taskPeriodLabel(task))}</div><div style="font-size:10px;color:var(--muted)">${statusLabels[task.status]}</div></div>`;
  card.addEventListener('click',event=>{ if(event.target.closest('.assignee-chip')) return; requestTaskEdit(task.id); });
  card.querySelectorAll('.assignee-chip').forEach(button=>button.addEventListener('click',async event=>{event.stopPropagation();if(locked){const ok=await requestPastAuthorization(task,'edit');if(!ok)return;}await toggleAssigneeDone(task.id,button.dataset.personId,true);}));
  card.addEventListener('dragstart',event=>{
    if(locked){event.preventDefault();showToast('Abra a tarefa e digite EDITAR para alterar um período passado.');return;}
    draggedTaskId=task.id;card.classList.add('dragging');event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',task.id);
  });
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
    btn.innerHTML=`<div class="event-item-top"><span class="event-type">${esc(eventTypeLabels[event.eventType]||'Outro')}</span><span class="event-date">${formatShortDate(event.eventDate)} ${normalizeTime(event.eventTime)}</span></div><div class="event-title">${esc(event.title)}</div>${event.description?`<div class="event-desc">${esc(event.description)}</div>`:''}`;
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
function defaultTaskDate(){ if(selectedDay!=='all') return selectedDay; const {start,end}=periodRange(); const current=startOfDay(new Date()); return localISO(current>=start&&current<=end?current:start); }
function scheduleFromForm(){
  return scheduleRange($('taskScheduleType').value,$('taskDueDate').value,$('taskMonth').value);
}
function updateTaskScheduleFields(){
  const type=$('taskScheduleType').value;
  $('taskDateField').classList.toggle('hidden',type==='month');
  $('taskMonthField').classList.toggle('hidden',type!=='month');
  $('taskDateLabel').textContent=type==='week'?'Escolha um dia da semana *':'Data da tarefa *';
  const range=scheduleFromForm();
  const repeat=$('taskRepeatUntilDone').checked;
  let message=`${scheduleTypeLabels[range.type]}: ${range.start.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric'})}`;
  if(range.type!=='day') message+=` até ${range.end.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric'})}`;
  if(repeat) message+=' • Se não for concluída, continuará aparecendo nos períodos seguintes até a conclusão.';
  else message+=' • Depois desse período, ficará apenas no histórico.';
  $('taskSchedulePreview').textContent=message;
}
function setTaskScheduleForm(task=null){
  const type=task?scheduleTypeOf(task):'day'; const start=task?taskPeriodStart(task):parseISO(defaultTaskDate());
  $('taskScheduleType').value=type;
  $('taskDueDate').value=localISO(start);
  $('taskMonth').value=`${start.getFullYear()}-${String(start.getMonth()+1).padStart(2,'0')}`;
  $('taskRepeatUntilDone').checked=Boolean(task?.repeatUntilDone);
  updateTaskScheduleFields();
}
async function requestTaskEdit(taskId){
  const task=state.tasks.find(item=>item.id===taskId); if(!task) return;
  if(taskIsPastLocked(task)){ const ok=await requestPastAuthorization(task,'edit'); if(!ok)return; openTaskModal(taskId,true); }
  else openTaskModal(taskId,false);
}
function openTaskModal(taskId=null,unlocked=false){
  if(!state.people.length){showToast('Cadastre pelo menos um responsável.');openTeamModal();return;}
  editingTaskId=taskId; editingTaskUnlocked=Boolean(unlocked); const task=state.tasks.find(t=>t.id===taskId);
  $('taskModalTitle').textContent=task?'Editar tarefa':'Nova tarefa'; $('taskTitle').value=task?.title||''; $('taskDescription').value=task?.description||'';
  const initial=task?.assignees || (selectedPerson!=='all'?[{personId:selectedPerson}]:[]); renderTaskAssigneePicker(initial); setTaskScheduleForm(task);
  $('taskPriority').value=task?.priority||'media'; $('taskStatus').value=task?.status||'afazer'; $('taskCategory').value=task?.category||'';
  $('deleteTaskBtn').classList.toggle('hidden',!task); $('taskModalBackdrop').classList.remove('hidden'); setTimeout(()=>$('taskTitle').focus(),30);
}
function closeTaskModal(){ $('taskModalBackdrop').classList.add('hidden'); editingTaskId=null; editingTaskUnlocked=false; $('taskForm').reset(); }

function requestPastAuthorization(task,action='edit'){
  const expected=action==='delete'?'DELETE':'EDITAR';
  if(pastGuardResolver){ pastGuardResolver(false); pastGuardResolver=null; }
  pastGuardExpected=expected; pastGuardAction=action; pastGuardTaskId=task?.id||null;
  $('pastGuardTitle').textContent=action==='delete'?'Excluir tarefa histórica':'Editar tarefa histórica';
  $('pastGuardMessage').innerHTML=`A tarefa <strong>${esc(task?.title||'')}</strong> pertence a um período encerrado (${esc(taskPeriodLabel(task))}). Para ${action==='delete'?'excluir definitivamente':'autorizar alterações'}, digite <strong>${expected}</strong>.`;
  $('pastGuardLabel').textContent=`Digite ${expected} para continuar`;
  $('pastGuardInput').value=''; $('pastGuardInput').placeholder=expected; $('pastGuardError').textContent='';
  $('pastGuardBackdrop').classList.remove('hidden');
  setTimeout(()=>$('pastGuardInput').focus(),30);
  return new Promise(resolve=>{ pastGuardResolver=resolve; });
}
function closePastGuard(result=false){
  $('pastGuardBackdrop').classList.add('hidden');
  const resolver=pastGuardResolver; pastGuardResolver=null; pastGuardExpected=''; pastGuardAction=''; pastGuardTaskId=null;
  if(resolver) resolver(Boolean(result));
}
function confirmPastGuard(){
  const typed=$('pastGuardInput').value.trim().toUpperCase();
  if(typed!==pastGuardExpected){ $('pastGuardError').textContent=`Digite exatamente ${pastGuardExpected}.`; $('pastGuardInput').focus(); return; }
  closePastGuard(true);
}

async function saveTask(event){
  event.preventDefault(); const assigneeIds=selectedAssigneeIds(); const oldTask=state.tasks.find(t=>t.id===editingTaskId);
  if(oldTask && taskIsPastLocked(oldTask) && !editingTaskUnlocked){ const ok=await requestPastAuthorization(oldTask,'edit'); if(!ok)return; editingTaskUnlocked=true; }
  const schedule=scheduleFromForm(); const status=$('taskStatus').value;
  const payload={
    workspace_id:CONFIG.workspaceId,title:$('taskTitle').value.trim(),description:$('taskDescription').value.trim()||null,
    due_date:localISO(schedule.end),period_start:localISO(schedule.start),period_end:localISO(schedule.end),schedule_type:schedule.type,repeat_until_done:$('taskRepeatUntilDone').checked,
    completed_at:status==='concluido'?(oldTask?.completedAt||new Date().toISOString()):null,
    priority:$('taskPriority').value,status,category:$('taskCategory').value.trim()||null,updated_by:session.user.id
  };
  if(!payload.title || !assigneeIds.length){showToast('Preencha título, período e pelo menos um responsável.');return;}
  const wasEditing=Boolean(editingTaskId);
  setLoading(true,wasEditing?'Atualizando tarefa...':'Criando tarefa...');
  try{
    let taskId=editingTaskId;
    if(taskId){ const {error}=await supabase.from('tasks').update(payload).eq('id',taskId).eq('workspace_id',CONFIG.workspaceId); if(error) throw error; }
    else{ const {data,error}=await supabase.from('tasks').insert({...payload,created_by:session.user.id}).select('id').single(); if(error) throw error; taskId=data.id; }

    const existing=state.tasks.find(t=>t.id===taskId)?.assignees||[]; const existingIds=new Set(existing.map(a=>a.personId)); const selectedSet=new Set(assigneeIds);
    const removed=[...existingIds].filter(id=>!selectedSet.has(id)); const added=assigneeIds.filter(id=>!existingIds.has(id));
    if(removed.length){ const {error}=await supabase.from('task_assignees').delete().eq('workspace_id',CONFIG.workspaceId).eq('task_id',taskId).in('person_id',removed); if(error) throw error; }
    if(added.length){ const rows=added.map(personId=>({workspace_id:CONFIG.workspaceId,task_id:taskId,person_id:personId,done:status==='concluido',done_at:status==='concluido'?new Date().toISOString():null,done_by:status==='concluido'?session.user.id:null})); const {error}=await supabase.from('task_assignees').insert(rows); if(error) throw error; }
    if(status==='concluido'){
      const {error}=await supabase.from('task_assignees').update({done:true,done_at:new Date().toISOString(),done_by:session.user.id}).eq('workspace_id',CONFIG.workspaceId).eq('task_id',taskId); if(error) throw error;
    }else if(oldTask?.status==='concluido'){
      const {error}=await supabase.from('task_assignees').update({done:false,done_at:null,done_by:null}).eq('workspace_id',CONFIG.workspaceId).eq('task_id',taskId); if(error) throw error;
    }
    closeTaskModal(); await loadData(false); showToast(wasEditing?'Tarefa atualizada.':'Tarefa criada.');
  }catch(error){console.error(error);showToast(friendlyError(error));}
  finally{setLoading(false);}
}
async function deleteTask(){
  if(!editingTaskId) return; const task=state.tasks.find(t=>t.id===editingTaskId); if(!task)return;
  if(taskIsPastLocked(task)){ const ok=await requestPastAuthorization(task,'delete'); if(!ok)return; }
  else if(!confirm(`Excluir a tarefa "${task.title}"?`)) return;
  setLoading(true,'Excluindo tarefa...');
  try{ const {error}=await supabase.from('tasks').delete().eq('id',editingTaskId).eq('workspace_id',CONFIG.workspaceId); if(error) throw error; closeTaskModal(); await loadData(false); showToast('Tarefa excluída.'); }
  catch(error){showToast(friendlyError(error));}finally{setLoading(false);}
}
async function toggleAssigneeDone(taskId,personId,authorized=false){
  const task=state.tasks.find(t=>t.id===taskId); const assignment=task?.assignees.find(a=>a.personId===personId); if(!assignment) return;
  if(taskIsPastLocked(task) && !authorized){ const ok=await requestPastAuthorization(task,'edit'); if(!ok)return; }
  const next=!assignment.done;
  try{
    const {error}=await supabase.from('task_assignees').update({done:next,done_at:next?new Date().toISOString():null,done_by:next?session.user.id:null}).eq('workspace_id',CONFIG.workspaceId).eq('task_id',taskId).eq('person_id',personId); if(error) throw error;
    const {data,error:fetchError}=await supabase.from('task_assignees').select('done').eq('workspace_id',CONFIG.workspaceId).eq('task_id',taskId); if(fetchError) throw fetchError;
    const allDone=data.length>0 && data.every(row=>row.done); let targetStatus=task.status;
    if(allDone) targetStatus='concluido'; else if(task.status==='concluido') targetStatus='andamento';
    if(targetStatus!==task.status){ const {error:statusError}=await supabase.from('tasks').update({status:targetStatus,completed_at:allDone?new Date().toISOString():null,updated_by:session.user.id}).eq('workspace_id',CONFIG.workspaceId).eq('id',taskId); if(statusError) throw statusError; }
    await loadData(false); showToast(next?'Participação concluída.':'Participação reaberta.');
  }catch(error){showToast(friendlyError(error));}
}
async function moveTask(taskId,newStatus,authorized=false){
  const task=state.tasks.find(t=>t.id===taskId); if(!task || task.status===newStatus) return;
  if(taskIsPastLocked(task) && !authorized){ const ok=await requestPastAuthorization(task,'edit'); if(!ok)return; authorized=true; }
  try{
    const concluded=newStatus==='concluido';
    const {error}=await supabase.from('tasks').update({status:newStatus,completed_at:concluded?new Date().toISOString():null,updated_by:session.user.id}).eq('workspace_id',CONFIG.workspaceId).eq('id',taskId); if(error) throw error;
    if(concluded){
      const {error:assignmentError}=await supabase.from('task_assignees').update({done:true,done_at:new Date().toISOString(),done_by:session.user.id}).eq('workspace_id',CONFIG.workspaceId).eq('task_id',taskId); if(assignmentError) throw assignmentError;
    }else if(task.status==='concluido'){
      const {error:assignmentError}=await supabase.from('task_assignees').update({done:false,done_at:null,done_by:null}).eq('workspace_id',CONFIG.workspaceId).eq('task_id',taskId); if(assignmentError) throw assignmentError;
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

function setMode(mode){viewMode=mode;const today=new Date();const cursorWeek=startOfWeek(cursorDate);const todayWeek=startOfWeek(today);selectedDay=mode==='week'&&sameLocalDay(cursorWeek,todayWeek)?localISO(today):'all';$('weekModeBtn').classList.toggle('active',mode==='week');$('monthModeBtn').classList.toggle('active',mode==='month');render();}
function shiftPeriod(direction){cursorDate=viewMode==='week'?addDays(cursorDate,7*direction):new Date(cursorDate.getFullYear(),cursorDate.getMonth()+direction,1);selectedDay='all';render();}
function resetFilters(){selectedPerson='all';selectedDay='all';$('searchInput').value='';$('priorityFilter').value='all';$('categoryFilter').value='all';render();showToast('Filtros limpos.');}
function closeSidebarOnMobile(){if(window.innerWidth<=850)$('sidebar').classList.remove('open');}

function exportData(){
  const backup={version:7,exportedAt:new Date().toISOString(),people:state.people.map(p=>({id:p.id,name:p.name,color:p.color})),tasks:state.tasks.map(t=>({id:t.id,title:t.title,description:t.description,assignees:t.assignees,dueDate:t.dueDate,periodStart:t.periodStart,periodEnd:t.periodEnd,scheduleType:t.scheduleType,repeatUntilDone:t.repeatUntilDone,completedAt:t.completedAt,priority:t.priority,status:t.status,category:t.category})),events:state.events.map(e=>({id:e.id,eventDate:e.eventDate,eventTime:normalizeTime(e.eventTime),eventType:e.eventType,title:e.title,description:e.description,participants:e.participants,impact:e.impact}))};
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
      const importedType=['day','week','month'].includes(oldTask.scheduleType)?oldTask.scheduleType:'day';
      const importedRange=scheduleRange(importedType,oldTask.periodStart||oldTask.dueDate||localISO(new Date()),String(oldTask.periodStart||oldTask.dueDate||localISO(new Date())).slice(0,7));
      const periodStart=oldTask.periodStart||localISO(importedRange.start); const periodEnd=oldTask.periodEnd||localISO(importedRange.end);
      const {data,error}=await supabase.from('tasks').insert({workspace_id:CONFIG.workspaceId,title:String(oldTask.title||'Tarefa importada').trim(),description:oldTask.description||null,due_date:periodEnd,period_start:periodStart,period_end:periodEnd,schedule_type:importedType,repeat_until_done:Boolean(oldTask.repeatUntilDone),completed_at:oldTask.completedAt||null,priority:['alta','media','baixa'].includes(oldTask.priority)?oldTask.priority:'media',status:statusOrder.includes(oldTask.status)?oldTask.status:'afazer',category:oldTask.category||null,created_by:session.user.id,updated_by:session.user.id}).select('id').single(); if(error)throw error;
      const rows=rawAssignees.map(a=>({workspace_id:CONFIG.workspaceId,task_id:data.id,person_id:oldToNew.get(a.personId),done:Boolean(a.done),done_at:a.done?new Date().toISOString():null,done_by:a.done?session.user.id:null})).filter(r=>r.person_id);
      if(rows.length){const {error:assignmentError}=await supabase.from('task_assignees').insert(rows);if(assignmentError)throw assignmentError;}
    }
    if(Array.isArray(backup.events)){
      for(const oldEvent of backup.events){
        const {error:eventError}=await supabase.from('lab_events').insert({workspace_id:CONFIG.workspaceId,event_date:oldEvent.eventDate||localISO(new Date()),event_time:normalizeTime(oldEvent.eventTime),event_type:eventTypeFromText(oldEvent.eventType),title:String(oldEvent.title||'Ocorrência importada').trim(),description:oldEvent.description||null,participants:oldEvent.participants||null,impact:oldEvent.impact||null,created_by:session.user.id,updated_by:session.user.id});
        if(eventError) throw eventError;
      }
    }
    await loadData(false);showToast('Backup importado com sucesso.');
  }catch(error){console.error(error);showToast(friendlyError(error));}finally{$('importFile').value='';setLoading(false);}
}


function openEventModal(eventId=null){
  editingEventId=eventId; const event=state.events.find(e=>e.id===eventId);
  $('eventModalTitle').textContent=event?'Editar ocorrência':'Nova ocorrência';
  $('eventDate').value=event?.eventDate||defaultTaskDate(); $('eventTime').value=normalizeTime(event?.eventTime||new Date().toTimeString().slice(0,5)); $('eventType').value=event?.eventType||'visita'; $('eventTitle').value=event?.title||''; $('eventDescription').value=event?.description||''; $('eventParticipants').value=event?.participants||''; $('eventImpact').value=event?.impact||'';
  $('deleteEventBtn').classList.toggle('hidden',!event); $('eventModalBackdrop').classList.remove('hidden'); setTimeout(()=>$('eventTitle').focus(),30);
}
function closeEventModal(){ $('eventModalBackdrop').classList.add('hidden'); editingEventId=null; $('eventForm').reset(); }
async function saveEvent(event){
  event.preventDefault(); const payload={workspace_id:CONFIG.workspaceId,event_date:$('eventDate').value,event_time:normalizeTime($('eventTime').value),event_type:$('eventType').value,title:$('eventTitle').value.trim(),description:$('eventDescription').value.trim()||null,participants:$('eventParticipants').value.trim()||null,impact:$('eventImpact').value.trim()||null,updated_by:session.user.id};
  if(!payload.event_date || !payload.event_time || !payload.title){showToast('Preencha data, horário e título da ocorrência.');return;}
  setLoading(true,editingEventId?'Atualizando ocorrência...':'Criando ocorrência...');
  try{ if(editingEventId){const {error}=await supabase.from('lab_events').update(payload).eq('workspace_id',CONFIG.workspaceId).eq('id',editingEventId); if(error) throw error;} else {const {error}=await supabase.from('lab_events').insert({...payload,created_by:session.user.id}); if(error) throw error;} closeEventModal(); await loadData(false); showToast('Ocorrência salva.'); }catch(error){console.error(error);showToast(friendlyError(error));}finally{setLoading(false);}
}
async function deleteEvent(){
  if(!editingEventId)return; const event=state.events.find(e=>e.id===editingEventId); if(!event || !confirm(`Excluir a ocorrência "${event.title}"?`)) return;
  setLoading(true,'Excluindo ocorrência...'); try{const {error}=await supabase.from('lab_events').delete().eq('workspace_id',CONFIG.workspaceId).eq('id',editingEventId); if(error) throw error; closeEventModal(); await loadData(false); showToast('Ocorrência excluída.');}catch(error){showToast(friendlyError(error));}finally{setLoading(false);}
}
function taskRowsForSheet(tasks=state.tasks){
  return tasks.map(t=>({
    'ID':t.id,'Título':t.title,'Descrição':t.description,'Tipo de período':scheduleTypeLabels[scheduleTypeOf(t)],'Início':t.periodStart||localISO(taskPeriodStart(t)),'Fim':t.periodEnd||localISO(taskPeriodEnd(t)),'Data limite':t.dueDate,
    'Repetir até concluir':t.repeatUntilDone?'Sim':'Não','Concluída em':t.completedAt?new Date(t.completedAt).toLocaleString('pt-BR'):'','Prioridade':t.priority,'Status':statusLabels[t.status]||t.status,'Categoria':t.category,
    'Responsáveis':assigneeNames(t).join('; '),'Responsáveis concluídos':getTaskAssignees(t).filter(a=>a.done).map(a=>getPerson(a.personId).name).join('; '),'Progresso':`${getTaskAssignees(t).filter(a=>a.done).length}/${getTaskAssignees(t).length}`
  }));
}
function eventRowsForSheet(events=state.events){
  return events.map(e=>({'ID':e.id,'Data':e.eventDate,'Horário':normalizeTime(e.eventTime),'Tipo':eventTypeLabels[e.eventType]||e.eventType,'Título':e.title,'Descrição':e.description,'Participantes / visitantes':e.participants,'Impacto / providência':e.impact}));
}
function peopleRowsForSheet(){ return state.people.map(p=>({'ID':p.id,'Nome':p.name,'Cor':p.color})); }
function getWeeklyData(){ const start=startOfWeek(cursorDate); const end=endOfWeek(cursorDate); const tasks=state.tasks.filter(t=>taskVisibleInRange(t,start,end)); const events=state.events.filter(e=>{const d=parseISO(e.eventDate);return d>=start&&d<=end;}); return {start,end,tasks,events}; }
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
        const scheduleType=scheduleTypeFromText(row['Tipo de período']||row['Tipo de periodo']||row['Período']||row['Periodo']);
        const rawStart=row['Início']||row['Inicio']||row['Data']||row['Data para fazer']||row['Prazo'];
        const startIso=excelDateToISO(rawStart); const rawEnd=row['Fim']||row['Data limite'];
        const derived=scheduleRange(scheduleType,startIso,startIso.slice(0,7));
        const periodStart=excelDateToISO(row['Início']||row['Inicio']||localISO(derived.start));
        const periodEnd=rawEnd?excelDateToISO(rawEnd):localISO(derived.end);
        const assigneeNamesList=splitNames(row['Responsáveis']||row['Responsaveis']||row['Responsável']||row['Responsavel']);
        const doneNames=new Set(splitNames(row['Responsáveis concluídos']||row['Responsaveis concluidos']||row['Concluídos']||row['Concluidos']).map(n=>n.toLowerCase()));
        const personIds=[]; for(const name of assigneeNamesList){ const id=await ensurePersonByName(name); if(id) personIds.push(id); }
        if(!personIds.length && state.people[0]) personIds.push(state.people[0].id);
        const status=statusFromText(row['Status']);
        const {data,error}=await supabase.from('tasks').insert({workspace_id:CONFIG.workspaceId,title,description:normalizeText(row['Descrição']||row['Descricao'])||null,due_date:periodEnd,period_start:periodStart,period_end:periodEnd,schedule_type:scheduleType,repeat_until_done:booleanFromText(row['Repetir até concluir']||row['Repetir ate concluir']||row['Repetitiva']),completed_at:status==='concluido'?new Date().toISOString():null,priority:priorityFromText(row['Prioridade']),status,category:normalizeText(row['Categoria'])||null,created_by:session.user.id,updated_by:session.user.id}).select('id').single(); if(error) throw error;
        const assignments=personIds.map(personId=>{ const name=getPerson(personId).name.toLowerCase(); const done=status==='concluido'||doneNames.has(name); return {workspace_id:CONFIG.workspaceId,task_id:data.id,person_id:personId,done,done_at:done?new Date().toISOString():null,done_by:done?session.user.id:null}; });
        if(assignments.length){const {error:assignError}=await supabase.from('task_assignees').insert(assignments); if(assignError) throw assignError;}
      }
    }
    if(eventsSheet){
      const rows=window.XLSX.utils.sheet_to_json(eventsSheet,{defval:'',raw:false});
      for(const row of rows){ const title=normalizeText(row['Título']||row['Titulo']||row['Ocorrência']||row['Ocorrencia']); if(!title) continue; const {error}=await supabase.from('lab_events').insert({workspace_id:CONFIG.workspaceId,event_date:excelDateToISO(row['Data']),event_time:normalizeTime(row['Horário']||row['Horario']||row['Hora']),event_type:eventTypeFromText(row['Tipo']),title,description:normalizeText(row['Descrição']||row['Descricao'])||null,participants:normalizeText(row['Participantes / visitantes']||row['Participantes']||row['Visitantes'])||null,impact:normalizeText(row['Impacto / providência']||row['Impacto']||row['Providência']||row['Providencia'])||null,created_by:session.user.id,updated_by:session.user.id}); if(error) throw error; }
    }
    await loadData(false); showToast('Planilha importada com sucesso.');
  }catch(error){console.error(error);showToast(friendlyError(error));}finally{$('importSheetFile').value='';setLoading(false);}
}
function reportPresentationRange(referenceDate=new Date()){
  const now=new Date(referenceDate);
  const monday=startOfWeek(now);
  const thisMondayCutoff=new Date(monday); thisMondayCutoff.setHours(8,0,0,0);
  let presentationCutoff;
  if(now.getDay()===1 && now>=thisMondayCutoff){
    presentationCutoff=thisMondayCutoff;
  }else if(now<thisMondayCutoff){
    presentationCutoff=thisMondayCutoff;
  }else{
    presentationCutoff=addDays(thisMondayCutoff,7);
  }
  const occurrenceStart=addDays(presentationCutoff,-7);
  const occurrenceEnd=presentationCutoff; // limite exclusivo: 08:00 pertence ao período seguinte
  const taskStart=new Date(occurrenceStart); taskStart.setHours(0,0,0,0);
  const taskEnd=addDays(taskStart,6); taskEnd.setHours(23,59,59,999);
  return {occurrenceStart,occurrenceEnd,taskStart,taskEnd,presentationDate:presentationCutoff};
}
function dataBetween(taskStart,taskEnd,occurrenceStart=taskStart,occurrenceEnd=addDays(taskEnd,1)){
  const tasks=state.tasks.filter(task=>taskVisibleInRange(task,taskStart,taskEnd))
    .sort((a,b)=>localISO(taskPeriodEnd(a)).localeCompare(localISO(taskPeriodEnd(b)))||(a.title||'').localeCompare(b.title||'','pt-BR'));
  const events=state.events.filter(event=>{
    const date=eventDateTime(event); return date && date>=occurrenceStart && date<occurrenceEnd;
  }).sort((a,b)=>(eventDateTime(a)?.getTime()||0)-(eventDateTime(b)?.getTime()||0)||(a.title||'').localeCompare(b.title||'','pt-BR'));
  return {tasks,events};
}
function reportDate(value){
  if(!value)return 'Sem data';
  const date=value instanceof Date?value:parseISO(value);
  return date.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric'});
}
function reportDateTime(value){ return value instanceof Date ? value.toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}) : 'Sem data e horário'; }
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
    lines.push(`${index+1}. ${taskPeriodLabel(task)} | ${statusLabels[task.status]||task.status} | ${reportSafe(task.title)}`);
    lines.push(`   Repetição: ${task.repeatUntilDone?'Até concluir':'Somente no período definido'}${taskCompletedDate(task)?` | Concluída em: ${reportDateTime(taskCompletedDate(task))}`:''}`);
    lines.push(`   Responsáveis: ${taskAssigneeReport(task)}`);
    lines.push(`   Prioridade: ${reportSafe(task.priority,'Média')} | Categoria: ${reportSafe(task.category)}`);
    if(task.description)lines.push(`   Descrição: ${reportSafe(task.description)}`);
  });
}
function generateWeeklyTextReport(){
  const {occurrenceStart,occurrenceEnd,taskStart,taskEnd,presentationDate}=reportPresentationRange(new Date());
  const {tasks,events}=dataBetween(taskStart,taskEnd,occurrenceStart,occurrenceEnd);
  const nextWeekStart=new Date(presentationDate); nextWeekStart.setHours(0,0,0,0); const nextWeekEnd=addDays(nextWeekStart,6); nextWeekEnd.setHours(23,59,59,999);
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
  lines.push(`Apresentação / corte: ${reportDateTime(presentationDate)}`);
  lines.push(`Período das tarefas: ${reportDate(taskStart)} a ${reportDate(taskEnd)} (segunda a domingo)`);
  lines.push(`Período das ocorrências: ${reportDateTime(occurrenceStart)} até antes de ${reportDateTime(occurrenceEnd)}`);
  lines.push('Regra de corte: ocorrências registradas exatamente às 08:00 entram no período seguinte.');
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
      lines.push(`${index+1}. ${formatEventDateTime(event)} | ${eventTypeLabels[event.eventType]||'Outro'} | ${reportSafe(event.title)}`);
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
  anchor.href=url; anchor.download=`LFR_Relatorio_Semanal_${localISO(occurrenceStart)}_08h_a_${localISO(occurrenceEnd)}_08h.txt`;
  document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
  showToast(`Relatório TXT gerado até o corte de ${reportDateTime(occurrenceEnd)}.`);
}

function bindEvents(){
  $('loginForm').addEventListener('submit',login);$('signupBtn').addEventListener('click',signup);$('logoutBtn').addEventListener('click',logout);
  $('weekModeBtn').addEventListener('click',()=>setMode('week'));$('monthModeBtn').addEventListener('click',()=>setMode('month'));$('prevPeriodBtn').addEventListener('click',()=>shiftPeriod(-1));$('nextPeriodBtn').addEventListener('click',()=>shiftPeriod(1));$('todayBtn').addEventListener('click',()=>{cursorDate=new Date();viewMode='week';selectedDay=localISO(new Date());$('weekModeBtn').classList.add('active');$('monthModeBtn').classList.remove('active');render();});
  [$('newTaskBtn'),$('toolbarNewTaskBtn')].forEach(btn=>btn.addEventListener('click',()=>openTaskModal()));[$('teamBtn'),$('managePeopleBtn')].forEach(btn=>btn.addEventListener('click',openTeamModal));
  $('closeTaskModalBtn').addEventListener('click',closeTaskModal);$('cancelTaskBtn').addEventListener('click',closeTaskModal);$('taskForm').addEventListener('submit',saveTask);$('deleteTaskBtn').addEventListener('click',deleteTask);
  $('taskScheduleType').addEventListener('change',updateTaskScheduleFields);$('taskDueDate').addEventListener('change',updateTaskScheduleFields);$('taskMonth').addEventListener('change',updateTaskScheduleFields);$('taskRepeatUntilDone').addEventListener('change',updateTaskScheduleFields);
  $('closeTeamModalBtn').addEventListener('click',closeTeamModal);$('doneTeamBtn').addEventListener('click',closeTeamModal);$('addPersonBtn').addEventListener('click',addPerson);$('newPersonName').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();addPerson();}});
  $('searchInput').addEventListener('input',()=>{renderBoard();renderMetrics();});$('priorityFilter').addEventListener('change',()=>{renderBoard();renderMetrics();});$('categoryFilter').addEventListener('change',()=>{renderBoard();renderMetrics();});$('clearFiltersBtn').addEventListener('click',resetFilters);
  $('exportBtn').addEventListener('click',exportData);$('importBtn').addEventListener('click',()=>$('importFile').click());$('importFile').addEventListener('change',event=>importBackup(event.target.files?.[0]));
  $('exportSheetBtn').addEventListener('click',exportSpreadsheet);$('importSheetBtn').addEventListener('click',()=>$('importSheetFile').click());$('importSheetFile').addEventListener('change',event=>importSpreadsheet(event.target.files?.[0]));$('weeklyTxtBtn').addEventListener('click',generateWeeklyTextReport);
  $('newEventBtn').addEventListener('click',()=>openEventModal());$('closeEventModalBtn').addEventListener('click',closeEventModal);$('cancelEventBtn').addEventListener('click',closeEventModal);$('eventForm').addEventListener('submit',saveEvent);$('deleteEventBtn').addEventListener('click',deleteEvent);
  $('mobileSidebarBtn').addEventListener('click',()=>$('sidebar').classList.toggle('open'));
  $('closePastGuardBtn').addEventListener('click',()=>closePastGuard(false));$('cancelPastGuardBtn').addEventListener('click',()=>closePastGuard(false));$('confirmPastGuardBtn').addEventListener('click',confirmPastGuard);$('pastGuardInput').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();confirmPastGuard();}});
  $('taskModalBackdrop').addEventListener('click',event=>{if(event.target===$('taskModalBackdrop'))closeTaskModal();});$('teamModalBackdrop').addEventListener('click',event=>{if(event.target===$('teamModalBackdrop'))closeTeamModal();});$('eventModalBackdrop').addEventListener('click',event=>{if(event.target===$('eventModalBackdrop'))closeEventModal();});$('pastGuardBackdrop').addEventListener('click',event=>{if(event.target===$('pastGuardBackdrop'))closePastGuard(false);});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'){if(!$('pastGuardBackdrop').classList.contains('hidden'))closePastGuard(false);else{if(!$('taskModalBackdrop').classList.contains('hidden'))closeTaskModal();if(!$('teamModalBackdrop').classList.contains('hidden'))closeTeamModal();if(!$('eventModalBackdrop').classList.contains('hidden'))closeEventModal();$('sidebar').classList.remove('open');}}});
  $('themeBtn').addEventListener('click',()=>{document.body.classList.toggle('dark');localStorage.setItem(THEME_KEY,document.body.classList.contains('dark')?'dark':'light');});
  document.querySelectorAll('.column').forEach(column=>{
    column.addEventListener('dragover',event=>{event.preventDefault();event.dataTransfer.dropEffect='move';column.classList.add('drag-over');});column.addEventListener('dragleave',()=>column.classList.remove('drag-over'));
    column.addEventListener('drop',event=>{event.preventDefault();column.classList.remove('drag-over');const taskId=event.dataTransfer.getData('text/plain')||draggedTaskId;moveTask(taskId,column.dataset.status);});
  });
}

initialize().catch(error=>{console.error(error);setAuthMessage(friendlyError(error),true);});
