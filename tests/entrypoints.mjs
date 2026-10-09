import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import http from 'node:http'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {MailStore,MailService,buildSpecs,makeRoutes} from '../lib/index.js'
import {startFakeImap} from './fakes.mjs'
const exec=promisify(execFile)
const root=await fs.mkdtemp(path.join(tmpdir(),'qqmail-entrypoints-'))
let passed=0,failed=0
const setup=async(name)=>{
 process.env.DSH_QQMAIL_CONFIG=path.join(root,name+'.json')
 const store=new MailStore()
 for(const id of ['alpha','beta']) await store.patch({account:'__new__',id,email:id+'@example.test',authCode:'synthetic-'+id,signature:'SIGN_'+id})
 return store
}
const test=async(name,fn)=>{try{await fn();passed++;console.log('  ✔ '+name)}catch(e){failed++;console.error('  ✘ '+name+' — '+e.message)}}
try{
 await test('GET config query cannot reset/change mailbox; numeric account stays string',async()=>{
  const store=await setup('route');await store.patch({account:'__new__',id:'123',email:'numeric@example.test',authCode:'synthetic-numeric'})
  const service=new MailService(store),routes=makeRoutes({store,service,workspaceDir:root})
  const server=http.createServer((req,res)=>{
   const route=routes.find(x=>x.path===new URL(req.url,'http://localhost').pathname)
   if(!route){res.writeHead(404);res.end();return}
   route.handler(req,res).catch(()=>{res.writeHead(500);res.end()})
  })
  await new Promise(r=>server.listen(0,'127.0.0.1',r))
  try{
   const before=await fs.readFile(store.file)
   const base='http://127.0.0.1:'+server.address().port
   const r=await(await fetch(base+'/api/dsh-qqmail/config?reset=true&email=wrong@example.test&account=123')).json()
   assert.equal(r.ok,true);assert.equal(r.data.email,'numeric@example.test')
   assert.deepEqual(await fs.readFile(store.file),before)
   const rows=await(await fetch(base+'/api/dsh-qqmail/accounts')).json();assert.equal(rows.data.accounts.length,3)
  }finally{await service.dispose();await new Promise(r=>server.close(r))}
 })
 await test('config defaultAccount result identity matches actual returned view',async()=>{
  const store=await setup('default'),service=new MailService(store)
  try{
   const spec=buildSpecs(false).find(x=>x.name==='qqmail_config')
   const r=await spec.handler({defaultAccount:'beta'},{store,service,workspaceDir:root})
   assert.equal(r.ok,true);assert.equal(r.data.email,'beta@example.test');assert.equal(r.data.account.email,r.data.email);assert.equal(r.data.account.id,'beta')
  }finally{await service.dispose()}
 })
 await test('attachment directory cannot use reserved dot path ids',async()=>{
  const store=await setup('path')
  for(const id of ['.','..']) await assert.rejects(store.patch({account:'__new__',id,email:id+'@example.test',authCode:'synthetic-dot'}),/id/)
 })
 for(const change of ['credential','default']) await test('reply '+change+' change while reading is handled safely',async()=>{
  const store=await setup('reply-'+change)
  let sent=false
  const service={
   readMessages:async()=>{
    await store.patch(change==='credential'?{account:'alpha',authCode:'new-synthetic-code'}:{defaultAccount:'beta'})
    return {items:[{subject:'original',text:'old body',from:[{name:'sender',address:'sender@example.test'}],replyTo:[],to:[],references:[],messageId:'<fixture@example.test>',date:''}],errors:[]}
   },
   send:async(_input,ref)=>{assert.equal(ref,'alpha');sent=true;return{response:'OK',messageId:'<sent@example.test>',savedTo:'',saveError:'',accepted:[],rejected:[]}}
  }
  const spec=buildSpecs(false).find(x=>x.name==='qqmail_reply')
  const r=await spec.handler({uid:100,text:'reply'},{store,service,workspaceDir:root})
  assert.equal(r.ok,change==='default');assert.equal(sent,change==='default')
  if(change==='credential') assert.match(r.message,/配置已变更/)
 })
 await test('CLI explicit false persists read-only and refuses destructive confirmation',async()=>{
  const store=await setup('cli-booleans')
  const imap=await startFakeImap({user:'alpha@example.test',password:'synthetic-alpha',messages:{INBOX:[{uid:100,raw:'From: fixture@example.test\r\nSubject: fixture\r\n\r\nbody\r\n'}]}})
  const env={...process.env,DSH_QQMAIL_CONFIG:store.file,QQMAIL_AUTH_CODE:''}
  const run=(args)=>exec(process.execPath,['lib/cli.js',...args,'--json'],{env})
  try{
   await store.patch({account:'alpha',preset:'custom',imapHost:'127.0.0.1',imapPort:imap.port,imapSecure:false,smtpHost:'127.0.0.1'})
   await run(['config','--read-only','false']);store.invalidate();assert.equal(store.readOnlySync().value,false)
   const before=await fs.readFile(store.file)
   await assert.rejects(run(['accounts','remove','--account','alpha','--confirm','false']),e=>/confirm|确认/.test(e.stdout))
   assert.deepEqual(await fs.readFile(store.file),before)
   const result=JSON.parse((await run(['delete','100','--permanent','false'])).stdout)
   assert.equal(result.ok,true);assert.equal(result.data.mode,'trash')
   assert.deepEqual(imap.copies,[{from:'INBOX',to:'Deleted Messages',uids:[100]}])
  }finally{await imap.close()}
 })
 await test('CLI config/management add and account selection use separate accounts',async()=>{
  const store=await setup('cli')
  const env={...process.env,DSH_QQMAIL_CONFIG:store.file,QQMAIL_AUTH_CODE:'synthetic-gamma'}
  await exec(process.execPath,['lib/cli.js','accounts','add','--id','gamma','--email','gamma@example.test','--json'],{env})
  const selected=await exec(process.execPath,['lib/cli.js','config','--account','gamma','--json'],{env:{...env,QQMAIL_AUTH_CODE:''}})
  assert.equal(JSON.parse(selected.stdout).data.account.id,'gamma')
  store.invalidate();assert.equal(store.readSync().accounts.length,3)
 })
}finally{await fs.rm(root,{recursive:true,force:true})}
console.log('入口回归：'+passed+' 通过，'+failed+' 失败')
if(failed)process.exitCode=1
