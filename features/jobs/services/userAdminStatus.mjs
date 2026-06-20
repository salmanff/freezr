// freezr.info — Resolve a user's admin status for the local-job "admins" audience gate.
//
// A job trusted with audience 'admins' may be run locally only by ADMIN users. "Admin" is a
// property of the user (the isAdmin flag on their record), NOT of the request session — so the
// scheduler (no session) and an app-token run-now must resolve it from the user record, not a
// session flag. Handle-based: the caller passes the opened users db (USER_DB_OAC).

export async function isUserAdmin (usersDb, userId) {
  if (!usersDb || !userId) return false
  try {
    const rows = await usersDb.query({ user_id: userId }, {})
    return !!(rows && rows[0] && rows[0].isAdmin)
  } catch (e) {
    return false
  }
}

export default { isUserAdmin }
