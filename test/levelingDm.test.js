import './helpers/tmpDb.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseLevelingConfig, levelUpDmBlocked } from '../src/modules/leveling.js';

const U1 = '111111111111111111';
const U2 = '222222222222222222';
const R1 = '333333333333333333';

test('noDmUsers accepts free text and arrays, drops junk and duplicates', () => {
  assert.deepEqual(normaliseLevelingConfig({ noDmUsers: `${U1}\n${U2}, ${U1} abc 12` }).noDmUsers, [U1, U2]);
  assert.deepEqual(normaliseLevelingConfig({ noDmUsers: [U2, 'x'] }).noDmUsers, [U2]);
  assert.deepEqual(normaliseLevelingConfig({}).noDmUsers, []);
  assert.deepEqual(normaliseLevelingConfig({ noDmRoles: [R1, 'x', R1] }).noDmRoles, [R1]);
});

test('levelUpDmBlocked matches users and roles only', () => {
  const config = normaliseLevelingConfig({ noDmUsers: [U1], noDmRoles: [R1] });
  const member = (id, roles) => ({ id, roles: { cache: new Set(roles) } });
  assert.equal(levelUpDmBlocked(config, member(U1, [])), true);
  assert.equal(levelUpDmBlocked(config, member(U2, [R1])), true);
  assert.equal(levelUpDmBlocked(config, member(U2, [])), false);
});
