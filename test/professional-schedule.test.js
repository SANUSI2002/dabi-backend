import {describe,it,expect,vi,beforeEach} from 'vitest';
import {generateSchedule,scheduleSchema,scheduleInstant} from '../src/modules/doctor-appointments/schedule.policy.js';
const settings={timezone:'Africa/Lagos',durationMinutes:30,bufferMinutes:5,weeklyHours:[{day:3,start:'09:00',end:'12:00',consultationTypes:['VIRTUAL'],breaks:[{start:'10:00',end:'10:30'}]}]};
const range={from:'2026-10-07',to:'2026-10-07'}, now=new Date('2026-10-06T00:00:00Z');
describe('schedule generation',()=>{
  it('uses Lagos rather than machine time, respects buffers and skips breaks',()=>{
    const slots=generateSchedule(settings,range,[],now);
    expect(slots.map(s=>s.startsAt.toISOString())).toEqual(['2026-10-07T08:00:00.000Z','2026-10-07T09:45:00.000Z','2026-10-07T10:20:00.000Z']);
  });
  it('excludes any appointment crossing a blocked interval',()=>{
    const slots=generateSchedule(settings,range,[{startsAt:'2026-10-07T08:15:00Z',endsAt:'2026-10-07T09:00:00Z'}],now);
    expect(slots).toHaveLength(2);expect(slots.every(s=>s.startsAt>=new Date('2026-10-07T09:00:00Z'))).toBe(true);
  });
  it('rejects invalid ranges, unsupported timezones, overlapping shifts and invalid breaks',()=>{
    expect(()=>generateSchedule(settings,{from:'2026-10-07',to:'2026-12-01'},[],now)).toThrow();
    expect(scheduleSchema.safeParse({...settings,timezone:'Guess/Zone'}).success).toBe(false);
    expect(()=>generateSchedule({...settings,weeklyHours:[...settings.weeklyHours,...settings.weeklyHours]},range,[],now)).toThrow(/overlap/);
    expect(scheduleSchema.safeParse({...settings,weeklyHours:[{...settings.weeklyHours[0],breaks:[{start:'08:00',end:'08:30'}]}]}).success).toBe(false);
  });
  it('does not generate elapsed appointments or invent appointments on disabled days',()=>{
    expect(generateSchedule(settings,{from:'2026-10-08',to:'2026-10-08'},[],now)).toHaveLength(0);
    expect(generateSchedule(settings,range,[],new Date('2026-10-07T13:00:00Z'))).toHaveLength(0);
    expect(scheduleInstant('2026-10-07','09:00','UTC').toISOString()).toBe('2026-10-07T09:00:00.000Z');
  });
});
const f=()=>vi.fn();const db={professionalProfile:{findFirst:f()},professionalSchedule:{findUnique:f()},professionalTimeBlock:{findMany:f(),create:f(),deleteMany:f()},doctorAppointment:{findFirst:f()},doctorAvailabilitySlot:{updateMany:f(),findFirst:f(),create:f()},activityLog:{create:f()},$queryRaw:f(),$transaction:f()};
vi.mock('../src/config/db.js',()=>({default:db}));
const service=await import('../src/modules/doctor-appointments/schedule.service.js');
beforeEach(()=>{vi.clearAllMocks();db.$transaction.mockImplementation(work=>work(db));db.professionalProfile.findFirst.mockResolvedValue({id:'pro',professionType:'DOCTOR'});db.professionalTimeBlock.findMany.mockResolvedValue([]);db.professionalSchedule.findUnique.mockResolvedValue(settings);});
describe('time blocks and ownership',()=>{
  it('refuses a block that overlaps a booked appointment without modifying anything',async()=>{
    db.doctorAppointment.findFirst.mockResolvedValue({id:'booked'});
    await expect(service.addBlock('owner',{startsAt:'2026-10-07T08:00:00Z',endsAt:'2026-10-07T09:00:00Z',reason:'Leave'})).rejects.toThrow(/existing appointment/);
    expect(db.professionalTimeBlock.create).not.toHaveBeenCalled();expect(db.doctorAvailabilitySlot.updateMany).not.toHaveBeenCalled();
  });
  it('cancels only the owner’s unbooked overlapping availability when adding a block',async()=>{
    db.doctorAppointment.findFirst.mockResolvedValue(null);db.professionalTimeBlock.create.mockResolvedValue({id:'block'});
    await service.addBlock('owner',{startsAt:'2026-10-07T08:00:00Z',endsAt:'2026-10-07T09:00:00Z',reason:'Leave'});
    expect(db.doctorAvailabilitySlot.updateMany.mock.calls[0][0].where.doctorProfileId).toBe('pro');
    expect(db.activityLog.create.mock.calls[0][0].data.userId).toBe('owner');
  });
  it('cannot remove another practitioner’s block',async()=>{
    db.professionalTimeBlock.deleteMany.mockResolvedValue({count:0});await expect(service.removeBlock('owner','other-block')).rejects.toThrow(/not found/);
    expect(db.professionalTimeBlock.deleteMany).toHaveBeenCalledWith({where:{id:'other-block',professionalId:'pro'}});
  });
  it('does not grant scheduling to pending or unknown professional accounts',async()=>{
    db.professionalProfile.findFirst.mockResolvedValue(null);await expect(service.load('pending')).rejects.toThrow(/approved/);
    expect(db.professionalProfile.findFirst.mock.calls[0][0].where.verificationStatus).toBe('VERIFIED');
  });
});
