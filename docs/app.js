import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.8/+esm';

const CONFIG = window.KANBAN_CONFIG || {};
const THEME_KEY = 'lfr_planejamento_online_theme';
const CACHE_KEY = 'lfr_planejamento_online_cache_v7';
const NOTIFICATION_KEY = 'lfr_fixed_task_notification_date';
const statusOrder = ['planejado', 'afazer', 'andamento', 'concluido'];
const statusLabels = { planejado:'Planejado', afazer:'A fazer', andamento:'Em andamento', concluido:'Concluído' };
const priorityColors = { alta:'#d94b45', media:'#e09f1f', baixa:'#2f8e67' };
const scheduleTypeLabels = { day:'Dia', week:'Semana', month:'Mês', monthly_recurring:'Tarefa fixa mensal' };
const eventTypeLabels = { visita:'Visita', visita_tecnica:'Visita técnica', apresentacao:'Apresentação', manutencao:'Manutenção', queda_luz:'Queda de luz', treinamento:'Treinamento', reuniao:'Reunião', auditoria:'Auditoria', seguranca:'Segurança', outro:'Outro' };
const defaultColors = ['#0b5cab','#7a4cb2','#2f8e67','#c56c24','#d94b45','#0b7a75','#526172','#8c6d1f'];

const $ = (id) => document.getElementById(id);
const esc = (value='') => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch]));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let supabase = null;
let session = null;
let realtimeChannel = null;
let reloadTimer = null;
let state = { people:[], tasks:[], events:[], recurringTemplates:[] };
let viewMode = 'week';
let appView = 'kanban';
let cursorDate = new Date();
let selectedPerson = 'all';
let selectedDay = localISO(new Date());
let editingTaskId = null;
let fixedTaskCreationMode = false;
let editingRecurringTemplateId = null;
let editingTaskUnlocked = false;
let pastGuardResolver = null;
let pastGuardExpected = '';
let pastGuardAction = '';
let pastGuardTaskId = null;
let editingEventId = null;
let currentReportHtml = '';
let currentReportFileName = '';
let currentReportObjectUrl = '';
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
function selectedMonthlyDays(){ return [...document.querySelectorAll('#monthlyDaysPicker input:checked')].map(input=>Number(input.value)).sort((a,b)=>a-b); }
function renderMonthlyDaysPicker(selected=[]){
  const picker=$('monthlyDaysPicker'); if(!picker)return; const set=new Set((selected||[]).map(Number)); picker.innerHTML='';
  for(let day=1;day<=31;day++){
    const wrap=document.createElement('div'); wrap.className='monthly-day-option'; const id=`monthly_day_${day}`;
    wrap.innerHTML=`<input id="${id}" type="checkbox" value="${day}" ${set.has(day)?'checked':''}><label for="${id}">${day}</label>`; picker.appendChild(wrap);
  }
}
function recurringTemplateAssigneeNames(template){ return (template.assigneeIds||[]).map(id=>getPerson(id).name).join(', ')||'Sem responsável'; }
function monthRangeAroundCursor(){ const start=new Date(cursorDate.getFullYear(),cursorDate.getMonth()-1,1); const end=new Date(cursorDate.getFullYear(),cursorDate.getMonth()+2,0); return {start,end}; }
async function ensureRecurringTasksForRange(start,end){
  if(!supabase||!session)return 0;
  const {data,error}=await supabase.rpc('ensure_recurring_tasks',{target_workspace:CONFIG.workspaceId,range_start:localISO(start),range_end:localISO(end)});
  if(error){ if(!String(error.message||'').includes('ensure_recurring_tasks')) console.warn(error); return 0; }
  return Number(data||0);
}
function easterDate(year){
  const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),month=Math.floor((h+l-7*m+114)/31),day=((h+l-7*m+114)%31)+1;
  return new Date(year,month-1,day);
}
function holidayItem(date,name,scope='national',kind='holiday',note=''){ return {date:localISO(date),name,scope,kind,note}; }
function holidaysForYear(year){
  const easter=easterDate(year); const carnivalTuesday=addDays(easter,-47); const carnivalMonday=addDays(easter,-48); const ashWednesday=addDays(easter,-46); const goodFriday=addDays(easter,-2); const corpus=addDays(easter,60);
  const list=[
    holidayItem(new Date(year,0,1),'Confraternização Universal','national'),
    holidayItem(new Date(year,0,20),'São Sebastião — padroeiro da cidade','city'),
    holidayItem(carnivalMonday,'Segunda-feira de Carnaval','optional','optional'),
    holidayItem(carnivalTuesday,'Terça-feira de Carnaval','state'),
    holidayItem(ashWednesday,'Quarta-feira de Cinzas até 14h','optional','optional'),
    holidayItem(goodFriday,'Paixão de Cristo','national'),
    holidayItem(new Date(year,3,21),'Tiradentes','national'),
    holidayItem(new Date(year,3,23),'Dia de São Jorge','state'),
    holidayItem(new Date(year,4,1),'Dia Mundial do Trabalho','national'),
    holidayItem(corpus,'Corpus Christi','city'),
    holidayItem(new Date(year,8,7),'Independência do Brasil','national'),
    holidayItem(new Date(year,9,12),'Nossa Senhora Aparecida','national'),
    holidayItem(new Date(year,9,28),'Dia do Servidor Público','optional','optional'),
    holidayItem(new Date(year,10,2),'Finados','national'),
    holidayItem(new Date(year,10,15),'Proclamação da República','national'),
    holidayItem(new Date(year,10,20),'Dia Nacional de Zumbi e da Consciência Negra','national'),
    holidayItem(new Date(year,11,25),'Natal','national')
  ];
  return list.sort((a,b)=>a.date.localeCompare(b.date));
}
function holidaysForDate(date){ return holidaysForYear(date.getFullYear()).filter(item=>item.date===localISO(date)); }
function holidayScopeLabel(scope,kind){ if(kind==='optional')return 'Ponto facultativo'; return {national:'Feriado nacional',state:'Feriado estadual RJ',city:'Feriado municipal — Rio'}[scope]||'Data especial'; }
function holidayScopeIcon(item){ if(item.kind==='optional')return '🟠'; return {national:'🇧🇷',state:'🔵',city:'🏙️'}[item.scope]||'🎉'; }
function holidayClass(item){ return item.kind==='optional'?'optional':item.scope; }

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
  const initialRange=monthRangeAroundCursor(); await ensureRecurringTasksForRange(initialRange.start,initialRange.end);
  await loadData(true);
  subscribeRealtime();
}
function leaveApplication(){
  if(realtimeChannel && supabase){ supabase.removeChannel(realtimeChannel); realtimeChannel=null; }
  $('appRoot').classList.add('hidden'); $('authView').classList.remove('hidden'); document.body.classList.add('auth-mode');
  state={people:[],tasks:[],events:[],recurringTemplates:[]}; setAuthMessage('Entre com o usuário cadastrado no Supabase.');
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
    const [peopleResult,tasksResult,assigneeResult,eventsResult,templatesResult,templateAssigneesResult]=await Promise.all([
      supabase.from('people').select('id,name,color,active,created_at,updated_at').eq('workspace_id',CONFIG.workspaceId).eq('active',true).order('name'),
      supabase.from('tasks').select('id,title,description,due_date,period_start,period_end,schedule_type,repeat_until_done,completed_at,priority,status,category,recurrence_template_id,occurrence_date,created_at,updated_at').eq('workspace_id',CONFIG.workspaceId).order('due_date'),
      supabase.from('task_assignees').select('task_id,person_id,done,done_at,done_by').eq('workspace_id',CONFIG.workspaceId),
      supabase.from('lab_events').select('id,event_date,event_time,event_type,title,description,participants,impact,created_at,updated_at').eq('workspace_id',CONFIG.workspaceId).order('event_date',{ascending:true}),
      supabase.from('recurring_task_templates').select('id,title,description,days_of_month,starts_on,ends_on,priority,initial_status,category,carry_until_done,active,created_at,updated_at').eq('workspace_id',CONFIG.workspaceId).order('title'),
      supabase.from('recurring_task_assignees').select('template_id,person_id').eq('workspace_id',CONFIG.workspaceId)
    ]);
    for(const result of [peopleResult,tasksResult,assigneeResult,eventsResult,templatesResult,templateAssigneesResult]) if(result.error) throw result.error;
    const assignmentsByTask=new Map();
    for(const row of assigneeResult.data||[]){
      const list=assignmentsByTask.get(row.task_id)||[];
      list.push({personId:row.person_id,done:Boolean(row.done),doneAt:row.done_at,doneBy:row.done_by});
      assignmentsByTask.set(row.task_id,list);
    }
    const templateAssignees=new Map(); for(const row of templateAssigneesResult.data||[]){const list=templateAssignees.get(row.template_id)||[];list.push(row.person_id);templateAssignees.set(row.template_id,list);}
    state={
      people:(peopleResult.data||[]).map(p=>({...p})),
      tasks:(tasksResult.data||[]).map(t=>({
        id:t.id,title:t.title,description:t.description||'',dueDate:t.due_date,
        periodStart:t.period_start||t.due_date,periodEnd:t.period_end||t.due_date,scheduleType:t.schedule_type||'day',repeatUntilDone:Boolean(t.repeat_until_done),completedAt:t.completed_at||null,
        priority:t.priority,status:t.status,category:t.category||'',recurrenceTemplateId:t.recurrence_template_id||null,occurrenceDate:t.occurrence_date||null,createdAt:t.created_at,updatedAt:t.updated_at,assignees:assignmentsByTask.get(t.id)||[]
      })),
      events:(eventsResult.data||[]).map(e=>({
        id:e.id,eventDate:e.event_date,eventTime:normalizeTime(e.event_time),eventType:e.event_type,title:e.title,description:e.description||'',participants:e.participants||'',impact:e.impact||'',createdAt:e.created_at,updatedAt:e.updated_at
      })),
      recurringTemplates:(templatesResult.data||[]).map(t=>({id:t.id,title:t.title,description:t.description||'',daysOfMonth:(t.days_of_month||[]).map(Number),startsOn:t.starts_on,endsOn:t.ends_on||'',priority:t.priority,initialStatus:t.initial_status,category:t.category||'',carryUntilDone:Boolean(t.carry_until_done),active:Boolean(t.active),assigneeIds:templateAssignees.get(t.id)||[],createdAt:t.created_at,updatedAt:t.updated_at}))
    };
    localStorage.setItem(CACHE_KEY,JSON.stringify(state));
    render(); notifyUpcomingFixedTasks(); setConnection('online','Online');
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
    .on('postgres_changes',{event:'*',schema:'public',table:'recurring_task_templates'},scheduleReload)
    .on('postgres_changes',{event:'*',schema:'public',table:'recurring_task_assignees'},scheduleReload)
    .subscribe(status=>{
      if(status==='SUBSCRIBED') setConnection('online','Online');
      else if(status==='CHANNEL_ERROR' || status==='TIMED_OUT') setConnection('offline','Reconectando');
      else if(status==='CLOSED') setConnection('offline','Desconectado');
    });
}
function scheduleReload(){ clearTimeout(reloadTimer); reloadTimer=setTimeout(()=>loadData(false),220); }

