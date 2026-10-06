import prisma from '../../config/db.js';
import { generateSchedule, scheduleSchema } from './schedule.policy.js';
const error = (message, status = 409) => Object.assign(new Error(message), { status });
const ACTIVE = ['REQUESTED','CONFIRMED'];
const tx = f => prisma.$transaction(f, { isolationLevel: 'Serializable', timeout: 30000 });
export async function practitioner(db, userId) {
  const profile = await db.professionalProfile.findFirst({ where: { userId, verificationStatus: 'VERIFIED' }, select: { id: true, professionType: true } });
  if (!profile || !['DOCTOR','NUTRITIONIST_DIETITIAN','CAREGIVER','FITNESS_COACH','PSYCHOLOGIST','COUNSELLOR','HEALTH_EDUCATOR'].includes(profile.professionType)) throw error('An approved professional account is required.',403);
  return profile;
}
const audit = (db,userId,type,id) => db.activityLog.create({data:{userId,type,description:'Professional schedule changed',meta:{id}}});
const defaultSettings = { timezone:'Africa/Lagos',durationMinutes:30,bufferMinutes:5,weeklyHours:[] };
export async function load(userId) {
  const pro = await practitioner(prisma,userId);
  const [settings,blocks] = await Promise.all([prisma.professionalSchedule.findUnique({where:{professionalId:pro.id}}),prisma.professionalTimeBlock.findMany({where:{professionalId:pro.id,endsAt:{gt:new Date()}},orderBy:{startsAt:'asc'},take:200})]);
  return {settings: settings ? scheduleSchema.parse(settingsToInput(settings)) : defaultSettings,blocks};
}
const settingsToInput = s => ({timezone:s.timezone,durationMinutes:s.durationMinutes,bufferMinutes:s.bufferMinutes,weeklyHours:s.weeklyHours});
export const save = (userId,settings) => tx(async db => {
  const pro = await practitioner(db,userId); await db.$queryRaw`SELECT id FROM professional_profiles WHERE id = ${pro.id} FOR UPDATE`;
  const data = scheduleSchema.parse(settings);
  await db.professionalSchedule.upsert({where:{professionalId:pro.id},create:{professionalId:pro.id,...data},update:data});
  await audit(db,userId,'PROFESSIONAL_SCHEDULE_SAVED',pro.id); return data;
});
export const publish = (userId,range) => tx(async db => {
  const pro = await practitioner(db,userId); await db.$queryRaw`SELECT id FROM professional_profiles WHERE id = ${pro.id} FOR UPDATE`;
  const settings = await db.professionalSchedule.findUnique({where:{professionalId:pro.id}});
  if (!settings) throw error('Save your working hours first.');
  const blocks = await db.professionalTimeBlock.findMany({where:{professionalId:pro.id,endsAt:{gt:new Date()}}});
  let generated; try { generated = generateSchedule(settingsToInput(settings),range,blocks); } catch(e) { throw error(e.message,400); }
  let created = 0, existing = 0;
  for (const slot of generated) {
    const overlap = await db.doctorAvailabilitySlot.findFirst({where:{doctorProfileId:pro.id,cancelledAt:null,startsAt:{lt:slot.endsAt},endsAt:{gt:slot.startsAt}},select:{startsAt:true,endsAt:true,consultationTypes:true}});
    if (overlap) {
      if (+overlap.startsAt === +slot.startsAt && +overlap.endsAt === +slot.endsAt && JSON.stringify([...overlap.consultationTypes].sort()) === JSON.stringify([...slot.consultationTypes].sort())) {existing++;continue;}
      throw error('New working hours overlap existing slots. Existing appointments have not been changed. Remove unbooked slots or choose another range.');
    }
    await db.doctorAvailabilitySlot.create({data:{doctorProfileId:pro.id,...slot}}); created++;
  }
  await audit(db,userId,'PROFESSIONAL_SCHEDULE_PUBLISHED',pro.id);return {created,existing};
});
export const addBlock = (userId,body) => tx(async db => {
  const pro = await practitioner(db,userId); await db.$queryRaw`SELECT id FROM professional_profiles WHERE id = ${pro.id} FOR UPDATE`;
  const startsAt = new Date(body.startsAt), endsAt = new Date(body.endsAt);
  if (await db.doctorAppointment.findFirst({where:{doctorProfileId:pro.id,status:{in:ACTIVE},startsAt:{lt:endsAt},endsAt:{gt:startsAt}},select:{id:true}})) throw error('This block overlaps an existing appointment. Resolve that appointment first; nothing was changed.');
  const block = await db.professionalTimeBlock.create({data:{professionalId:pro.id,...body,startsAt,endsAt}});
  await db.doctorAvailabilitySlot.updateMany({where:{doctorProfileId:pro.id,cancelledAt:null,startsAt:{lt:endsAt},endsAt:{gt:startsAt}},data:{cancelledAt:new Date()}});
  await audit(db,userId,'PROFESSIONAL_TIME_BLOCK_ADDED',block.id);return block;
});
export const removeBlock = (userId,id) => tx(async db => {
  const pro = await practitioner(db,userId);
  const result = await db.professionalTimeBlock.deleteMany({where:{id,professionalId:pro.id}});
  if (!result.count) throw error('Block not found.',404);
  await audit(db,userId,'PROFESSIONAL_TIME_BLOCK_REMOVED',id); return {removed:true};
});
