import { DBProvider } from './dbProvider.js';

export const WriteDataSource = {
  async execute(commands, meta) {
    if (!Array.isArray(commands) || commands.length === 0) {
      return [];
    }

    const ops = commands.map(cmd => {
      switch (cmd.type) {
        case 'Add':
          return { op: 'add', store: cmd.aggregate.toLowerCase() + 's', payload: cmd.payload };
        case 'Update':
          return { op: 'update', store: cmd.aggregate.toLowerCase() + 's', id: cmd.id, patch: cmd.patch };
        case 'Delete':
          return { op: 'delete', store: cmd.aggregate.toLowerCase() + 's', id: cmd.id };
        default:
          throw new Error(`[WriteDataSource] Unknown command type: ${cmd.type}`);
      }
    });

    return DBProvider.transaction(ops, meta);
  }
};