import {
  createInviteSchema,
  listAppointmentsQuerySchema,
  listInvitesQuerySchema,
  listUsersQuerySchema,
  objectId,
  updateUserSchema,
} from "./admin.validators.js";
import {
  createInvite,
  getStats,
  listAllAppointments,
  listInvites,
  listUsers,
  revokeInvite,
  setUserActive,
} from "./admin.service.js";

const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (err) {
    next(err);
  }
};

export const stats = handle(async (req, res) => {
  res.status(200).json({ data: await getStats() });
});

export const users = handle(async (req, res) => {
  const { users: data, meta } = await listUsers(listUsersQuerySchema.parse(req.query));
  res.status(200).json({ data, meta });
});

export const updateUser = handle(async (req, res) => {
  const userId = objectId.parse(req.params.id);
  const { isActive } = updateUserSchema.parse(req.body);
  res.status(200).json({ data: await setUserActive(req.auth, userId, isActive) });
});

export const invites = handle(async (req, res) => {
  const { invites: data, meta } = await listInvites(listInvitesQuerySchema.parse(req.query));
  res.status(200).json({ data, meta });
});

export const addInvite = handle(async (req, res) => {
  const { invite, code } = await createInvite(req.auth, createInviteSchema.parse(req.body));
  res.status(201).json({ data: invite, meta: { code } });
});

export const removeInvite = handle(async (req, res) => {
  res.status(200).json({ data: await revokeInvite(objectId.parse(req.params.id)) });
});

export const appointments = handle(async (req, res) => {
  const { appointments: data, meta } = await listAllAppointments(listAppointmentsQuerySchema.parse(req.query));
  res.status(200).json({ data, meta });
});
