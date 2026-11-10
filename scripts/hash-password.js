// Usage: npm run hash-password -- "YourPassword"
// Prints an Argon2id hash to put in ADMIN_PASSWORD_HASH.
const argon2 = require('argon2');
const { HASH_OPTIONS } = require('../auth-config');

const password = process.argv[2];
if (!password) {
  console.error('Usage: npm run hash-password -- "YourPassword"');
  process.exit(1);
}

argon2.hash(password, HASH_OPTIONS).then((hash) => {
  console.log(hash);
});
