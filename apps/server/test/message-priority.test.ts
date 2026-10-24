import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { CoordinationService } from '../src/coordination/service.js';
import { dispatchCoordination } from '../src/coordination/transport.js';
import { auditPeerWakes } from '../src/coordination/audit.js';
import { continuationControl } from '../src/coordination/continuation.js';
import { messagePolicyKey } from '../src/coordination/inbox-policy.js';

const cleanup: Array<()=>void> = [];
afterEach(()=>{for(const fn of cleanup.splice(0).reverse())fn();vi.useRealTimers();});
function fixture(){
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-23T01:00:00Z'));
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'priority-trial-'));
  const db=new AppDatabase(path.join(root,'db.sqlite')),wake=vi.fn();
  const service=new CoordinationService(db,{enabled:true,pilotPaths:[]},wake);
  const register=()=>{const token=randomUUID();const id=service.register({provider:'codex',nativeSessionId:randomUUID(),token,pid:process.pid,cwd:root}).assignmentId!;return{id,token};};
  const sender=register(),recipient=register();
  const send=(options:object={})=>{const input={id:randomUUID(),recipientId:recipient.id,text:'Message body',...options};return{input,receipt:service.send(sender.id,input)};};
  cleanup.push(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
  return{root,db,wake,service,sender,recipient,send};
}

