/** Synthetic credentials and local sockets only. Never sends external mail. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {MailStore,MailService,normalizeQuery,buildSpecs} from '../lib/index.js'
import {startFakeImap,startFakeSmtp} from './fakes.mjs'
const exec=promisify(execFile),root=await fs.mkdtemp('/tmp/qqmail-regressions-')
let passed=0,failed=0
const test=async(name,run)=>{try{await run();passed++;console.log('  ✔ '+name)}catch(e){failed++;console.error('  ✘ '+name+' — '+e.message)}}
try{
 await test('TEXT-ignoring server cannot turn a nonexistent CLI keyword into all mail',async()=>{
  process.env.DSH_QQMAIL_CONFIG=path.join(root,'search.json')
  const store=new MailStore(),imap=await startFakeImap({ignoreTextSearch:true,user:'fixture@example.test',password:'synthetic',messages:{INBOX:[{uid:100,raw:'From: sender@example.test\r\nSubject: UNIQUE_MATCH\r\n\r\nbody'}]}})
  const service=new MailService(store)
  try{
   await store.patch({email:'fixture@example.test',authCode:'synthetic',preset:'custom',imapHost:'127.0.0.1',imapPort:imap.port,imapSecure:false,smtpHost:'localhost'})
   const run=async(text)=>JSON.parse((await exec(process.execPath,['lib/cli.js','search','--text',text,'--json'],{env:{...process.env,QQMAIL_AUTH_CODE:''}})).stdout)
   const absent=await run('ZZZNONEXIST999');assert.equal(absent.data.total,0)
   const match=await run('UNIQUE_MATCH');assert.equal(match.data.total,1);assert.equal(match.data.items[0].uid,100)
   assert.ok(imap.commands.some(x=>x.includes('OR')&&x.includes('ZZZNONEXIST999')))
  }finally{await service.dispose();await imap.close()}
 })
 await test('enterprise server ignoring all keywords uses bounded local filtering',async()=>{
  process.env.DSH_QQMAIL_CONFIG=path.join(root,'enterprise.json')
  const imap=await startFakeImap({ignoreSearchFilters:true,user:'fixture@example.test',password:'synthetic',messages:{INBOX:[{uid:100,raw:'From: sender@example.test\r\nSubject: UNIQUE_MATCH\r\n\r\nbody'}]}})
  const store=new MailStore(),service=new MailService(store)
  try{
   await store.patch({email:'fixture@example.test',authCode:'synthetic',preset:'qq-exmail',imapHost:'127.0.0.1',imapPort:imap.port,imapSecure:false})
   for(const keyword of ['text','subject','from','body']){
    const result=await service.searchMessages(normalizeQuery({[keyword]:'ZZZNONEXIST999'}),{limit:20,order:'desc',preview:false})
    assert.equal(result.total,0,keyword);assert.equal(result.mode,'local')
   }
   const result=await service.searchMessages(normalizeQuery({subject:'UNIQUE_MATCH'}),{limit:20,order:'desc',preview:false})
   assert.equal(result.total,1);assert.equal(result.items[0].uid,100)
  }finally{await service.dispose();await imap.close()}
 })
 await test('multiline -- signature survives actual CLI configuration',async()=>{
  process.env.DSH_QQMAIL_CONFIG=path.join(root,'signature.json')
  const signature='--\nFixture signature\nsecond line'
  await exec(process.execPath,['lib/cli.js','config','--email','fixture@example.test','--signature',signature,'--json'],{env:{...process.env,QQMAIL_AUTH_CODE:'synthetic'}})
  assert.equal(JSON.parse(await fs.readFile(process.env.DSH_QQMAIL_CONFIG,'utf8')).accounts[0].signature,signature)
 })
 for(const present of [true,false,'mismatch']) await test('APPEND acknowledgement lost, copy '+(present===true?'exists':'not confirmed')+' without repeating SMTP/APPEND',async()=>{
  process.env.DSH_QQMAIL_CONFIG=path.join(root,'append-'+present+'.json')
  const store=new MailStore(),smtp=await startFakeSmtp(),service=new MailService(store)
  let appends=0,id='',reads=0
  const client={append:async(_folder,raw)=>{appends++;id=/^Message-ID:\s*([^\r\n]+)/im.exec(raw.toString())[1];throw new Error('IMAP timeout after append')},getMailboxLock:async()=>({release(){}}),search:async(q)=>{reads++;assert.equal(q.header['Message-ID'],id);return present?[101]:[]},fetchOne:async()=>({headers:Buffer.from('Message-ID: '+(present==='mismatch'?'<other@example.test>':id)+'\r\n')})}
  service.session=()=>({run:fn=>fn(client)})
  try{
   await store.patch({email:'fixture@example.test',authCode:'synthetic',preset:'custom',imapHost:'localhost',smtpHost:'127.0.0.1',smtpPort:smtp.port,smtpSecure:false,smtpRequireTls:false,sentFolder:'Sent Messages'})
   const result=await buildSpecs(false).find(s=>s.name==='qqmail_send').handler({to:['recipient@example.test'],subject:'fixture',text:'fixture'},{store,service,workspaceDir:root})
   assert.equal(result.ok,true);assert.equal(appends,1);assert.equal(smtp.messages.length,1);assert.equal(reads,1)
   if(present===true){assert.equal(result.data.savedTo,'Sent Messages');assert.equal(result.data.saveError,'')}
   else{assert.match(result.message,/未确认/);assert.match(result.message,/勿重发/);assert.doesNotMatch(result.message,/存副本失败/)}
  }finally{await service.dispose();await smtp.close()}
 })
}finally{await fs.rm(root,{recursive:true,force:true})}
console.log('邮件回归：'+passed+' 通过，'+failed+' 失败')
if(failed)process.exitCode=1
