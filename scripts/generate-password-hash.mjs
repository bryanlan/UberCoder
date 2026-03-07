#!/usr/bin/env node
import { randomBytes, scryptSync } from 'node:crypto';

const password = process.argv[2];
if (!password) {
  console.error('Usage: npm run auth:hash -- <password>');
  process.exit(1);
}

const salt = randomBytes(16).toString('hex');
const hash = scryptSync(password, salt, 64).toString('hex');
const sessionSecret = randomBytes(32).toString('hex');

console.log(JSON.stringify({
  passwordHash: `scrypt:${salt}:${hash}`,
  sessionSecret,
}, null, 2));
