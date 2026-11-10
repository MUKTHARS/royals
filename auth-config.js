const argon2 = require('argon2');

// Argon2id with OWASP-recommended-or-stronger parameters (64 MiB memory, 3 passes).
const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
};

module.exports = { HASH_OPTIONS };
