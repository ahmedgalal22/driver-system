export const PersistenceCommandType = {
  ADD: 'Add',
  UPDATE: 'Update',
  DELETE: 'Delete'
};

export function createPersistenceCommand(type, aggregate, id, options = {}) {
  return {
    type,
    aggregate,
    id,
    payload: options.payload ?? null,
    patch: options.patch ?? null,
    meta: options.meta ?? null
  };
}