describe('Cooperative messaging trial',()=>{
  it('defaults awareness to P3 and one hour without an immediate body, state leak or wake',()=>{
    const f=fixture();const {input,receipt}=f.send();
    expect(receipt).toMatchObject({priority:'P3',delivery:'mailbox',expiresAt:'2026-10-23T02:00:00.000Z'});
    expect(f.wake).not.toHaveBeenCalled();
    expect(f.service.poll(f.recipient.id)).toMatchObject({messages:[],pendingMessageCount:0,mailNotice:null});
    vi.advanceTimersByTime(900000);
    const notice=f.service.poll(f.recipient.id);
    expect(notice.mailNotice?.counts).toEqual({mail:1});expect(JSON.stringify(notice)).not.toContain(input.text);
    expect(f.service.poll(f.recipient.id).mailNotice).toBeNull();
    expect(f.service.mail(f.recipient.id).messages[0]?.id).toBe(input.id);
    expect(f.db.sqlite.prepare('select acknowledged_at from coordination_messages where id=?').get(input.id)).toEqual({acknowledged_at:null});
  });
  it('batches P1 and P2 bodies in priority order while P3 waits for explicit retrieval',()=>{
    const f=fixture();const p2=f.send({priority:'P2'}),p3=f.send(),p1=f.send({priority:'P1'});
    expect(f.wake).toHaveBeenCalledTimes(1);
    expect(f.service.poll(f.recipient.id).messages.map(m=>m.id)).toEqual([p1.input.id,p2.input.id]);
    expect(f.service.mail(f.recipient.id).messages.map(m=>m.id)).toEqual([p3.input.id]);
  });
  it('uses the P3 notice clock even when P2 messages arrive repeatedly',()=>{
    const f=fixture();f.send();vi.advanceTimersByTime(900000);expect(f.service.poll(f.recipient.id).mailNotice).not.toBeNull();
    f.send();
    for(let i=0;i<14;i++){vi.advanceTimersByTime(60000);f.send({priority:'P2'});expect(f.service.poll(f.recipient.id).mailNotice).toBeNull();}
    vi.advanceTimersByTime(60000);expect(f.service.poll(f.recipient.id).mailNotice?.counts).toEqual({mail:1});
  });
  it('preserves accepted priority and expiry on retries, including after database reopen',()=>{
    const f=fixture();const {input,receipt}=f.send({priority:'P2',validFor:604800});
    vi.advanceTimersByTime(1000);
    expect(f.service.send(f.sender.id,{...input,priority:'P1',validFor:1})).toMatchObject({priority:'P2',expiresAt:receipt.expiresAt});
    const reopened=new AppDatabase(path.join(f.root,'db.sqlite'));cleanup.push(()=>reopened.close());
    const restored=new CoordinationService(reopened,{enabled:true,pilotPaths:[]});
    expect(restored.send(f.sender.id,input)).toMatchObject({priority:'P2',expiresAt:receipt.expiresAt});
    expect(()=>restored.send(f.sender.id,{...input,text:'Different content'})).toThrow('different content');
  });
  it('purges expired content without acknowledging it or resurrecting it on retry',()=>{
    const f=fixture();const {input}=f.send({priority:'P2',validFor:10});vi.advanceTimersByTime(10000);
    expect(f.service.poll(f.recipient.id).messages).toEqual([]);
    expect(f.db.sqlite.prepare('select * from coordination_messages where id=?').get(input.id)).toBeUndefined();
    expect(f.service.send(f.sender.id,input)).toMatchObject({delivery:'expired',queued:false});
    expect(f.db.meta.get(messagePolicyKey(input.id))).not.toContain(input.text);
    expect(f.service.acknowledge(f.recipient.id,[input.id])).toEqual({ acknowledged: [], expiredUnread: [input.id] });
  });
  it('retains wake accounting after an unacknowledged message body expires',async()=>{
    const f=fixture();const {input}=f.send({priority:'P1',validFor:1});
    f.db.meta.set(`peer-wake-attempt:${input.id}`,JSON.stringify({sessionId:randomUUID(),timestamp:new Date().toISOString(),status:'submitted'}));
    vi.advanceTimersByTime(2000);f.service.poll(f.recipient.id);
    const audit=await auditPeerWakes(f.db.sqlite);
    expect(audit.counts.submittedWakes).toBe(1);
    expect(audit.priorityTrial?.messages).toContainEqual(expect.objectContaining({priority:'P1',accepted:1,expired:1}));
    expect(JSON.stringify(audit)).not.toContain(input.text);
  });
  it('allows acknowledgement of timely offered content after expiry without restoring its body',()=>{
    const f=fixture();const {input}=f.send({priority:'P2',validFor:10});f.service.poll(f.recipient.id);
    vi.advanceTimersByTime(10000);f.service.poll(f.recipient.id);
    expect(f.db.sqlite.prepare('select id from coordination_messages where id=?').get(input.id)).toBeUndefined();
    expect(f.service.acknowledge(f.recipient.id,[input.id])).toEqual({acknowledged:[input.id],expiredUnread:[]});
    expect(f.service.send(f.sender.id,input)).toMatchObject({delivery:'acknowledged',queued:false});
    expect(f.db.sqlite.prepare('select id from coordination_messages where id=?').get(input.id)).toBeUndefined();
  });
  it('reserves critical storage so ignored awareness mail cannot reject a P1',()=>{
    const f=fixture();for(let i=0;i<100;i++)f.send();
    expect(()=>f.send()).toThrow('inbox is full');
    expect(f.send({priority:'P1'}).receipt.priority).toBe('P1');
    expect(f.wake).toHaveBeenCalledTimes(1);
    expect(f.service.poll(f.recipient.id).messages).toHaveLength(1);
  });
  it('expires queued handoff content and never flushes it after inbox capacity becomes available',()=>{
    const f=fixture();for(let i=0;i<100;i++)f.send();
    f.service.update(f.sender.id,{supervisorId:f.recipient.id,task: { deliverable: 'Complete assigned change', doneWhen: 'Reviewed and verified', evidencePath: 'docs/result.md', state: 'blocked', actionNeeded: 'Review this result to unblock the assigned task' },summary:'Obsolete held result',validFor:1});
    vi.advanceTimersByTime(2000);f.service.poll(f.recipient.id);
    const stored=f.db.sqlite.prepare("select value from meta where key like 'supervisor-handoff:%'").all() as Array<{value:string}>;
    expect(stored).toHaveLength(1);expect(stored[0]!.value).not.toContain('Obsolete held result');
    f.service.agentStatus(f.recipient.id);expect(f.service.mail(f.recipient.id).messages.some(m=>m.text.includes('Obsolete held result'))).toBe(false);
  });
  it('does not let unrelated supplied mail cancel an external wait',()=>{
    const f=fixture();f.service.update(f.recipient.id,{continuation:'unattended',awaiting:'Specific job'});
    const before=continuationControl(f.db,f.recipient.id);f.send({priority:'P2'});f.service.poll(f.recipient.id);
    expect(continuationControl(f.db,f.recipient.id)).toEqual(before);
    f.service.update(f.recipient.id,{awaiting:null});expect(continuationControl(f.db,f.recipient.id).awaiting).toBeNull();
  });
  it.each([0,604801,1.5])('rejects invalid validity %s through the authenticated tool surface',async validFor=>{
    const f=fixture();await expect(dispatchCoordination(f.service,{action:'send',assignmentId:f.sender.id,token:f.sender.token,messageId:randomUUID(),recipientId:f.recipient.id,text:'x',validFor})).rejects.toThrow();
  });
  it('rejects the retired urgent field with actionable migration guidance',async()=>{
    const f=fixture();await expect(dispatchCoordination(f.service,{action:'send',assignmentId:f.sender.id,token:f.sender.token,messageId:randomUUID(),recipientId:f.recipient.id,text:'x',urgent:true})).rejects.toThrow('Choose priority');
  });
  it('publishes one broadcast with no direct copies or wakes and sends opted-in category notices',()=>{
    const f=fixture();f.service.board.subscribe(f.recipient.id,['releases'],null);
    f.service.board.publish(f.sender.id,{id:randomUUID(),text:'Release ready',category:'releases',repository:null});
    f.service.board.publish(f.sender.id,{id:randomUUID(),text:'Capacity available',category:'resources',repository:null});
    expect(f.wake).not.toHaveBeenCalled();expect(f.service.snapshot().messages).toEqual([]);
    expect(f.service.poll(f.recipient.id).mailNotice).toBeNull();vi.advanceTimersByTime(900000);
    expect(f.service.poll(f.recipient.id).mailNotice?.counts).toEqual({releases:1});
    expect(f.service.poll(f.sender.id).mailNotice).toBeNull();
    expect(f.service.board.list({category:'releases'}).posts.map(p=>p.text)).toEqual(['Release ready']);
    expect(f.service.poll(f.recipient.id).mailNotice).toBeNull();
  });
  it('expires broadcast bodies and preserves idempotent expired publication receipts',()=>{
    const f=fixture();const post={id:randomUUID(),text:'Outdated release',category:'releases' as const,repository:null,validFor:1};
    f.service.board.publish(f.sender.id,post);vi.advanceTimersByTime(1000);
    expect(f.service.board.list().posts).toEqual([]);
    expect(f.service.board.publish(f.sender.id,post)).toMatchObject({expired:true});
    expect((f.db.sqlite.prepare('select value from meta where key=?').get('coordination-broadcast:'+post.id) as {value:string}).value).not.toContain(post.text);
  });
  it('filters repository subscriptions while preserving globally scoped posts',()=>{
    const f=fixture();f.service.board.subscribe(f.recipient.id,['contracts'],'repoA');
    for(const repository of ['repoA','repoB',null])f.service.board.publish(f.sender.id,{id:randomUUID(),text:'Contract changed',category:'contracts',repository});
    vi.advanceTimersByTime(900000);expect(f.service.poll(f.recipient.id).mailNotice?.counts).toEqual({contracts:2});
  });
});
