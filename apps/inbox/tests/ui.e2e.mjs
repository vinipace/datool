import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const screenshots = fileURLToPath(new URL('../../../artifacts/inbox-mobile/', import.meta.url));
await mkdir(screenshots, { recursive: true });
import assert from 'node:assert/strict';
const browser = await chromium.launch({headless:true});
const context = await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1});
await context.addInitScript(() => {
 Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>localStorage.getItem('fixture-offline')!=='true'});
 window.fixtureNetwork = online => { localStorage.setItem('fixture-offline',String(!online));window.dispatchEvent(new Event(online?'online':'offline')); };
});
const page=await context.newPage();page.setDefaultTimeout(15000);
const errors=[]; page.on('pageerror',e=>errors.push(e.message));
let owner='team:support',version=1,apiOffline=false;const keys=[];let failFirst=true;
let profileName='Taylor',failProfile=true,failContact=true;
let projectMode='ready',releaseProjects;const projectLoading=new Promise(resolve=>{releaseProjects=resolve});
let firstInbox=true,releaseInbox;const inboxLoading=new Promise(resolve=>{releaseInbox=resolve});
const ticket={id:'ticket_demo',projectId:'project_demo',conversationId:'conversation_demo',contactId:'contact_demo',subject:'Help changing my delivery address',contactName:'Alex Morgan',channel:'whatsapp',status:'open',priority:'high',assigneeUserId:null,assigneeName:null,teamName:'Customer care',updatedAt:new Date().toISOString(),version:1};
const moreTickets = [
 ['Mariana Costa','Can I exchange this for a smaller size?','Customer care'],
 ['Lucas Ribeiro','Thanks! I’ll check the tracking link.','Delivery team'],
 ['Ana Martins','My discount code is not working','Customer care'],
 ['Bruno Oliveira','Question about my monthly subscription','Billing'],
 ['Sofia Chen','When will this be back in stock?','Customer care'],
].map(([contactName,subject,teamName],i)=>({...ticket,id:'ticket_'+i,contactId:'contact_'+i,conversationId:'conversation_'+i,contactName,subject,teamName,channel:['web','telegram','whatsapp','web','telegram'][i],priority:'normal',updatedAt:new Date(Date.now()-(i+1)*900000).toISOString()}));
const messages=[{id:'message_1',ordinal:1,role:'user',content:'Hi! I entered the wrong address. Can you help me change it before my order ships?',createdAt:new Date().toISOString(),metadata:{},author:null},{id:'message_2',ordinal:2,role:'assistant',content:'I’ll connect you with our team so they can check the shipping status and help update your address.',createdAt:new Date().toISOString(),metadata:{},author:{name:'Support agent'}}];
const handleApi=async route=>{
 if(apiOffline)return route.abort('internetdisconnected');
 const req=route.request(),url=new URL(req.url()); let input={};try{input=req.postDataJSON()??{}}catch{}
 const response=(data,status=200)=>route.fulfill({status,contentType:'application/json',headers:{'access-control-allow-origin':'http://localhost:19069','access-control-allow-credentials':'true','access-control-allow-headers':'content-type,x-project-id,idempotency-key','access-control-allow-methods':'GET,POST,DELETE,OPTIONS'},body:JSON.stringify(data)});
 if(req.method()==='OPTIONS')return response({});
 if(url.pathname==='/api/inbox-mobile/diagnostics')return response({data:{id:input.id,status:'saved'}});
 if(url.pathname==='/api/auth/get-session')return response({session:{id:'session_demo',userId:'user_demo',token:'secret-fixture-token',expiresAt:'2030-01-01T00:00:00Z'},user:{id:'user_demo',name:profileName,email:'taylor@example.test',emailVerified:true}});
 if(url.pathname==='/api/auth/update-user'){
  if(failProfile){failProfile=false;return response({message:'Couldn’t save your name. Try again.',code:'UPDATE_FAILED'},503)}
  profileName=input.name;return response({status:true});
 }
 if(url.pathname==='/api/inbox-mobile/devices')return response({data:[]});
 if(url.pathname==='/api/inbox-mobile/projects'){
  if(projectMode==='pending')await projectLoading;
  if(projectMode==='error')return response({error:{message:'Project list temporarily unavailable.'}},503);
  return response({data:{items:projectMode==='empty'?[]:[{id:'project_demo',name:'Customer support',organizationName:'Demo workspace'},{id:'project_sales',name:'Sales',organizationName:'Demo workspace'},{id:'project_europe',name:'European customer success and after-sales support',organizationName:'Europe'}],nextCursor:null}});
 }
 const op=url.pathname.split('/').at(-1);let data;
 // The production API accepts an omitted cursor, but rejects JSON null.
 // Cache hydration must preserve that contract on both paginated reads.
 const cursorField=op==='build_list_tickets'?'cursor':op==='build_list_conversation_messages'?'before':null;
 if(cursorField&&input[cursorField]===null)return response({error:{message:`${cursorField}: Invalid input: expected string, received null`}},400);
 if(op==='build_list_tickets'&&input.search==='error')return response({error:{message:'Inbox connection interrupted. Please retry.'}},503);
 if(op==='build_list_agents')data=[{id:'agent_demo',name:'Support agent'}];
 else if(op==='build_list_tickets'){if(firstInbox){firstInbox=false;await inboxLoading}data={items:input.search==='missing'||req.headers()['x-project-id']!=='project_demo'?[]:[ticket,...moreTickets],nextCursor:null}}
 else if(op==='build_get_ticket')data=ticket;
 else if(op==='build_get_contact'){
  if(failContact)return response({error:{message:'Contact service temporarily unavailable.'}},503);
  data={id:'contact_demo',displayName:'Alex Morgan',email:'alex@example.test',phone:'+1 (202) 555-0142'};
 }
 else if(op==='build_get_conversation_ownership')data={mode:'human',ownerUserId:owner,leaseExpiresAt:null,leaseToken:'lease_demo',version};
 else if(op==='build_list_conversation_messages')data={items:messages,nextCursor:null};
 else if(op==='build_takeover_conversation'){owner='user_demo';version++;data={mode:'human',ownerUserId:owner,version}};
 if(op==='build_send_human_reply'){
  keys.push({key:req.headers()['idempotency-key'],text:input.text});
  if(owner!=='user_demo')return response({error:{message:'Conversation is not owned by this agent.',details:{reason:'OWNERSHIP_CHANGED'}}},409);
  if(failFirst){failFirst=false;return response({error:{message:'Connection interrupted. Your reply is saved.'}},503)}
  messages.push({id:'message_'+input.clientMessageId,ordinal:messages.length+1,role:'assistant',content:input.text,createdAt:new Date().toISOString(),metadata:{source:'human',actorId:'user_demo',clientMessageId:input.clientMessageId},author:{name:'Taylor'}});data={messageId:'message_'+input.clientMessageId};
 }
 if(op==='build_update_ticket'){ticket.status=input.status;ticket.version++;data=ticket}
 if(data!==undefined)return response({data});return response({error:{message:'Unhandled fixture request '+url.pathname}},404);
};
await page.route('http://localhost:3000/**',handleApi);
async function network(online){apiOffline=!online;await page.evaluate(value=>window.fixtureNetwork(value),online)}
async function queue(text){await page.getByRole('textbox',{name:'Reply to customer'}).fill(text);await page.getByRole('button',{name:'Queue reply',exact:true}).click();await page.waitForFunction(()=>document.querySelector('textarea')?.value==='');}
async function shot(name){await page.screenshot({path:screenshots+name+'.png'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
try{
 await page.goto('http://localhost:19069');
 await page.getByRole('button',{name:'Open Customer support',exact:true}).click({timeout:30000});
 await page.getByLabel('Loading',{exact:true}).waitFor();await shot('inbox-loading');releaseInbox();
 await page.getByRole('button',{name:'Open conversation with Alex Morgan'}).waitFor();await shot('inbox-phone');
 await page.waitForFunction(()=>JSON.parse(localStorage.getItem('datool-inbox-cache:http://localhost:3000')||'null')?.clientState.queries.some(q=>q.queryKey[0]==='inbox'&&q.state.data.pages[0]?.items.some(t=>t.id==='ticket_demo')));
 const originalSubject=ticket.subject;ticket.subject='The delivery address has now been updated.';
 await page.reload();await page.getByText(ticket.subject,{exact:true}).waitFor();
 assert.equal(await page.getByText('Couldn’t refresh. Showing your saved conversations.',{exact:true}).count(),0);
 ticket.subject=originalSubject;
 await page.getByRole('button',{name:'Mine',exact:true}).click();
 await page.getByRole('button',{name:'Filter by agent',exact:true}).click();await page.getByRole('button',{name:'Support agent',exact:true}).click();
 await page.getByRole('button',{name:'Choose project: Customer support',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'Switch to Customer support',exact:true}).getAttribute('aria-selected'),'true');await page.getByRole('button',{name:'Switch to Customer support',exact:true}).click({trial:true});await shot('project-selector-phone');
 await page.getByRole('button',{name:'Switch to Customer support',exact:true}).click();
 await page.getByRole('button',{name:'Close project selector',exact:true}).waitFor({state:'hidden'});
 assert.equal(await page.getByRole('button',{name:'Mine',exact:true}).getAttribute('aria-selected'),'true');await page.getByRole('button',{name:'Support agent · Clear filter',exact:true}).waitFor();
 await page.getByRole('button',{name:'Choose project: Customer support',exact:true}).click();await page.getByRole('button',{name:'Switch to Sales',exact:true}).click();
 await page.getByRole('button',{name:'Choose project: Sales',exact:true}).waitFor();await page.getByText('You’re all caught up',{exact:true}).waitFor();
 assert.match(page.url(),/\/inbox\/project_sales/);assert.equal(await page.getByRole('button',{name:'Open',exact:true}).getAttribute('aria-selected'),'true');assert.equal(await page.getByRole('button',{name:'Support agent · Clear filter',exact:true}).count(),0);
 await page.getByRole('button',{name:'Choose project: Sales',exact:true}).click();await page.getByRole('button',{name:'Switch to European customer success and after-sales support',exact:true}).click();
 await page.getByRole('button',{name:'Choose project: European customer success and after-sales support',exact:true}).waitFor();
 await page.getByRole('button',{name:'Close project selector',exact:true}).waitFor({state:'hidden'});
 await page.setViewportSize({width:320,height:700});await shot('project-title-small-phone');
 await page.getByRole('button',{name:'Choose project: European customer success and after-sales support',exact:true}).click();await page.getByRole('button',{name:'Switch to Customer support',exact:true}).click({trial:true});await shot('project-selector-small-phone');
 await page.getByRole('button',{name:'Close project selector',exact:true}).click();await page.getByRole('button',{name:'Close project selector',exact:true}).waitFor({state:'hidden'});
 await network(false);await page.getByRole('button',{name:'Choose project: European customer success and after-sales support',exact:true}).click();await page.getByText('Offline · Showing saved projects',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Switch to Customer support',exact:true}).click();await page.getByRole('button',{name:'Open conversation with Alex Morgan'}).waitFor();
 await network(true);await page.setViewportSize({width:390,height:844});
 await page.getByRole('button',{name:'Mine',exact:true}).click();await page.getByRole('tab',{name:'Outbox',exact:true}).click();await page.getByText('Nothing waiting to send').waitFor();await shot('outbox-empty-phone');
 await page.getByRole('tab',{name:'You',exact:true}).click();await page.getByText('Taylor',{exact:true}).waitFor();await shot('account-phone');
 await page.getByRole('button',{name:'Search settings',exact:true}).click();await page.getByRole('textbox',{name:'Search settings',exact:true}).fill('privacy');
 await page.getByRole('button',{name:'Privacy & offline access',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Notifications',exact:true}).count(),0);
 await page.getByRole('textbox',{name:'Search settings',exact:true}).fill('missing');await page.getByText('No settings found').waitFor();await shot('settings-empty-phone');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.getByRole('button',{name:'Notifications',exact:true}).waitFor();
 await page.getByRole('button',{name:'Edit profile',exact:true}).click();await page.getByRole('textbox',{name:'Your name',exact:true}).fill('Taylor Rivera');await page.getByRole('button',{name:'Save changes',exact:true}).click();
 await page.getByText('Couldn’t save your name. Try again.',{exact:true}).waitFor();assert.equal(await page.getByRole('textbox',{name:'Your name',exact:true}).inputValue(),'Taylor Rivera');await shot('profile-error-phone');
 await page.getByRole('button',{name:'Save changes',exact:true}).click();await page.getByRole('textbox',{name:'Your name',exact:true}).waitFor({state:'hidden'});await page.getByText('Taylor Rivera',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Edit profile',exact:true}).click();await page.getByRole('textbox',{name:'Your name',exact:true}).fill('Discard this edit');await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.getByText('Taylor Rivera',{exact:true}).waitFor();assert.equal(profileName,'Taylor Rivera');
 await page.getByRole('tab',{name:'Chats',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Mine',exact:true}).getAttribute('aria-selected'),'true');await page.getByRole('button',{name:'Open',exact:true}).click();
 await page.getByRole('button',{name:'Filter by agent',exact:true}).click();await page.getByRole('button',{name:'Support agent',exact:true}).click();await page.getByRole('button',{name:'Support agent · Clear filter',exact:true}).click();
 await page.getByRole('textbox',{name:'Search conversations'}).focus();await shot('inbox-focus');
 await page.getByRole('textbox',{name:'Search conversations'}).fill('missing');await page.getByText('No conversations found').waitFor();await shot('inbox-empty');
 await page.getByRole('textbox',{name:'Search conversations'}).fill('error');await page.getByRole('button',{name:'Search',exact:true}).click();await page.getByText('Couldn’t load conversations',{exact:true}).waitFor();await shot('inbox-error');
 await page.getByRole('textbox',{name:'Search conversations'}).fill('');await page.getByRole('button',{name:'Open conversation with Alex Morgan'}).click();
 await page.getByRole('textbox',{name:'Reply to customer'}).fill('Keep this draft while checking contact details.');
 await page.getByRole('button',{name:'Details for Alex Morgan',exact:true}).click();
 await page.getByRole('button',{name:'Retry contact details',exact:true}).waitFor();await shot('contact-error-phone');
 failContact=false;await page.getByRole('button',{name:'Retry contact details',exact:true}).click();await page.getByText('alex@example.test',{exact:true}).waitFor();await shot('contact-phone');
 await page.waitForFunction(()=>JSON.parse(localStorage.getItem('datool-inbox-cache:http://localhost:3000')||'null')?.clientState.queries.some(q=>q.queryKey[0]==='contact'&&q.state.data.email==='alex@example.test'));
 await network(false);await page.reload();await page.getByText('alex@example.test',{exact:true}).waitFor();await page.getByText('Offline · Showing saved details',{exact:true}).waitFor();await shot('contact-offline-phone');
 await page.setViewportSize({width:320,height:700});await shot('contact-small-phone');await page.setViewportSize({width:390,height:844});
 await page.getByRole('button',{name:'Message',exact:true}).click();
 // The composer stays empty until its durable outbox has hydrated after reload.
 await page.waitForFunction(()=>document.querySelector('[aria-label="Reply to customer"]')?.value==='Keep this draft while checking contact details.');
 assert.equal(await page.getByRole('textbox',{name:'Reply to customer'}).inputValue(),'Keep this draft while checking contact details.');
 await network(true);await page.getByRole('button',{name:'Details for Alex Morgan',exact:true}).click();await page.getByRole('button',{name:'Manage',exact:true}).click();
 await page.getByRole('button',{name:'Mark solved',exact:true}).waitFor();await page.getByRole('button',{name:'Done',exact:true}).click();await page.getByRole('button',{name:'Done',exact:true}).waitFor({state:'hidden'});
 await page.getByRole('textbox',{name:'Reply to customer'}).fill('');
 await page.getByRole('button',{name:'Join conversation',exact:true}).click();await page.getByText('You’re replying',{exact:true}).waitFor();
 await network(false);await queue('I can help with the delivery address.');await queue('Please send your updated address.');
 assert.equal(keys.length,0);await page.getByRole('button',{name:'Outbox · 2 replies',exact:true}).waitFor();await shot('offline-queued-phone');
 await page.waitForFunction(()=>{ const cache=JSON.parse(localStorage.getItem('datool-inbox-cache:http://localhost:3000')||'null');return cache?.clientState.queries.some(q=>q.queryKey[0]==='messages'&&q.state.data.pages.some(p=>p.items.some(m=>m.id==='message_1')))&&cache.clientState.queries.some(q=>q.queryKey[0]==='ownership'&&q.state.data.ownerUserId==='user_demo'); },undefined,{timeout:10000});
 // Model a process exit after the durable queue write but before the throttled
 // cache snapshot records the cleared composer.
 await page.addInitScript(()=>{
  if(localStorage.getItem('fixture-restored-stale-draft'))return;
  const key='datool-inbox-cache:http://localhost:3000',cache=JSON.parse(localStorage.getItem(key));
  const reply=JSON.parse(localStorage.getItem('datool-inbox-outbox:http://localhost:3000')).items[0];
  cache.clientState.queries.find(q=>q.queryKey[0]==='draft').state.data={text:reply.text,key:reply.id};
  localStorage.setItem(key,JSON.stringify(cache));localStorage.setItem('fixture-restored-stale-draft','true');
 });
 await page.reload();await page.getByRole('button',{name:'Queue reply',exact:true}).waitFor({timeout:30000});
 await page.getByText('I can help with the delivery address.',{exact:true}).waitFor();await page.getByText('Hi! I entered the wrong address. Can you help me change it before my order ships?',{exact:true}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'Reply to customer'}).inputValue(),'');
 assert.equal(keys.length,0);assert.equal(await page.evaluate(()=>localStorage.getItem('datool-inbox-cache:http://localhost:3000').includes('secret-fixture-token')),false);
 messages.push({id:'message_while_offline',ordinal:messages.length+1,role:'user',content:'Here is the new address, sent while you were offline.',createdAt:new Date().toISOString(),metadata:{},author:null});
 await network(true);await page.getByText('Connection interrupted. Your reply is saved.',{exact:true}).waitFor();await shot('offline-retry-phone');
 await page.getByText('Here is the new address, sent while you were offline.',{exact:true}).waitFor();
 await page.getByRole('button',{name:/^Outbox ·/}).waitFor({state:'hidden',timeout:20000});await shot('conversation-phone');
 assert.deepEqual(keys.map(k=>k.text),['I can help with the delivery address.','I can help with the delivery address.','Please send your updated address.']);assert.equal(keys[0].key,keys[1].key);assert.notEqual(keys[1].key,keys[2].key);
 await network(false);await queue('One more detail to confirm.');owner='other-user';version++;
 await network(true);await page.getByText('Needs attention · Open Outbox',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Outbox · 1 reply',exact:true}).click();await page.getByText('Needs attention',{exact:true}).waitFor();await shot('outbox-conflict-phone');
 await page.getByRole('button',{name:'Remove saved reply',exact:true}).click();await page.getByRole('button',{name:'Keep reply',exact:true}).click();await page.getByRole('button',{name:'Keep reply',exact:true}).waitFor({state:'hidden'});await page.getByText('One more detail to confirm.',{exact:true}).filter({visible:true}).waitFor();
 owner='user_demo';version++;await page.getByRole('button',{name:'Retry',exact:true}).click();await page.getByText('Nothing waiting to send').waitFor();assert.equal(keys.at(-1).key,keys.at(-2).key);
 await page.goto('http://localhost:19069/ticket/project_demo/ticket_demo');await page.getByRole('textbox',{name:'Reply to customer'}).waitFor();await network(false);await queue('Remove this unsent reply.');
 await page.getByRole('button',{name:'Outbox · 1 reply',exact:true}).click();await page.getByRole('button',{name:'Remove saved reply',exact:true}).click();await page.getByRole('button',{name:'Remove reply',exact:true}).click({trial:true});await shot('outbox-remove-phone');await page.getByRole('button',{name:'Remove reply',exact:true}).click();await page.getByText('Nothing waiting to send').waitFor();await network(true);
 await page.goto('http://localhost:19069/ticket/project_demo/ticket_demo');await page.getByRole('button',{name:'Conversation actions',exact:true}).click();await page.getByRole('button',{name:'Mark solved',exact:true}).click({trial:true});await shot('conversation-actions');await page.getByRole('button',{name:'Mark solved',exact:true}).click();await page.getByRole('button',{name:'Done',exact:true}).waitFor({state:'hidden'});await page.getByRole('button',{name:'Reopen ticket',exact:true}).waitFor();await shot('conversation-solved-phone');
 await page.setViewportSize({width:768,height:1024});await shot('conversation-tablet');
 await page.setViewportSize({width:320,height:700});await page.getByRole('button',{name:'Reopen ticket',exact:true}).click();await page.getByRole('textbox',{name:'Reply to customer'}).fill('A longer draft that wraps onto several lines on a small phone, keeping the send button reachable.');await shot('conversation-small-phone');
 for(const initialMode of ['pending','empty']){
  projectMode=initialMode;
  const pickerContext=await browser.newContext({viewport:{width:390,height:844}}),pickerPage=await pickerContext.newPage();pickerPage.setDefaultTimeout(15000);
  pickerPage.on('pageerror',e=>errors.push(e.message));await pickerPage.route('http://localhost:3000/**',handleApi);
  await pickerPage.goto('http://localhost:19069/inbox/project_demo?name=Customer%20support');
  await pickerPage.getByRole('button',{name:'Open conversation with Alex Morgan'}).waitFor();await pickerPage.getByRole('button',{name:'Choose project: Customer support',exact:true}).click();
  await pickerPage.getByRole('button',{name:'Close project selector',exact:true}).click({trial:true});
  if(initialMode==='pending'){
   await pickerPage.getByLabel('Loading',{exact:true}).waitFor();await pickerPage.screenshot({path:screenshots+'project-selector-loading.png'});
   projectMode='error';releaseProjects();await pickerPage.getByText('Couldn’t load projects',{exact:true}).waitFor();await pickerPage.getByRole('button',{name:'Try again',exact:true}).click({trial:true});await pickerPage.screenshot({path:screenshots+'project-selector-error.png'});
   projectMode='ready';await pickerPage.getByRole('button',{name:'Try again',exact:true}).click();await pickerPage.getByRole('button',{name:'Switch to Sales',exact:true}).click();await pickerPage.getByRole('button',{name:'Choose project: Sales',exact:true}).waitFor();
  }else{
   await pickerPage.getByText('No projects yet',{exact:true}).waitFor();await pickerPage.screenshot({path:screenshots+'project-selector-empty.png'});
  }
  await pickerContext.close();
 }
 assert(!keys.some(k=>k.text==='Remove this unsent reply.'));assert.deepEqual(errors,[]);console.log('PASS synthetic API UI flow: project drawer loading/error/retry/empty, selection/dismissal, filter reset, cached offline switching and long titles; inbox, search empty, join, offline disk queue, restart cached transcript, no credential persistence, reconnect ordered retries with stable IDs, ownership conflict and recovery, cancel/remove saved reply, solved state, persistent tab state, automatic search, settings search, profile save failure/retry/cancel, contact failure/retry/offline reload and draft-preserving navigation, phone/tablet overflow.');
} catch(error){console.log((await page.locator('body').innerText()).slice(-7000));throw error} finally {console.log('Page errors:',errors);await browser.close()}