function render(){ renderPeriodTitle(); renderCurrentContext(); renderMonthStrip(); renderPeople(); renderFixedTaskAlerts(); renderRecurringTemplatesPanel(); renderCategoryFilter(); renderBoard(); renderMetrics(); renderEventsPanel(); renderCalendar(); renderHolidays(); renderAppView(); }

function upcomingFixedTasks(daysAhead=3){
  const today=startOfDay(new Date()); const limit=addDays(today,daysAhead);
  return state.tasks.filter(task=>task.recurrenceTemplateId&&task.status!=='concluido').filter(task=>{const due=parseISO(task.occurrenceDate||task.dueDate);return due>=today&&due<=limit;}).sort((a,b)=>(a.occurrenceDate||a.dueDate).localeCompare(b.occurrenceDate||b.dueDate)||a.title.localeCompare(b.title,'pt-BR'));
}
function fixedAlertLabel(task){const days=Math.round((parseISO(task.occurrenceDate||task.dueDate)-startOfDay(new Date()))/86400000);return days===0?'É hoje':days===1?'Amanhã':`Daqui a ${days} dias`;}
function renderFixedTaskAlerts(){
  const panel=$('fixedAlertsPanel'); if(!panel)return; const tasks=upcomingFixedTasks(); $('fixedAlertsCount').textContent=tasks.length; panel.innerHTML='';
  if(!tasks.length) panel.innerHTML='<div class="empty">Nenhuma tarefa fixa nos próximos 3 dias.</div>';
  tasks.slice(0,6).forEach(task=>{const button=document.createElement('button');button.type='button';button.className=`fixed-alert-item ${fixedAlertLabel(task)==='É hoje'?'today':''}`;button.innerHTML=`<div class="fixed-alert-title">📌 ${esc(task.title)}</div><div class="fixed-alert-meta"><strong>${fixedAlertLabel(task)}</strong> • ${formatShortDate(task.occurrenceDate||task.dueDate)} • ${esc(assigneeNames(task).join(', ')||'Sem responsável')}</div>`;button.addEventListener('click',()=>requestTaskEdit(task.id));panel.appendChild(button);});
  const notificationButton=$('enableNotificationsBtn'); if(!('Notification' in window)){notificationButton.classList.add('hidden');return;} notificationButton.classList.remove('hidden'); notificationButton.classList.toggle('enabled',Notification.permission==='granted');notificationButton.classList.toggle('denied',Notification.permission==='denied');notificationButton.innerHTML=Notification.permission==='granted'?'<span class="btn-icon">✅</span> Avisos do navegador ativos':Notification.permission==='denied'?'<span class="btn-icon">🔕</span> Avisos bloqueados no navegador':'<span class="btn-icon">🔔</span> Ativar avisos do navegador';
}
async function enableBrowserNotifications(){
  if(!('Notification' in window)){showToast('Este navegador não oferece notificações. Os avisos continuarão visíveis no Kanban.');return;}
  if(Notification.permission==='denied'){showToast('As notificações estão bloqueadas. Libere-as nas configurações do navegador.');return;}
  const permission=await Notification.requestPermission();renderFixedTaskAlerts();if(permission==='granted'){showToast('Avisos do navegador ativados.');notifyUpcomingFixedTasks(true);}else showToast('Os avisos continuarão aparecendo dentro do Kanban.');
}
function notifyUpcomingFixedTasks(force=false){
  if(!('Notification' in window)||Notification.permission!=='granted')return;const today=localISO(new Date());if(!force&&localStorage.getItem(NOTIFICATION_KEY)===today)return;const tasks=upcomingFixedTasks();if(!tasks.length)return;
  const todayCount=tasks.filter(task=>fixedAlertLabel(task)==='É hoje').length;const body=todayCount?`${todayCount} tarefa(s) fixa(s) para hoje e ${tasks.length-todayCount} chegando.`:`${tasks.length} tarefa(s) fixa(s) chegando nos próximos 3 dias.`;new Notification('LFR • Tarefas fixas',{body,icon:'./favicon.ico',tag:`lfr-fixed-${today}`});localStorage.setItem(NOTIFICATION_KEY,today);
}
function renderPeriodTitle(){
  if(appView==='calendar'||appView==='holidays'){ const text=cursorDate.toLocaleDateString('pt-BR',{month:'long',year:'numeric'}); $('periodTitle').textContent=capitalize(text); return; }
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
  if(task.recurrenceTemplateId) badges.push('<span class="repeat-badge recurring-badge">🔁 Mensal</span>');
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

function renderRecurringTemplatesPanel(){
  const panel=$('recurringTemplatesPanel'); if(!panel)return; const templates=state.recurringTemplates||[]; $('recurringCount').textContent=templates.filter(t=>t.active).length; panel.innerHTML='';
  if(!templates.length){panel.innerHTML='<div class="empty">Nenhuma regra mensal.</div>';return;}
  templates.slice(0,5).forEach(template=>{const card=document.createElement('div');card.className=`recurring-template-card ${template.active?'':'inactive'}`;card.innerHTML=`<div class="recurring-template-title">🔁 ${esc(template.title)}</div><div class="recurring-template-meta">Dias ${template.daysOfMonth.join(', ')} • ${template.active?'Ativa':'Desativada'}<br>${esc(recurringTemplateAssigneeNames(template))}</div>`;panel.appendChild(card);});
}
function openRecurringModal(){renderRecurringManager();$('recurringModalBackdrop').classList.remove('hidden');}
function closeRecurringModal(){$('recurringModalBackdrop').classList.add('hidden');render();}
function renderRecurringManager(){
  const list=$('recurringManagerList'); list.innerHTML=''; const templates=state.recurringTemplates||[];
  if(!templates.length){list.innerHTML='<div class="empty">Clique em “Tarefa fixa” para criar a primeira regra mensal.</div>';return;}
  templates.forEach(template=>{const row=document.createElement('div');row.className='recurring-manager-row';row.innerHTML=`<div><div class="recurring-template-title">${template.active?'🔁':'⏸️'} ${esc(template.title)}</div><div class="recurring-template-meta">Dias ${template.daysOfMonth.join(', ')} de cada mês • início ${formatShortDate(template.startsOn)}${template.endsOn?` • fim ${formatShortDate(template.endsOn)}`:' • sem data final'}<br>${esc(recurringTemplateAssigneeNames(template))}</div></div><div class="recurring-manager-actions"><button class="btn small edit-template" type="button">✏️ Editar</button><button class="btn small toggle-template" type="button">${template.active?'Desativar':'Ativar'}</button><button class="btn small danger delete-template" type="button">Excluir regra</button></div>`;row.querySelector('.edit-template').addEventListener('click',()=>openFixedTaskModal(template.id));row.querySelector('.toggle-template').addEventListener('click',()=>toggleRecurringTemplate(template));row.querySelector('.delete-template').addEventListener('click',()=>deleteRecurringTemplate(template));list.appendChild(row);});
}
async function toggleRecurringTemplate(template){try{const {error}=await supabase.from('recurring_task_templates').update({active:!template.active,updated_by:session.user.id}).eq('workspace_id',CONFIG.workspaceId).eq('id',template.id);if(error)throw error;await loadData(false);renderRecurringManager();showToast(template.active?'Recorrência desativada.':'Recorrência ativada.');}catch(error){showToast(friendlyError(error));}}
async function deleteRecurringTemplate(template){if(!confirm(`Excluir a regra mensal “${template.title}”? As tarefas já geradas serão preservadas.`))return;try{const {error}=await supabase.from('recurring_task_templates').delete().eq('workspace_id',CONFIG.workspaceId).eq('id',template.id);if(error)throw error;await loadData(false);renderRecurringManager();showToast('Regra mensal excluída; histórico preservado.');}catch(error){showToast(friendlyError(error));}}
function renderAppView(){
  $('kanbanView').classList.toggle('hidden',appView!=='kanban'); $('calendarView').classList.toggle('hidden',appView!=='calendar'); $('holidaysView').classList.toggle('hidden',appView!=='holidays'); $('kanbanPeriodSwitch').classList.toggle('hidden',appView!=='kanban');
  $('kanbanViewBtn').classList.toggle('active',appView==='kanban');$('calendarViewBtn').classList.toggle('active',appView==='calendar');$('holidaysViewBtn').classList.toggle('active',appView==='holidays');
}
async function setAppView(next){appView=next;if(next!=='kanban')viewMode='month';const range=monthRangeAroundCursor();await ensureRecurringTasksForRange(range.start,range.end);await loadData(false);}
function renderCalendar(){
  const grid=$('calendarGrid'); if(!grid)return; grid.innerHTML=''; const monthStart=startOfMonth(cursorDate); const first=startOfWeek(monthStart); const today=new Date();
  for(let i=0;i<42;i++){const date=addDays(first,i);const iso=localISO(date);const tasks=state.tasks.filter(t=>taskVisibleOnDate(t,date));const events=state.events.filter(e=>e.eventDate===iso);const holidays=holidaysForDate(date);const cell=document.createElement('button');cell.type='button';cell.className=`calendar-day ${date.getMonth()===cursorDate.getMonth()?'':'outside'} ${sameLocalDay(date,today)?'today':''} ${holidays.length?'has-holiday':''}`;
    const holidayHtml=holidays.map(h=>`<div class="calendar-holiday ${holidayClass(h)}">${holidayScopeIcon(h)} ${esc(h.name)}</div>`).join('');const taskHtml=tasks.slice(0,3).map(t=>`<div class="calendar-task">${statusIcon(t.status)} ${esc(t.title)}</div>`).join('');const more=tasks.length>3?`<div class="calendar-more">+${tasks.length-3} tarefa(s)</div>`:'';const eventHtml=events.length?`<div class="calendar-event-dot">⚠️ ${events.length} ocorrência(s)</div>`:'';
    cell.innerHTML=`<div class="calendar-day-head"><span class="calendar-day-number">${date.getDate()}</span><span class="calendar-day-counts">${tasks.length?'📋 '+tasks.length:''}</span></div><div class="calendar-holidays">${holidayHtml}</div><div class="calendar-tasks">${taskHtml}${more}</div>${eventHtml}`;
    cell.addEventListener('click',()=>{cursorDate=new Date(date);selectedDay=iso;viewMode='week';appView='kanban';$('weekModeBtn').classList.add('active');$('monthModeBtn').classList.remove('active');render();});grid.appendChild(cell);
  }
}
function renderHolidays(){
  const list=$('holidaysList'); if(!list)return; const year=cursorDate.getFullYear();$('holidaysYearBadge').textContent=year;const holidays=holidaysForYear(year);list.innerHTML='';
  for(let month=0;month<12;month++){const items=holidays.filter(item=>parseISO(item.date).getMonth()===month);if(!items.length)continue;const card=document.createElement('section');card.className='holiday-month-card';card.innerHTML=`<h3>${capitalize(new Date(year,month,1).toLocaleDateString('pt-BR',{month:'long'}))}</h3>`+items.map(item=>`<div class="holiday-list-item"><div class="holiday-date-box">${parseISO(item.date).getDate()}<br><small>${parseISO(item.date).toLocaleDateString('pt-BR',{weekday:'short'}).replace('.','')}</small></div><div><div class="holiday-name">${holidayScopeIcon(item)} ${esc(item.name)}</div><div class="holiday-meta"><span class="holiday-tag">${esc(holidayScopeLabel(item.scope,item.kind))}</span></div></div></div>`).join('');list.appendChild(card);}
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
  const type=$('taskScheduleType').value; if(type==='monthly_recurring'){const start=$('recurrenceStartsOn').value||localISO(new Date());return {type,start:parseISO(start),end:parseISO(start)};}
  return scheduleRange(type,$('taskDueDate').value,$('taskMonth').value);
}

function updateTaskScheduleFields(){
  const type=$('taskScheduleType').value; const recurring=type==='monthly_recurring';
  $('taskDateField').classList.toggle('hidden',type==='month'||recurring); $('taskMonthField').classList.toggle('hidden',type!=='month'); $('monthlyRecurrenceFields').classList.toggle('hidden',!recurring); $('taskRepeatUntilDone').closest('.repeat-toggle').parentElement.classList.toggle('hidden',recurring);
  $('taskDateLabel').textContent=type==='week'?'Escolha um dia da semana *':'Data da tarefa *';
  if(recurring){const days=selectedMonthlyDays();$('taskSchedulePreview').textContent=days.length?`Todo mês nos dias ${days.join(', ')}. Cada data terá conclusão independente.`:'Selecione um ou mais dias do mês.';return;}
  const range=scheduleFromForm(); const repeat=$('taskRepeatUntilDone').checked;let message=`${scheduleTypeLabels[range.type]}: ${range.start.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric'})}`;if(range.type!=='day')message+=` até ${range.end.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric'})}`;message+=repeat?' • Se não for concluída, continuará aparecendo até a conclusão.':' • Depois desse período, ficará apenas no histórico.';$('taskSchedulePreview').textContent=message;
}
function setTaskScheduleForm(task=null){
  const type=task?scheduleTypeOf(task):'day'; const start=task?taskPeriodStart(task):parseISO(defaultTaskDate());
  $('taskScheduleType').value=type;
  $('taskDueDate').value=localISO(start);
  $('taskMonth').value=`${start.getFullYear()}-${String(start.getMonth()+1).padStart(2,'0')}`;
  $('taskRepeatUntilDone').checked=Boolean(task?.repeatUntilDone); $('recurrenceStartsOn').value=localISO(startOfDay(new Date())); $('recurrenceEndsOn').value=''; renderMonthlyDaysPicker([]); $('recurrenceInstanceNotice').classList.toggle('hidden',!task?.recurrenceTemplateId); $('taskScheduleType').disabled=Boolean(task?.recurrenceTemplateId);
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
function openFixedTaskModal(templateId=null){
  if(!state.people.length){showToast('Cadastre pelo menos um responsável.');openTeamModal();return;}
  const template=templateId?state.recurringTemplates.find(item=>item.id===templateId):null; editingRecurringTemplateId=template?.id||null; fixedTaskCreationMode=true; closeRecurringModal(); openTaskModal();
  $('taskModalTitle').textContent=template?'✏️ Editar tarefa fixa':'📌 Nova tarefa fixa'; $('taskScheduleType').value='monthly_recurring'; $('taskScheduleType').disabled=true;
  $('taskScheduleTypeField').classList.add('hidden'); $('taskStatus').value='afazer'; $('taskStatus').disabled=true; $('taskStatusField').classList.add('hidden');
  if(template){$('taskTitle').value=template.title;$('taskDescription').value=template.description;$('taskPriority').value=template.priority;$('taskCategory').value=template.category;$('recurrenceStartsOn').value=template.startsOn;$('recurrenceEndsOn').value=template.endsOn||'';renderMonthlyDaysPicker(template.daysOfMonth);renderTaskAssigneePicker(template.assigneeIds.map(personId=>({personId})));}else $('recurrenceStartsOn').value=defaultTaskDate(); updateTaskScheduleFields();
}
function closeTaskModal(){ $('taskModalBackdrop').classList.add('hidden'); editingTaskId=null; editingRecurringTemplateId=null; editingTaskUnlocked=false; fixedTaskCreationMode=false; $('taskScheduleType').disabled=false; $('taskStatus').disabled=false; $('taskScheduleTypeField').classList.remove('hidden'); $('taskStatusField').classList.remove('hidden'); $('taskForm').reset(); }

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
  if(!editingTaskId && $('taskScheduleType').value==='monthly_recurring'){
    const title=$('taskTitle').value.trim(); const days=selectedMonthlyDays(); const startsOn=$('recurrenceStartsOn').value; const endsOn=$('recurrenceEndsOn').value||null;
    if(!title||!assigneeIds.length||!days.length||!startsOn){showToast('Preencha título, responsáveis, início e pelo menos um dia do mês.');return;} if(endsOn&&endsOn<startsOn){showToast('A data final não pode ser anterior ao início.');return;}
    setLoading(true,editingRecurringTemplateId?'Atualizando tarefa fixa...':'Criando tarefa fixa...');
    try{const existingTemplate=state.recurringTemplates.find(item=>item.id===editingRecurringTemplateId);const templatePayload={workspace_id:CONFIG.workspaceId,title,description:$('taskDescription').value.trim()||null,days_of_month:days,starts_on:startsOn,ends_on:endsOn,priority:$('taskPriority').value,initial_status:'afazer',category:$('taskCategory').value.trim()||null,carry_until_done:false,active:existingTemplate?existingTemplate.active:true,updated_by:session.user.id};let templateId=editingRecurringTemplateId;
      if(templateId){const {error}=await supabase.from('recurring_task_templates').update(templatePayload).eq('workspace_id',CONFIG.workspaceId).eq('id',templateId);if(error)throw error;const {error:deleteAssigneesError}=await supabase.from('recurring_task_assignees').delete().eq('workspace_id',CONFIG.workspaceId).eq('template_id',templateId);if(deleteAssigneesError)throw deleteAssigneesError;const {error:deleteFutureError}=await supabase.from('tasks').delete().eq('workspace_id',CONFIG.workspaceId).eq('recurrence_template_id',templateId).eq('status','afazer').gte('occurrence_date',localISO(new Date()));if(deleteFutureError)throw deleteFutureError;}
      else{const {data,error}=await supabase.from('recurring_task_templates').insert({...templatePayload,created_by:session.user.id}).select('id').single();if(error)throw error;templateId=data.id;}
      const rows=assigneeIds.map(personId=>({workspace_id:CONFIG.workspaceId,template_id:templateId,person_id:personId}));const {error:assignError}=await supabase.from('recurring_task_assignees').insert(rows);if(assignError)throw assignError;const range=monthRangeAroundCursor();await ensureRecurringTasksForRange(range.start,range.end);const wasEditingTemplate=Boolean(editingRecurringTemplateId);closeTaskModal();await loadData(false);showToast(wasEditingTemplate?'Tarefa fixa atualizada; próximas ocorrências foram recalculadas.':'Tarefa fixa criada. Ela entrará como “A fazer” nos dias escolhidos.');}catch(error){console.error(error);showToast(friendlyError(error));}finally{setLoading(false);}return;
  }
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

async function setMode(mode){viewMode=mode;const today=new Date();const cursorWeek=startOfWeek(cursorDate);const todayWeek=startOfWeek(today);selectedDay=mode==='week'&&sameLocalDay(cursorWeek,todayWeek)?localISO(today):'all';$('weekModeBtn').classList.toggle('active',mode==='week');$('monthModeBtn').classList.toggle('active',mode==='month');const range=monthRangeAroundCursor();await ensureRecurringTasksForRange(range.start,range.end);await loadData(false);}
async function shiftPeriod(direction){cursorDate=(appView==='kanban'&&viewMode==='week')?addDays(cursorDate,7*direction):new Date(cursorDate.getFullYear(),cursorDate.getMonth()+direction,1);selectedDay='all';const range=monthRangeAroundCursor();await ensureRecurringTasksForRange(range.start,range.end);await loadData(false);}
function resetFilters(){selectedPerson='all';selectedDay='all';$('searchInput').value='';$('priorityFilter').value='all';$('categoryFilter').value='all';render();showToast('Filtros limpos.');}
function closeSidebarOnMobile(){if(window.innerWidth<=850)$('sidebar').classList.remove('open');}

function exportData(){
  const backup={version:10,exportedAt:new Date().toISOString(),people:state.people.map(p=>({id:p.id,name:p.name,color:p.color})),tasks:state.tasks.map(t=>({id:t.id,title:t.title,description:t.description,assignees:t.assignees,dueDate:t.dueDate,periodStart:t.periodStart,periodEnd:t.periodEnd,scheduleType:t.scheduleType,repeatUntilDone:t.repeatUntilDone,completedAt:t.completedAt,priority:t.priority,status:t.status,category:t.category})),events:state.events.map(e=>({id:e.id,eventDate:e.eventDate,eventTime:normalizeTime(e.eventTime),eventType:e.eventType,title:e.title,description:e.description,participants:e.participants,impact:e.impact})),recurringTemplates:state.recurringTemplates};
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
function htmlEsc(value){
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}
function downloadBlob(content,type,fileName){
  const blob=new Blob([content],{type});
  const url=URL.createObjectURL(blob); const anchor=document.createElement('a');
  anchor.href=url; anchor.download=fileName; document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
}
function reportMetrics(tasks,events){
  return {
    total:tasks.length,
    completed:tasks.filter(task=>task.status==='concluido').length,
    inProgress:tasks.filter(task=>task.status==='andamento').length,
    pending:tasks.filter(task=>task.status==='planejado'||task.status==='afazer').length,
    overdue:tasks.filter(isOverdue).length,
    events:events.length
  };
}
function eventTypeIcon(type){
  return {visita:'👥',visita_tecnica:'🛠️',apresentacao:'📽️',manutencao:'🔧',queda_luz:'⚡',treinamento:'🎓',reuniao:'🗣️',auditoria:'📋',seguranca:'🦺',outro:'📌'}[type]||'📌';
}
function statusIcon(status){
  return {planejado:'🗂️',afazer:'📌',andamento:'⚙️',concluido:'✅'}[status]||'📌';
}
function priorityIcon(priority){
  return {alta:'🔴',media:'🟠',baixa:'🟢'}[priority]||'⚪';
}
function groupedTasksByStatus(tasks){
  return {
    concluido:tasks.filter(task=>task.status==='concluido'),
    andamento:tasks.filter(task=>task.status==='andamento'),
    pendente:tasks.filter(task=>task.status==='planejado'||task.status==='afazer')
  };
}
function weeklyResponsibleSummary(tasks){
  return state.people.map(person=>{
    const assigned=tasks.filter(task=>taskHasPerson(task,person.id));
    const individualDone=assigned.filter(task=>getTaskAssignees(task).some(item=>item.personId===person.id&&item.done)).length;
    return {name:person.name,total:assigned.length,done:individualDone,pending:assigned.length-individualDone};
  }).filter(item=>item.total>0).sort((a,b)=>b.total-a.total||a.name.localeCompare(b.name,'pt-BR'));
}
function buildWeeklyHtmlReport(){
  const {occurrenceStart,occurrenceEnd,taskStart,taskEnd,presentationDate}=reportPresentationRange(new Date());
  const {tasks,events}=dataBetween(taskStart,taskEnd,occurrenceStart,occurrenceEnd);
  const nextWeekStart=new Date(presentationDate); nextWeekStart.setHours(0,0,0,0);
  const nextWeekEnd=addDays(nextWeekStart,6); nextWeekEnd.setHours(23,59,59,999);
  const nextWeekTasks=dataBetween(nextWeekStart,nextWeekEnd).tasks.filter(task=>task.status!=='concluido');
  const metrics=reportMetrics(tasks,events);
  const groups=groupedTasksByStatus(tasks);
  const peopleSummary=weeklyResponsibleSummary(tasks);
  const eventCounts=events.reduce((acc,event)=>{ const label=eventTypeLabels[event.eventType]||'Outro'; acc[label]=(acc[label]||0)+1; return acc; },{});
  const eventBadges = Object.entries(eventCounts).map(([name,count])=>`<span class="mini-badge">${htmlEsc(name)}: <strong>${count}</strong></span>`).join('') || '<span class="muted">Nenhuma ocorrência registrada.</span>';
  const taskCard = task => `
    <article class="report-task-card report-status-${htmlEsc(task.status)}">
      <div class="report-task-top">
        <div>
          <div class="report-task-title">${statusIcon(task.status)} ${htmlEsc(task.title)}</div>
          <div class="report-task-sub">${htmlEsc(taskPeriodLabel(task))} • ${htmlEsc(statusLabels[task.status]||task.status)} • ${priorityIcon(task.priority)} ${htmlEsc(task.priority||'média')}</div>
        </div>
        <span class="pill">${task.repeatUntilDone?'Repetitiva até concluir':'Período único'}</span>
      </div>
      ${task.description?`<div class="report-task-desc">${htmlEsc(task.description)}</div>`:''}
      <div class="report-line"><strong>Responsáveis:</strong> ${htmlEsc(taskAssigneeReport(task))}</div>
      <div class="report-line"><strong>Categoria:</strong> ${htmlEsc(reportSafe(task.category))}</div>
      ${taskCompletedDate(task)?`<div class="report-line"><strong>Concluída em:</strong> ${htmlEsc(reportDateTime(taskCompletedDate(task)))}</div>`:''}
    </article>`;
  const eventCard = event => `
    <article class="event-card">
      <div class="event-card-top">
        <span class="event-pill">${eventTypeIcon(event.eventType)} ${htmlEsc(eventTypeLabels[event.eventType]||'Outro')}</span>
        <span class="event-date">${htmlEsc(formatEventDateTime(event))}</span>
      </div>
      <div class="event-title-html">${htmlEsc(event.title)}</div>
      <div class="event-desc-html">${htmlEsc(reportSafe(event.description))}</div>
      <div class="report-line"><strong>Participantes / visitantes:</strong> ${htmlEsc(reportSafe(event.participants))}</div>
      <div class="report-line"><strong>Impacto / providência:</strong> ${htmlEsc(reportSafe(event.impact))}</div>
    </article>`;
  const peopleRows = peopleSummary.length ? peopleSummary.map(item=>`<tr><td>${htmlEsc(item.name)}</td><td>${item.total}</td><td>${item.done}</td><td>${item.pending}</td></tr>`).join('') : '<tr><td colspan="4">Nenhum responsável com tarefa no período.</td></tr>';
  const nextSteps = nextWeekTasks.length ? nextWeekTasks.map(task=>`<li><strong>${htmlEsc(task.title)}</strong> — ${htmlEsc(taskPeriodLabel(task))} — ${htmlEsc(taskAssigneeReport(task))}</li>`).join('') : '<li>Nenhuma pendência aberta para a próxima semana.</li>';

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Relatório Semanal LFR</title>
<style>
:root{--bg:#eef3f8;--surface:#ffffff;--surface-2:#f6f9fc;--line:#d9e2ec;--text:#182335;--muted:#607086;--primary:#0b5cab;--teal:#0b7a75;--warning:#d99813;--success:#21875a;--danger:#c9302c;--shadow:0 12px 28px rgba(12,32,58,.08)}
*{box-sizing:border-box}body{margin:0;font-family:Inter,Segoe UI,Arial,sans-serif;background:var(--bg);color:var(--text)}
.report-shell{max-width:1160px;margin:0 auto;padding:26px 18px 42px}.hero{background:linear-gradient(135deg,#082b52,#0b5cab 56%,#0b7a75);color:#fff;border-radius:24px;padding:28px;box-shadow:0 18px 50px rgba(7,26,48,.22)}
.hero-top{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;flex-wrap:wrap}.brand{display:flex;gap:14px;align-items:center}.brand-mark{width:58px;height:58px;border-radius:50%;display:grid;place-items:center;border:3px solid rgba(255,255,255,.8);font-weight:900}.hero h1{margin:0 0 6px;font-size:30px}.hero p{margin:0;color:rgba(255,255,255,.85)}
.hero-tags{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}.hero-tag{padding:8px 12px;border-radius:999px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.18);font-size:13px;font-weight:700}
.metrics{display:grid;grid-template-columns:repeat(6,minmax(140px,1fr));gap:12px;margin:18px 0 0}.metric{background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.18);border-radius:18px;padding:14px}.metric strong{display:block;font-size:28px;margin-top:6px}.metric span{font-size:12px;color:rgba(255,255,255,.82)}
.report-grid{display:grid;grid-template-columns:1.2fr .8fr;gap:18px;margin-top:18px}.panel{background:var(--surface);border:1px solid var(--line);border-radius:22px;padding:20px;box-shadow:var(--shadow)}.panel h2{margin:0 0 12px;font-size:20px}.panel h3{margin:0 0 12px;font-size:16px}.muted{color:var(--muted)}
.mini-badge{display:inline-flex;gap:6px;align-items:center;padding:8px 10px;border-radius:999px;background:#eef5fd;border:1px solid #d7e7f8;font-size:12px;font-weight:700;margin:0 8px 8px 0}
.timeline{display:flex;flex-direction:column;gap:12px}.event-card{border:1px solid var(--line);background:var(--surface-2);border-radius:18px;padding:14px}.event-card-top{display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px}.event-pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;background:#e8f2fc;color:var(--primary);padding:6px 10px;font-size:12px;font-weight:800}.event-date{font-size:12px;color:var(--muted);font-weight:700}.event-title-html{font-size:16px;font-weight:850;margin-bottom:6px}.event-desc-html{font-size:13px;color:var(--muted);line-height:1.45;margin-bottom:8px}
.task-group{margin-top:18px}.task-group-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}.group-badge{padding:8px 10px;border-radius:999px;background:#f1f6fb;border:1px solid var(--line);font-size:12px;font-weight:800}.task-list{display:flex;flex-direction:column;gap:12px}.report-task-card{border:1px solid var(--line);border-left-width:5px;background:var(--surface-2);border-radius:18px;padding:14px}.report-status-concluido{border-left-color:var(--success)}.report-status-andamento{border-left-color:var(--warning)}.report-status-planejado,.report-status-afazer,.report-status-pendente{border-left-color:var(--primary)}
.report-task-top{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap}.report-task-title{font-size:16px;font-weight:900}.report-task-sub{font-size:12px;color:var(--muted);margin-top:4px}.report-task-desc{font-size:13px;line-height:1.55;color:var(--text);margin:10px 0}.pill{display:inline-flex;padding:7px 10px;border-radius:999px;background:#eef5fd;color:var(--primary);font-size:12px;font-weight:800}.report-line{font-size:13px;line-height:1.5;margin-top:4px}
.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse}th,td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left;font-size:13px}th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);background:#f8fbfe}.checklist{padding-left:18px;margin:8px 0 0}.checklist li{margin-bottom:8px;line-height:1.45}
.footer-note{margin-top:18px;font-size:12px;color:var(--muted);text-align:center}
@media print{body{background:#fff}.report-shell{max-width:none;padding:0}.hero{box-shadow:none}.panel{box-shadow:none;break-inside:avoid}.event-card,.report-task-card{break-inside:avoid}.footer-note{margin-top:10px}}
@media (max-width:980px){.metrics{grid-template-columns:repeat(2,1fr)}.report-grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="report-shell">
  <section class="hero">
    <div class="hero-top">
      <div>
        <div class="brand"><div class="brand-mark">LFR</div><div><h1>Relatório Semanal do Laboratório</h1><p>Página HTML estilizada para leitura, impressão e apresentação</p></div></div>
      </div>
      <div class="muted-box">
        <div class="hero-tag">🕗 Apresentação / corte: ${htmlEsc(reportDateTime(presentationDate))}</div>
      </div>
    </div>
    <div class="hero-tags">
      <span class="hero-tag">📅 Tarefas: ${htmlEsc(reportDate(taskStart))} a ${htmlEsc(reportDate(taskEnd))}</span>
      <span class="hero-tag">⚠️ Ocorrências: ${htmlEsc(reportDateTime(occurrenceStart))} até antes de ${htmlEsc(reportDateTime(occurrenceEnd))}</span>
      <span class="hero-tag">ℹ️ Regra: ocorrências às 08:00 entram no próximo período</span>
    </div>
    <div class="metrics">
      <div class="metric"><span>📋 Tarefas no período</span><strong>${metrics.total}</strong></div>
      <div class="metric"><span>✅ Concluídas</span><strong>${metrics.completed}</strong></div>
      <div class="metric"><span>⚙️ Em andamento</span><strong>${metrics.inProgress}</strong></div>
      <div class="metric"><span>📌 Pendentes</span><strong>${metrics.pending}</strong></div>
      <div class="metric"><span>⏰ Atrasadas</span><strong>${metrics.overdue}</strong></div>
      <div class="metric"><span>⚠️ Ocorrências</span><strong>${metrics.events}</strong></div>
    </div>
  </section>

  <section class="report-grid">
    <div class="panel">
      <h2>⚠️ Ocorrências da semana</h2>
      <div>${eventBadges}</div>
      <div class="timeline">${events.length ? events.map(eventCard).join('') : '<div class="muted">Nenhuma ocorrência registrada no período.</div>'}</div>
    </div>
    <div class="panel">
      <h2>👥 Resumo por responsável</h2>
      <div class="table-wrap"><table><thead><tr><th>Responsável</th><th>Total</th><th>Concluiu</th><th>Pendente</th></tr></thead><tbody>${peopleRows}</tbody></table></div>
      <div class="task-group">
        <h3>🗣️ Observações para a apresentação</h3>
        <ul class="checklist">
          <li>Confirmar se todas as ocorrências relevantes foram cadastradas.</li>
          <li>Destacar impactos, providências tomadas e pendências que precisam de apoio.</li>
          <li>Usar esta página como apoio visual ou imprimir em PDF.</li>
        </ul>
      </div>
      <div class="task-group">
        <h3>➡️ Próximos passos — ${htmlEsc(reportDate(nextWeekStart))} a ${htmlEsc(reportDate(nextWeekEnd))}</h3>
        <ul class="checklist">${nextSteps}</ul>
      </div>
    </div>
  </section>

  <section class="panel task-group">
    <div class="task-group-head"><h2>✅ Tarefas concluídas</h2><span class="group-badge">${groups.concluido.length}</span></div>
    <div class="task-list">${groups.concluido.length ? groups.concluido.map(taskCard).join('') : '<div class="muted">Nenhuma tarefa concluída no período.</div>'}</div>
  </section>

  <section class="panel task-group">
    <div class="task-group-head"><h2>⚙️ Tarefas em andamento</h2><span class="group-badge">${groups.andamento.length}</span></div>
    <div class="task-list">${groups.andamento.length ? groups.andamento.map(taskCard).join('') : '<div class="muted">Nenhuma tarefa em andamento no período.</div>'}</div>
  </section>

  <section class="panel task-group">
    <div class="task-group-head"><h2>📌 Tarefas planejadas, pendentes ou a fazer</h2><span class="group-badge">${groups.pendente.length}</span></div>
    <div class="task-list">${groups.pendente.length ? groups.pendente.map(taskCard).join('') : '<div class="muted">Nenhuma tarefa pendente no período.</div>'}</div>
  </section>

  <div class="footer-note">Relatório gerado em ${htmlEsc(new Date().toLocaleString('pt-BR'))} • LFR Planejamento Online • desenvolvido por Guilherme Sollo</div>
</div>
</body>
</html>`;
  return {html,occurrenceStart,occurrenceEnd};
}
function prepareWeeklyHtmlReport(){
  const report=buildWeeklyHtmlReport();
  currentReportHtml='\ufeff'+report.html;
  currentReportFileName=`LFR_Relatorio_Semanal_${localISO(report.occurrenceStart)}_a_${localISO(report.occurrenceEnd)}.html`;
  return report;
}
function releaseReportObjectUrl(){
  if(currentReportObjectUrl){
    URL.revokeObjectURL(currentReportObjectUrl);
    currentReportObjectUrl='';
  }
}
function openWeeklyHtmlReportPreview(){
  try{
    const report=prepareWeeklyHtmlReport();
    releaseReportObjectUrl();
    currentReportObjectUrl=URL.createObjectURL(new Blob([currentReportHtml],{type:'text/html;charset=utf-8'}));
    const frame=$('reportPreviewFrame');
    frame.src=currentReportObjectUrl;
    $('reportPreviewPeriod').textContent=`Ocorrências: ${reportDateTime(report.occurrenceStart)} até antes de ${reportDateTime(report.occurrenceEnd)}`;
    $('reportPreviewBackdrop').classList.remove('hidden');
    document.body.classList.add('modal-open');
    showToast('Relatório aberto para visualização.');
  }catch(error){
    console.error('Falha ao abrir relatório HTML:',error);
    showToast(`Não foi possível gerar o relatório: ${friendlyError(error)}`);
  }
}
function closeWeeklyHtmlReportPreview(){
  $('reportPreviewBackdrop').classList.add('hidden');
  document.body.classList.remove('modal-open');
  const frame=$('reportPreviewFrame');
  frame.removeAttribute('src');
  releaseReportObjectUrl();
}
function downloadWeeklyHtmlReport(){
  try{
    if(!currentReportHtml || !currentReportFileName) prepareWeeklyHtmlReport();
    downloadBlob(currentReportHtml,'text/html;charset=utf-8',currentReportFileName);
    showToast('Relatório HTML baixado.');
  }catch(error){
    console.error('Falha ao baixar relatório HTML:',error);
    showToast(`Não foi possível baixar o relatório: ${friendlyError(error)}`);
  }
}
function openWeeklyHtmlReportWindow(){
  try{
    if(!currentReportHtml || !currentReportFileName) prepareWeeklyHtmlReport();
    const reportWindow=window.open('','_blank');
    if(!reportWindow){
      showToast('O navegador bloqueou a nova janela. Libere pop-ups ou use a visualização interna.');
      return;
    }
    reportWindow.document.open();
    reportWindow.document.write(currentReportHtml.replace(/^\ufeff/,''));
    reportWindow.document.close();
    reportWindow.focus();
  }catch(error){
    console.error('Falha ao abrir relatório em nova janela:',error);
    showToast(`Não foi possível abrir a nova janela: ${friendlyError(error)}`);
  }
}
function printWeeklyHtmlReport(){
  const frame=$('reportPreviewFrame');
  try{
    if(!frame?.contentWindow){
      showToast('Abra a pré-visualização do relatório primeiro.');
      return;
    }
    frame.contentWindow.focus();
    frame.contentWindow.print();
  }catch(error){
    console.error('Falha ao imprimir relatório:',error);
    showToast('Não foi possível abrir a impressão. Use “Abrir em nova janela” e imprima por lá.');
  }
}
function generateWeeklyHtmlReport(){
  openWeeklyHtmlReportPreview();
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
  downloadBlob(content,'text/plain;charset=utf-8',`LFR_Relatorio_Semanal_${localISO(occurrenceStart)}_08h_a_${localISO(occurrenceEnd)}_08h.txt`);
  showToast(`Relatório TXT gerado até o corte de ${reportDateTime(occurrenceEnd)}.`);
}

function bindEvents(){
  $('loginForm').addEventListener('submit',login);$('signupBtn').addEventListener('click',signup);$('logoutBtn').addEventListener('click',logout);
  $('kanbanViewBtn').addEventListener('click',()=>setAppView('kanban'));$('calendarViewBtn').addEventListener('click',()=>setAppView('calendar'));$('holidaysViewBtn').addEventListener('click',()=>setAppView('holidays'));
  $('weekModeBtn').addEventListener('click',()=>setMode('week'));$('monthModeBtn').addEventListener('click',()=>setMode('month'));$('prevPeriodBtn').addEventListener('click',()=>shiftPeriod(-1));$('nextPeriodBtn').addEventListener('click',()=>shiftPeriod(1));$('todayBtn').addEventListener('click',async()=>{cursorDate=new Date();if(appView==='kanban'){viewMode='week';selectedDay=localISO(new Date());$('weekModeBtn').classList.add('active');$('monthModeBtn').classList.remove('active');}const range=monthRangeAroundCursor();await ensureRecurringTasksForRange(range.start,range.end);await loadData(false);});
  [$('newTaskBtn'),$('toolbarNewTaskBtn')].forEach(btn=>btn.addEventListener('click',()=>openTaskModal()));[$('teamBtn'),$('managePeopleBtn')].forEach(btn=>btn.addEventListener('click',openTeamModal));
  [$('fixedTaskBtn'),$('toolbarFixedTaskBtn')].forEach(btn=>btn.addEventListener('click',()=>openFixedTaskModal()));
  $('enableNotificationsBtn').addEventListener('click',enableBrowserNotifications);
  $('closeTaskModalBtn').addEventListener('click',closeTaskModal);$('cancelTaskBtn').addEventListener('click',closeTaskModal);$('taskForm').addEventListener('submit',saveTask);$('deleteTaskBtn').addEventListener('click',deleteTask);
  $('taskScheduleType').addEventListener('change',updateTaskScheduleFields);$('taskDueDate').addEventListener('change',updateTaskScheduleFields);$('taskMonth').addEventListener('change',updateTaskScheduleFields);$('taskRepeatUntilDone').addEventListener('change',updateTaskScheduleFields);$('monthlyDaysPicker').addEventListener('change',updateTaskScheduleFields);$('recurrenceStartsOn').addEventListener('change',updateTaskScheduleFields);$('recurrenceEndsOn').addEventListener('change',updateTaskScheduleFields);
  $('manageRecurringBtn').addEventListener('click',openRecurringModal);$('closeRecurringModalBtn').addEventListener('click',closeRecurringModal);$('doneRecurringBtn').addEventListener('click',closeRecurringModal);
  $('closeTeamModalBtn').addEventListener('click',closeTeamModal);$('doneTeamBtn').addEventListener('click',closeTeamModal);$('addPersonBtn').addEventListener('click',addPerson);$('newPersonName').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();addPerson();}});
  $('searchInput').addEventListener('input',()=>{renderBoard();renderMetrics();});$('priorityFilter').addEventListener('change',()=>{renderBoard();renderMetrics();});$('categoryFilter').addEventListener('change',()=>{renderBoard();renderMetrics();});$('clearFiltersBtn').addEventListener('click',resetFilters);
  $('exportBtn').addEventListener('click',exportData);$('importBtn').addEventListener('click',()=>$('importFile').click());$('importFile').addEventListener('change',event=>importBackup(event.target.files?.[0]));
  $('exportSheetBtn').addEventListener('click',exportSpreadsheet);$('importSheetBtn').addEventListener('click',()=>$('importSheetFile').click());$('importSheetFile').addEventListener('change',event=>importSpreadsheet(event.target.files?.[0])); const weeklyHtmlBtn=$('weeklyHtmlBtn'); if(weeklyHtmlBtn) weeklyHtmlBtn.addEventListener('click',generateWeeklyHtmlReport); $('weeklyTxtBtn').addEventListener('click',generateWeeklyTextReport); $('closeReportPreviewBtn').addEventListener('click',closeWeeklyHtmlReportPreview); $('closeReportPreviewFooterBtn').addEventListener('click',closeWeeklyHtmlReportPreview); $('downloadReportHtmlBtn').addEventListener('click',downloadWeeklyHtmlReport); $('openReportWindowBtn').addEventListener('click',openWeeklyHtmlReportWindow); $('printReportBtn').addEventListener('click',printWeeklyHtmlReport);
  $('newEventBtn').addEventListener('click',()=>openEventModal());$('closeEventModalBtn').addEventListener('click',closeEventModal);$('cancelEventBtn').addEventListener('click',closeEventModal);$('eventForm').addEventListener('submit',saveEvent);$('deleteEventBtn').addEventListener('click',deleteEvent);
  $('mobileSidebarBtn').addEventListener('click',()=>$('sidebar').classList.toggle('open'));
  $('closePastGuardBtn').addEventListener('click',()=>closePastGuard(false));$('cancelPastGuardBtn').addEventListener('click',()=>closePastGuard(false));$('confirmPastGuardBtn').addEventListener('click',confirmPastGuard);$('pastGuardInput').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();confirmPastGuard();}});
  $('taskModalBackdrop').addEventListener('click',event=>{if(event.target===$('taskModalBackdrop'))closeTaskModal();});$('teamModalBackdrop').addEventListener('click',event=>{if(event.target===$('teamModalBackdrop'))closeTeamModal();});$('eventModalBackdrop').addEventListener('click',event=>{if(event.target===$('eventModalBackdrop'))closeEventModal();});$('recurringModalBackdrop').addEventListener('click',event=>{if(event.target===$('recurringModalBackdrop'))closeRecurringModal();});$('pastGuardBackdrop').addEventListener('click',event=>{if(event.target===$('pastGuardBackdrop'))closePastGuard(false);});$('reportPreviewBackdrop').addEventListener('click',event=>{if(event.target===$('reportPreviewBackdrop'))closeWeeklyHtmlReportPreview();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'){if(!$('reportPreviewBackdrop').classList.contains('hidden'))closeWeeklyHtmlReportPreview();else if(!$('pastGuardBackdrop').classList.contains('hidden'))closePastGuard(false);else{if(!$('taskModalBackdrop').classList.contains('hidden'))closeTaskModal();if(!$('teamModalBackdrop').classList.contains('hidden'))closeTeamModal();if(!$('eventModalBackdrop').classList.contains('hidden'))closeEventModal();if(!$('recurringModalBackdrop').classList.contains('hidden'))closeRecurringModal();$('sidebar').classList.remove('open');}}});
  $('themeBtn').addEventListener('click',()=>{document.body.classList.toggle('dark');localStorage.setItem(THEME_KEY,document.body.classList.contains('dark')?'dark':'light');});
  document.querySelectorAll('.column').forEach(column=>{
    column.addEventListener('dragover',event=>{event.preventDefault();event.dataTransfer.dropEffect='move';column.classList.add('drag-over');});column.addEventListener('dragleave',()=>column.classList.remove('drag-over'));
    column.addEventListener('drop',event=>{event.preventDefault();column.classList.remove('drag-over');const taskId=event.dataTransfer.getData('text/plain')||draggedTaskId;moveTask(taskId,column.dataset.status);});
  });
}

initialize().catch(error=>{console.error(error);setAuthMessage(friendlyError(error),true);});
