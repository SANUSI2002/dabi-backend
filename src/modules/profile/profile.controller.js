import bcrypt from 'bcryptjs';
import * as ProfileModel from './profile.model.js';
import { revokeUserSessions } from '../auth/auth.session.js';

export const getProfile = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const profile = await ProfileModel.getProfileByUserId(userId);
    res.status(200).json({ status: 'success', data: profile });
  } catch (error) {
    next(error);
  }
};

// PUT /api/v1/profile/update
export const updateProfile = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const updatedProfile = await ProfileModel.upsertUserProfile(userId, req.body);
    res.status(200).json({
      status: 'success',
      message: 'Profile updated successfully',
      data: updatedProfile,
    });
  } catch (error) {
    // A duplicate email hits the unique constraint on users.email.
    if (error?.code === 'P2002') {
      return res.status(409).json({
        status: 'error',
        message: 'That email address is already in use',
      });
    }
    next(error);
  }
};

// A boolean flag cannot enroll or remove an authenticator. Preserve the route
// for old clients but fail closed and direct them to the verified MFA endpoints.
export const updateSecurity = (req, res) => res.status(410).json({ status: 'error', message: 'Use the verified Sabi Identity MFA endpoints.' });

export const getEmergencySummary = async (req, res, next) => {
  try {
    const data = await ProfileModel.getEmergencySummary(req.user.id);
    return res.status(200).json({ status: 'success', data });
  } catch (error) { return next(error); }
};

export const changePassword = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { current_password, new_password } = req.body;
    const user = await ProfileModel.getUserPasswordById(userId);

    if (!user || !(await bcrypt.compare(current_password, user.password))) {
      return res.status(401).json({ status: 'error', message: 'Current password is incorrect' });
    }

    const password = await bcrypt.hash(new_password, 10);
    await ProfileModel.updateUserPassword(userId, password);
    await revokeUserSessions(userId, req.user.sessionId);
    return res.status(200).json({ status: 'success', message: 'Password changed successfully' });
  } catch (error) {
    return next(error);
  }
};

// DELETE /api/v1/profile/delete-account
// The "DELETE" confirmation string is enforced by deleteAccountSchema before we
// get here, so reaching this handler means the user has confirmed.
export const deleteAccount = async (req, res, next) => {
  try {
    const userId = req.user.id;
    await ProfileModel.deleteUserAccount(userId);
    res.status(200).json({ status: 'success', message: 'Account permanently deleted' });
  } catch (error) {
    next(error);
  }
};
