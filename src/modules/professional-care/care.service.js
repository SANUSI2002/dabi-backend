import prisma from '../../config/db.js';
import { capabilities, PORTAL_PROFESSIONS } from '../professionals/professionCatalog.js';
import { contentSchema, patientPlan } from './care.policy.js';
import { recordAudit } from '../audit/audit.service.js';
const fail = (message,status=409) => { throw Object.assign(new Error(message),{status}); };
const ACTIVE_APPOINTMENTS = ['CONFIRMED','COMPLETED'];
export function createCareService(db=prisma) {
  const transaction = work => db.$transaction(work,{isolationLevel:'Serializable',timeout:30000});
  const audit = (tx,userId,type,id) => tx.activityLog.create({data:{userId,type,description:'Professional care workspace action',meta:{id}}});
  // What the patient sees in their Activity log about their care plans.
  const trail = (tx,userId,patientId,action,planId,options) => recordAudit(tx,{actorUserId:userId,subjectUserId:patientId,action,resourceType:'care_plan',resourceId:planId},options);
  async function practitioner(tx,userId) {
    const pro = await tx.professionalProfile.findFirst({where:{userId,professionType:{in:PORTAL_PROFESSIONS},verificationStatus:'VERIFIED'},include:{doctorApplication:{select:{details:true}}}});
    const scope = capabilities(pro,pro?.doctorApplication?.details);
    if (!pro || !scope.carePlans) fail('An approved care professional account is required.',403);
    return {...pro,kind:scope.nutrition?'NUTRITION':'SUPPORT'};
  }
  async function consent(tx,professionalId,patientId) {
    if (!await tx.professionalCareConsent.findFirst({where:{professionalId,patientId,active:true},select:{id:true}})) fail('This patient has not granted care-plan access or has revoked it.',403);
  }
  async function owned(tx,userId,id,lock=false) {
    const pro=await practitioner(tx,userId);
    if(lock) await tx.$queryRaw`SELECT id FROM professional_profiles WHERE id = ${pro.id} FOR UPDATE`;
    if(lock) await tx.$queryRaw`SELECT id FROM "ProfessionalCarePlan" WHERE id = ${id} FOR UPDATE`;
    const plan=await tx.professionalCarePlan.findFirst({where:{id,professionalId:pro.id},include:{versions:{orderBy:{number:'desc'}},feedback:{orderBy:{createdAt:'desc'},take:100},notes:{orderBy:{createdAt:'desc'},take:100}}});
    if(!plan) fail('Plan not found.',404);
    await consent(tx,pro.id,plan.patientId);
    return {pro,plan};
  }
  const checkRevision = (plan,revision) => { if(plan.archivedAt) fail('Archived plans cannot be edited.'); if(plan.revision!==revision) fail('This plan changed in another tab. Refresh before editing.'); };
  const validateContent = (pro,content,publish=false) => { const result=contentSchema.parse(content); if(pro.kind!=='NUTRITION' && (result.meals.length || result.targets.length)) fail('Meal planning is reserved for verified dietitians.',403); if(publish && pro.kind==='NUTRITION' && !result.meals.length) fail('Add at least one meal before publishing.'); return result; };
  return {
    directory: async () => {
      const rows=await db.professionalProfile.findMany({where:{professionType:{in:PORTAL_PROFESSIONS.filter(p=>p!=='DOCTOR')},verificationStatus:'VERIFIED',user:{accountStatus:'ACTIVE',emailVerifiedAt:{not:null}}},select:{id:true,professionType:true,specialty:true,bio:true,practiceName:true,consultationFeeMinor:true,consultationTypes:true,user:{select:{full_name:true}},doctorApplication:{select:{details:true}}},orderBy:{createdAt:'desc'},take:200});
      return rows.map(({user,doctorApplication,...p})=>({...p,name:user.full_name,discipline:doctorApplication?.details?.discipline}));
    },
    candidates: async userId => {
      if(!await db.userRole.findFirst({where:{userId,role:'PATIENT'},select:{id:true}})) fail('Patient access required.',403);
      const appointments=await db.doctorAppointment.findMany({where:{patientId:userId,dependentId:null,status:{in:ACTIVE_APPOINTMENTS},doctorProfile:{verificationStatus:'VERIFIED',professionType:{in:PORTAL_PROFESSIONS.filter(p=>p!=='DOCTOR')}}},select:{doctorProfile:{select:{id:true,professionType:true,specialty:true,user:{select:{full_name:true}}}}},take:100,orderBy:{createdAt:'desc'}});
      const consents=await db.professionalCareConsent.findMany({where:{patientId:userId},take:100});
      return [...new Map(appointments.map(({doctorProfile:p})=>[p.id,{id:p.id,name:p.user.full_name,professionType:p.professionType,specialty:p.specialty,active:consents.some(c=>c.professionalId===p.id&&c.active)}])).values()];
    },
    consent: (userId,professionalId,active) => transaction(async tx => {
      if(!await tx.userRole.findFirst({where:{userId,role:'PATIENT'},select:{id:true}})) fail('Patient access required.',403);
      await tx.$queryRaw`SELECT id FROM professional_profiles WHERE id = ${professionalId} FOR UPDATE`;
      if(!active && !await tx.professionalCareConsent.findFirst({where:{professionalId,patientId:userId},select:{id:true}})) fail('Permission not found.',404);
      if(active && !await tx.doctorAppointment.findFirst({where:{patientId:userId,dependentId:null,doctorProfileId:professionalId,status:{in:ACTIVE_APPOINTMENTS},doctorProfile:{verificationStatus:'VERIFIED',professionType:{in:PORTAL_PROFESSIONS.filter(p=>p!=='DOCTOR')}}},select:{id:true}})) fail('A confirmed appointment with this professional is required.',403);
      await tx.professionalCareConsent.upsert({where:{professionalId_patientId:{professionalId,patientId:userId}},create:{professionalId,patientId:userId,active,revokedAt:active?null:new Date()},update:{active,grantedAt:active?new Date():undefined,revokedAt:active?null:new Date()}});
      await audit(tx,userId,active?'CARE_CONSENT_GRANTED':'CARE_CONSENT_REVOKED',professionalId);
      const professional=await tx.professionalProfile.findUnique({where:{id:professionalId},select:{userId:true}});
      await recordAudit(tx,{actorUserId:userId,subjectUserId:userId,relatedUserId:professional?.userId??null,action:active?'CARE_PLAN_ACCESS_GRANTED':'CARE_PLAN_ACCESS_REVOKED',resourceType:'professional',resourceId:professionalId});
      return {active};
    }),
    workspace: async userId => {
      const pro=await practitioner(db,userId);
      const [patients,plans,templates]=await Promise.all([
        db.professionalCareConsent.findMany({where:{professionalId:pro.id,active:true},select:{patientId:true,patient:{select:{full_name:true,patientId:true}}},take:100}),
        db.professionalCarePlan.findMany({where:{professionalId:pro.id,patient:{professionalCareConsents:{some:{professionalId:pro.id,active:true}}}},select:{id:true,patientId:true,title:true,kind:true,revision:true,publishedVersion:true,archivedAt:true,updatedAt:true},orderBy:{updatedAt:'desc'},take:100}),
        db.professionalCareTemplate.findMany({where:{professionalId:pro.id},orderBy:{createdAt:'desc'},take:100})]);
      return {professionType:pro.professionType,kind:pro.kind,patients:patients.map(p=>({id:p.patientId,name:p.patient.full_name,reference:p.patient.patientId})),plans,templates};
    },
    detail: async(userId,id) => { const {plan}=await owned(db,userId,id); await trail(db,userId,plan.patientId,'CARE_PLAN_VIEWED',id,{dedupeMinutes:15}); return plan; },
    save: (userId,id,body) => transaction(async tx => {
      let pro,plan;
      if(id) { ({pro,plan}=await owned(tx,userId,id,true));checkRevision(plan,body.revision); }
      else {pro=await practitioner(tx,userId); await tx.$queryRaw`SELECT id FROM professional_profiles WHERE id = ${pro.id} FOR UPDATE`; if(!body.patientId) fail('Select an authorised patient.',400);await consent(tx,pro.id,body.patientId);}
      const content=validateContent(pro,body.content);
      const saved=id ? await tx.professionalCarePlan.update({where:{id},data:{draft:content,title:content.title,revision:{increment:1}}}) : await tx.professionalCarePlan.create({data:{professionalId:pro.id,patientId:body.patientId,kind:pro.kind,title:content.title,draft:content}});
      await audit(tx,userId,'CARE_PLAN_DRAFT_SAVED',saved.id);await trail(tx,userId,saved.patientId,'CARE_PLAN_SAVED',saved.id);return saved;
    }),
    publish: (userId,id,revision) => transaction(async tx => {
      const {pro,plan}=await owned(tx,userId,id,true);checkRevision(plan,revision);const content=validateContent(pro,plan.draft,true);
      const number=(plan.publishedVersion||0)+1;
      await tx.professionalCareVersion.create({data:{planId:id,number,content}});
      const saved=await tx.professionalCarePlan.update({where:{id},data:{publishedVersion:number,revision:{increment:1}}});
      await tx.notification.create({data:{userId:plan.patientId,title:pro.kind==='NUTRITION'?'Dietician Table updated':'Your care plan is ready',message:`Your professional has published version ${number} of your plan. Open Sabi Health to review it.`}});
      await audit(tx,userId,'CARE_PLAN_PUBLISHED',id);await trail(tx,userId,plan.patientId,'CARE_PLAN_PUBLISHED',id);return saved;
    }),
    archive: (userId,id,revision) => transaction(async tx => {const {plan}=await owned(tx,userId,id,true);checkRevision(plan,revision);const saved=await tx.professionalCarePlan.update({where:{id},data:{archivedAt:new Date(),revision:{increment:1}}});await audit(tx,userId,'CARE_PLAN_ARCHIVED',id);await trail(tx,userId,plan.patientId,'CARE_PLAN_ARCHIVED',id);return saved;}),
    note: (userId,id,body) => transaction(async tx => {const {plan}=await owned(tx,userId,id,true);if(plan.archivedAt)fail('This plan is archived.');const note=await tx.professionalCareNote.create({data:{planId:id,text:body.text,followUpAt:body.followUpAt?new Date(body.followUpAt):null}});await audit(tx,userId,'CARE_SESSION_NOTE_CREATED',id);await trail(tx,userId,plan.patientId,'CARE_PLAN_NOTE_ADDED',id);return note;}),
    template: (userId,body) => transaction(async tx => {const pro=await practitioner(tx,userId);const content=validateContent(pro,body.content);const template=await tx.professionalCareTemplate.create({data:{professionalId:pro.id,kind:pro.kind,name:body.name,content}});await audit(tx,userId,'CARE_TEMPLATE_CREATED',template.id);return template;}),
    patientPlans: async userId => {
      const plans=await db.professionalCarePlan.findMany({where:{patientId:userId,publishedVersion:{not:null}},include:{professional:{select:{id:true,user:{select:{full_name:true}}}},versions:{orderBy:{number:'desc'}},feedback:{orderBy:{createdAt:'desc'},take:100}},orderBy:{updatedAt:'desc'},take:100});
      return plans.map(patientPlan).filter(Boolean);
    },
    feedback: (userId,id,body) => transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "ProfessionalCarePlan" WHERE id = ${id} FOR UPDATE`;
      const plan=await tx.professionalCarePlan.findFirst({where:{id,patientId:userId,publishedVersion:{not:null}}});
      if(!plan) fail('Published plan not found.',404);
      if(plan.archivedAt || plan.publishedVersion!==body.version) fail('Refresh the latest active plan before sending feedback.');
      const feedback=await tx.professionalCareFeedback.create({data:{planId:id,...body}});
      await tx.notification.create({data:{userId:(await tx.professionalProfile.findUnique({where:{id:plan.professionalId},select:{userId:true}})).userId,title:'Patient plan feedback',message:'New progress feedback is available in your care workspace.'}});
      await audit(tx,userId,'CARE_PLAN_FEEDBACK_CREATED',id);return feedback;
    }),
  };
}
export const careService=createCareService();
