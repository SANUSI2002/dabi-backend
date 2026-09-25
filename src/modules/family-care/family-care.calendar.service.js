import * as r from "./family-care.calendar.repository.js";
const fail = (code) => Object.assign(new Error(code), { code });

const scope = async (tx, userId, query) => {
  const circleId = query.circlePatientId ?? userId;
  const owner = circleId === userId;
  let permission;
  if (owner) {
    if (!(await r.patient(tx, userId))) throw fail("FORBIDDEN");
  } else {
    permission = await r.grant(tx, circleId, userId);
    if (!permission) throw fail("NOT_FOUND");
  }
  const account = await r.identity(tx, circleId);
  if (!account) throw fail("NOT_FOUND");
  const members = [
    {
      id: "self",
      kind: "PATIENT",
      name: owner ? "Myself" : (account.full_name ?? "Patient"),
      relationship: "Self",
      calendarAvailable: true,
    },
  ];
  const sources = new Map([["self", circleId]]);
  // A patient's invitation grants access TO that patient's data, never reciprocal access.
  if (owner)
    for (const member of await r.members(tx, circleId)) {
      if (member.caregiverId === circleId) continue;
      if (!(await r.grant(tx, member.caregiverId, userId))) continue;
      const identity = await r.identity(tx, member.caregiverId);
      if (!identity) continue;
      members.push({
        id: member.id,
        kind: "MEMBER",
        name: identity.full_name ?? "Member",
        relationship: member.relationshipLabel ?? "Member",
        calendarAvailable: true,
      });
      sources.set(member.id, member.caregiverId);
    }
  // PROFILE alone, APPOINTMENTS alone, or being a co-manager alone is insufficient for dependent disclosure.
  if (owner || permission.permissions.includes("APPOINTMENTS")) {
    for (const dependent of await r.dependents(
      tx,
      circleId,
      owner ? undefined : permission.id,
    )) {
      members.push({
        id: dependent.id,
        kind: "DEPENDENT",
        name: dependent.fullName,
        relationship: dependent.careType ?? "Dependent",
        calendarAvailable: true,
      });
    }
  }
  if (query.memberId && !members.some((member) => member.id === query.memberId))
    throw fail("NOT_FOUND");
  const selected = query.memberId
    ? members.filter((member) => member.id === query.memberId)
    : members;
  return { members, selected, sources };
};
export const read = (userId, query, upcoming = false) =>
  r.transaction(async (tx) => {
    const { members, selected, sources } = await scope(tx, userId, query);
    const userIds = [
      ...new Set(selected.map((m) => sources.get(m.id)).filter(Boolean)),
    ];
    // Dependents are not accounts. Do not guess a booking association from a name or from the owner ID.
    const rows = userIds.length
      ? await r.appointments(tx, userIds, query, upcoming)
      : [];
    const dependentIds = selected
      .filter((member) => member.kind === "DEPENDENT")
      .map((member) => member.id);
    const dependentRows = dependentIds.length
      ? await r.dependentHospitalAppointments(
          tx,
          query.circlePatientId ?? userId,
          dependentIds,
          query,
          upcoming,
        )
      : [];
    const hasMore =
      upcoming &&
      (rows.length > query.limit || dependentRows.length > query.limit);
    const events = (upcoming ? rows.slice(0, query.limit) : rows)
      .map((row) => {
        const member = selected.find((m) => sources.get(m.id) === row.userId);
        return {
          id: row.id,
          memberId: member.id,
          memberName: member.name,
          title: row.doctorName || "Appointment",
          time: row.time,
          status: row.status,
        };
      })
      .concat(
        (upcoming ? dependentRows.slice(0, query.limit) : dependentRows).map(
          (row) => {
            const member = selected.find((item) => item.id === row.dependentId);
            return {
              id: row.id,
              memberId: member.id,
              memberName: member.name,
              title: row.appointmentType || "Hospital appointment",
              time: row.requestedAt,
              status: row.status,
            };
          },
        ),
      )
      .sort(
        (a, b) =>
          new Date(a.time) - new Date(b.time) || a.id.localeCompare(b.id),
      );
    return {
      members,
      events,
      from: query.from,
      ...(!upcoming
        ? { to: query.to }
        : { hasMore, nextOffset: hasMore ? query.offset + query.limit : null }),
      empty: events.length === 0,
    };
  });
