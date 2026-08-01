#!/usr/bin/env node
/**
 * Generate a scrypt hash for a BrewOps PIN.
 *
 *   node functions/scripts/hash-pin.js 481902
 *
 * Prints a "salt:hash" string. Store it as a Firebase secret — never commit it:
 *
 *   firebase functions:secrets:set OWNER_PIN_HASH
 *   firebase functions:secrets:set STAFF_PIN_HASH
 *
 * The PIN itself is never stored anywhere. If it is forgotten, generate a new
 * hash and update the secret.
 */
const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

const pin = process.argv[2];

if (!pin || !/^\d{4,12}$/.test(pin)) {
  console.error('Usage: node hash-pin.js <pin>   (4-12 digits)');
  process.exit(1);
}

if (/^(\d)\1+$/.test(pin) || '0123456789'.indexOf(pin) !== -1) {
  console.error('Refusing: that PIN is a repeated digit or a straight run. Pick another.');
  process.exit(1);
}

const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(pin, salt, SCRYPT.keylen, SCRYPT);

console.log(`${salt.toString('hex')}:${hash.toString('hex')}`);
