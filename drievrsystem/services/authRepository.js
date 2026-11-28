import { DBProvider } from './dbProvider.js';

export const AuthRepository = {
  async getUser(username) {
    const results = await DBProvider.findByFields('users', { username });
    return results[0] || null;
  },
  async saveUser(payload) {
    if (payload?.username !== 'admin') throw new Error('[AuthRepository] only admin is supported');
    return DBProvider.save('users', payload, { username: 'admin' });
  }
};
