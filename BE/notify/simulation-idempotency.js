function createIdempotentAction() {
  const operations = new Map();

  return async function runOnce(key, action) {
    if (typeof key !== "string" || !key || typeof action !== "function") {
      throw new TypeError("An incident ID and action are required.");
    }

    const existing = operations.get(key);
    if (existing) {
      return {
        duplicate: true,
        result: await existing,
      };
    }

    const operation = Promise.resolve().then(action);
    operations.set(key, operation);
    return {
      duplicate: false,
      result: await operation,
    };
  };
}

module.exports = { createIdempotentAction };
