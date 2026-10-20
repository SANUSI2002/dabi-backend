import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import request from 'supertest';
import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { URL } from 'node:url';
import { PDFDocument,StandardFonts } from 'pdf-lib';
import { prisma,tokenFor } from './fixtures.js';
import { app } from '../../src/app.js';
import { enrollmentSchema,aiAccess } from '../../src/modules/ai/ai.access.js';
import { retrieveKnowledge,validateKnowledgeAnswer,parseKnowledgePdf,knowledgeReferencesAvailable } from '../../src/modules/ai/ai.knowledge.js';
import { createAiSession,queueAiMessage,processAiQueue,getAiSession } from '../../src/modules/ai/ai.service.js';
import { AI_CONSENT_VERSION } from '../../src/modules/ai/ai.config.js';
import { readFile } from 'node:fs/promises';

const metadata={title:'Synthetic hydration handbook',authors:'Sabi QA publisher',edition:'QA edition 1',publicationDate:'2026-01-01',jurisdiction:'Nigeria',language:'English',specialty:'General education',audiences:['PERSONAL','PROFESSIONAL','BUSINESS'],rightsBasis:'Synthetic content created for automated tests; all indexing rights granted.',rightsConfirmed:true,reviewBy:'2030-01-01',sourceType:'BOOK',sourceUrl:null};
const text='Hydration education helps people understand drinking water, recording questions and discussing their needs with a qualified professional. This is synthetic reference content, not a treatment protocol.';
const newUser=()=>prisma.user.create({data:{patientId:`AK-${randomUUID()}`,email:`${randomUUID()}@knowledge.test`,password:'synthetic',accountStatus:'ACTIVE',emailVerifiedAt:new Date()}});
let admin,reviewer,normal,support;
const api=(method,path,body,user=admin)=>request(app)[method](`/api/v1/command-centre/ai${path}`).set('Authorization',tokenFor(user.id)).send(body);
async function source(status='PUBLISHED',audiences=metadata.audiences){const id=randomUUID();return prisma.aiKnowledgeDocument.create({data:{id,familyId:id,status,scanStatus:'CLEAN',metadata:{...metadata,audiences},storageKey:`ai-knowledge/${id}/source.pdf`,sha256:'a'.repeat(64),byteSize:100,uploadedByUserId:admin.id,reviewedByUserId:reviewer.id,passages:{create:{pageNumber:1,pageLabel:'12',text,quality:'APPROVED'}}}});}
const env={SABI_AI_ENABLED:'true',SABI_AI_GOOGLE_PROCESSING_APPROVED:'true',SABI_AI_GOOGLE_API_KEY:'synthetic-not-transmitted',SABI_AI_MODEL:'synthetic-model'};
const saved=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));
beforeAll(()=>Object.assign(process.env,env));
afterAll(()=>{for(const k of Object.keys(env)){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}});
beforeAll(async()=>{admin=await newUser();reviewer=await newUser();normal=await newUser();support=await newUser();for(const u of [admin,reviewer])await prisma.platformRoleAssignment.create({data:{userId:u.id,roleCode:'SABI_PLATFORM_ADMIN'}});await prisma.platformRoleAssignment.create({data:{userId:support.id,roleCode:'SABI_SUPPORT'}});});
describe('standalone AI account boundaries',()=>{
  it('requires professional discipline, regulator, licence number and current expiry',()=>{
    expect(enrollmentSchema.safeParse({kind:'PROFESSIONAL',attestation:true}).success).toBe(false);
    expect(enrollmentSchema.safeParse({kind:'PROFESSIONAL',profession:'NURSE',country:'Nigeria',authority:'MDCN',licenceNumber:'ABC123',expiresAt:'2030-01-01',attestation:true}).success).toBe(false);
    expect(enrollmentSchema.safeParse({kind:'PROFESSIONAL',profession:'NURSE',country:'Nigeria',authority:'NMCN',licenceNumber:'ABC123',expiresAt:'2030-01-01',attestation:true}).success).toBe(true);
  });
  it('requires business registration and never trusts client-supplied approval or feature overrides',()=>{
    expect(enrollmentSchema.safeParse({kind:'BUSINESS',attestation:true}).success).toBe(false);
    expect(enrollmentSchema.safeParse({kind:'PERSONAL',attestation:true,status:'APPROVED'}).success).toBe(false);
  });
  it('keeps a submitted professional personal until reviewed and rejects a stale decision',async()=>{
    const u=await newUser();const input={kind:'PROFESSIONAL',profession:'DOCTOR',authority:'MDCN',licenceNumber:'QA123',expiresAt:'2030-01-01',country:'Nigeria',attestation:true};
    const result=await request(app).post('/api/v1/ai-account/enrollment').set('Authorization',tokenFor(u.id)).send({expectedVersion:0,enrollment:input});
    expect(result.status).toBe(200);expect(result.body.data.category).toBe('PERSONAL');
    const decision={expectedVersion:1,status:'APPROVED',verificationReference:'Synthetic issuing-body check QA-1',reason:'Verified synthetic test registration'};
    expect((await api('post',`/accounts/${u.id}/decision`,decision)).status).toBe(200);
    expect((await aiAccess(u.id)).category).toBe('PROFESSIONAL');
    expect((await api('post',`/accounts/${u.id}/decision`,decision)).status).toBe(409);
    expect(await prisma.professionalProfile.findUnique({where:{userId:u.id}})).toBeNull();
  });
  it('denies self approval and applies suspension despite positive feature overrides',async()=>{
    await prisma.aiEnrollment.create({data:{userId:admin.id,kind:'PROFESSIONAL',status:'PENDING',details:{},featureOverrides:{chat:true}}});
    expect((await api('post',`/accounts/${admin.id}/decision`,{expectedVersion:1,status:'APPROVED',verificationReference:'QA verification reference',reason:'Synthetic self-review must be denied'})).status).toBe(403);
    await prisma.aiEnrollment.update({where:{userId:admin.id},data:{status:'SUSPENDED'}});
    expect((await aiAccess(admin.id)).features.chat).toBe(false);
  });
  it('enforces individual feature restrictions at API and direct service entry points',async()=>{
    const u=await newUser();await prisma.aiEnrollment.create({data:{userId:u.id,kind:'PERSONAL',status:'APPROVED',details:{},featureOverrides:{chat:false,memory:false}}});
    const config=await request(app).get('/api/v1/ai/config').set('Authorization',tokenFor(u.id));expect(config.body.data.enabled).toBe(false);
    await expect(createAiSession(u.id,{consentVersion:AI_CONSENT_VERSION})).rejects.toMatchObject({code:'AI_FEATURE_DENIED'});
    const memory=await request(app).post('/api/v1/ai/memory').set('Authorization',tokenFor(u.id)).send({kind:'PREFERENCE',content:'synthetic'});expect(memory.status).toBe(403);
  });
});
describe('private knowledge administration and retrieval',()=>{
  it('denies catalogue, upload, pages, preview and publish to ordinary users and support roles',async()=>{
    for(const user of [normal,support])for(const [method,path]of [['get','/knowledge/documents'],['post','/knowledge/documents'],['get',`/knowledge/documents/${randomUUID()}`],['post',`/knowledge/documents/${randomUUID()}/preview`],['put',`/knowledge/documents/${randomUUID()}/file`]])expect((await api(method,path,{},user)).status).toBe(403);
    expect((await request(app).get('/api/v1/command-centre/ai/knowledge/documents')).status).toBe(401);
    expect((await request(app).get('/api/v1/ai/knowledge/documents').set('Authorization',tokenFor(normal.id))).status).toBe(404);
  });
  it('creates one upload on retries, validates rights and keeps it unpublished',async()=>{
    const body={id:randomUUID(),metadata,byteSize:100,sha256:'b'.repeat(64),reason:'Upload synthetic book for QA',scanDisclosureAccepted:true};
    const a=await api('post','/knowledge/documents',body),b=await api('post','/knowledge/documents',body);
    expect(a.status).toBe(200);expect(b.status).toBe(200);expect(b.body.data.id).toBe(a.body.data.id);
    expect(a.body.data.status).toBe('AWAITING_UPLOAD');
    expect((await api('post','/knowledge/documents',{...body,id:randomUUID(),metadata:{...metadata,rightsConfirmed:false}})).status).toBe(400);
  });
  it('blocks dirty preview, uploader approval and incomplete extraction review',async()=>{
    const doc=await source('REVIEW_REQUIRED');await prisma.aiKnowledgeDocument.update({where:{id:doc.id},data:{scanStatus:'PENDING'}});
    expect((await api('post',`/knowledge/documents/${doc.id}/preview`,{reason:'Inspect synthetic PDF'})).status).toBe(409);
    await prisma.aiKnowledgeDocument.update({where:{id:doc.id},data:{scanStatus:'CLEAN'}});
    expect((await api('post',`/knowledge/documents/${doc.id}/approve`,{expectedVersion:1,reason:'Synthetic source review'})).status).toBe(403);
    await prisma.aiKnowledgePassage.updateMany({where:{documentId:doc.id},data:{quality:'REVIEW_REQUIRED'}});
    expect((await api('post',`/knowledge/documents/${doc.id}/approve`,{expectedVersion:1,reason:'Synthetic source review'},reviewer)).status).toBe(409);
  });
  it('separates page review, independent approval, publication and retirement',async()=>{
    const doc=await source('REVIEW_REQUIRED');
    expect((await api('post',`/knowledge/documents/${doc.id}/page-review`,{expectedVersion:1,pageNumber:1,pageLabel:'12',text,quality:'APPROVED',reason:'Checked synthetic source page'})).status).toBe(200);
    expect((await api('post',`/knowledge/documents/${doc.id}/approve`,{expectedVersion:2,reason:'Independent synthetic source review'},reviewer)).status).toBe(200);
    expect((await api('post',`/knowledge/documents/${doc.id}/publish`,{expectedVersion:3,reason:'Publish synthetic reviewed reference'})).status).toBe(200);
    expect((await retrieveKnowledge(normal.id,'hydration')).some(p=>p.documentId===doc.id)).toBe(true);
    const refs=(await retrieveKnowledge(normal.id,'hydration')).filter(p=>p.documentId===doc.id);
    expect((await api('post',`/knowledge/documents/${doc.id}/retire`,{expectedVersion:4,reason:'Withdraw synthetic source from retrieval'})).status).toBe(200);
    expect(await knowledgeReferencesAvailable(normal.id,refs)).toBe(false);
    expect((await retrieveKnowledge(normal.id,'hydration')).some(p=>p.documentId===doc.id)).toBe(false);
  });
  it('filters professional-only, draft, excluded and expired sources before synthesis',async()=>{
    const pro=await source('PUBLISHED',['PROFESSIONAL']);const draft=await source('APPROVED');const expired=await source();const excluded=await source();
    await prisma.aiKnowledgeDocument.update({where:{id:expired.id},data:{metadata:{...metadata,reviewBy:'2020-01-01'}}});
    await prisma.aiKnowledgePassage.updateMany({where:{documentId:excluded.id},data:{quality:'EXCLUDED'}});
    const ids=(await retrieveKnowledge(normal.id,'hydration')).map(p=>p.documentId);for(const d of [pro,draft,expired,excluded])expect(ids).not.toContain(d.id);
  });
  it('returns reference metadata without text and rejects fabricated or excessive verbatim citations',()=>{
    const p={label:'K1',text,sourceTitle:'Synthetic QA',pageNumber:1};
    expect(validateKnowledgeAnswer('Helpful background [K1]',[p])).toEqual([{label:'K1',sourceTitle:'Synthetic QA',pageNumber:1}]);
    expect(()=>validateKnowledgeAnswer('Made up [K9]',[p])).toThrow();expect(()=>validateKnowledgeAnswer('No citation',[p])).toThrow();
    expect(()=>validateKnowledgeAnswer(`${text} [K1]`,[p])).toThrow();
  });
  it('grounds an asynchronous answer and exposes bibliographic citations without file access',async()=>{
    await source();const user=await newUser();const session=await createAiSession(user.id,{consentVersion:AI_CONSENT_VERSION});
    const run=await queueAiMessage(user,session.id,{clientMessageId:randomUUID(),message:'hydration'});
    let evidence;
    await processAiQueue({generate:async(_messages,options)=>{evidence=options.knowledge;return {text:`Discuss your hydration questions with a professional [${evidence[0].label}]`,usage:{inputTokens:100,outputTokens:20}};}});
    expect(evidence.length).toBeGreaterThan(0);
    expect((await prisma.aiRun.findUnique({where:{id:run.id}})).status).toBe('SUCCEEDED');
    const response=await getAiSession(user.id,session.id);const assistant=response.messages.find(m=>m.role==='assistant');
    expect(assistant.citations[0]).toMatchObject({kind:'KNOWLEDGE_REFERENCE',sourceTitle:metadata.title,edition:metadata.edition,pageNumber:1,pageLabel:'12'});
    const serialized=JSON.stringify(assistant.citations);expect(serialized).not.toContain('storageKey');expect(serialized).not.toContain(text);expect(serialized).not.toContain('signedUrl');
  });
  it('refuses bulk-book requests and expires professional access at the licence boundary',async()=>{
    expect(await retrieveKnowledge(normal.id,'reproduce the entire book verbatim')).toEqual([]);
    const u=await newUser();await prisma.aiEnrollment.create({data:{userId:u.id,kind:'PROFESSIONAL',status:'APPROVED',expiresAt:new Date('2020-01-01'),details:{}}});expect((await aiAccess(u.id)).category).toBe('PERSONAL');
  });
  it('extracts physical pages from a real PDF without making a provider request',async()=>{
    const pdf=await PDFDocument.create();const font=await pdf.embedFont(StandardFonts.Helvetica);pdf.addPage().drawText(text,{font,size:10});pdf.addPage();
    const result=await parseKnowledgePdf(Buffer.from(await pdf.save()));expect(result.pages).toHaveLength(2);expect(result.pages[0].text).toContain('Hydration');expect(result.pages[1].text).toBe('');
    await expect(parseKnowledgePdf(Buffer.from('not a PDF'))).rejects.toThrow();
  });
  it('has no public RLS policies on library and enrollment tables',async()=>{
    const rows=await prisma.$queryRaw`SELECT relname,relrowsecurity FROM pg_class WHERE relname IN ('ai_enrollments','ai_access_policies','ai_knowledge_documents','ai_knowledge_passages')`;
    expect(rows).toHaveLength(4);expect(rows.every(r=>r.relrowsecurity)).toBe(true);
    const sql=await readFile(new URL('../../prisma/migrations/20261020210000_ai_standalone_knowledge/migration.sql',import.meta.url),'utf8');expect(sql).not.toContain('CREATE POLICY');
  });
});
