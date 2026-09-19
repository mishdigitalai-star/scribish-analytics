/* eslint-disable no-console */
import 'dotenv/config';
import { execSync } from 'node:child_process';
import { PrismaPg } from '@prisma/adapter-pg';
import chalk from 'chalk';
import { PrismaClient } from '../generated/prisma/client.js';

const MIN_VERSION = '9.4.0';
const MIN_VERSION_NUM = 90400;

if (process.env.SKIP_DB_CHECK) {
  console.log('Skipping database check.');
  process.exit(0);
}

const url = new URL(process.env.DATABASE_URL);

const adapter = new PrismaPg(
  { connectionString: url.toString() },
  { schema: url.searchParams.get('schema') },
);

const prisma = new PrismaClient({ adapter });

function success(msg) {
  console.log(chalk.greenBright(`✓ ${msg}`));
}

function error(msg) {
  console.log(chalk.redBright(`✗ ${msg}`));
}

// scribish-analytics: a TCP-level failure from node-postgres (every resolved
// address refused or unreachable) is an AggregateError whose message is an
// empty string, which printed as a bare "✗" and hid the real cause. Print
// the name, code, cause and each underlying error so the build log says
// what actually happened.
function describe(e) {
  const parts = [e?.message || `${e?.name || 'Error'} with no message`];
  if (e?.code) parts.push(`code=${e.code}`);
  if (e?.cause) parts.push(`cause=${e.cause.message || e.cause}`);
  if (Array.isArray(e?.errors) && e.errors.length) {
    parts.push('underlying: ' + e.errors.map(x => `${x.code || x.name}: ${x.message}`).join('; '));
  }
  return parts.join(' | ');
}

async function checkEnv() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not defined.');
  } else {
    success('DATABASE_URL is defined.');
  }

  if (process.env.REDIS_URL) {
    success('REDIS_URL is defined.');
  }
}

async function checkConnection() {
  try {
    await prisma.$connect();

    success('Database connection successful.');
  } catch (e) {
    throw new Error(`Unable to connect to the database: ${e.message}`);
  }
}

async function checkDatabaseVersion() {
  // Runs against DATABASE_URL (the runtime connection), not DIRECT_DATABASE_URL.
  let query;
  try {
    query = await prisma.$queryRaw`select current_setting('server_version_num') as version_num`;
  } catch (e) {
    throw new Error(`Version query on DATABASE_URL (${url.host}) failed: ${describe(e)}`);
  }
  const version = Number(query[0]?.version_num);

  if (!Number.isFinite(version)) {
    throw new Error('Unable to determine database version.');
  }

  if (version < MIN_VERSION_NUM) {
    throw new Error(
      `Database version is not compatible. Please upgrade to ${MIN_VERSION} or greater.`,
    );
  }

  success('Database version check successful.');
}

async function applyMigration() {
  if (!process.env.SKIP_DB_MIGRATION) {
    const directUrl = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
    console.log(
      execSync('prisma migrate deploy', {
        env: { ...process.env, DATABASE_URL: directUrl },
      }).toString(),
    );

    success('Database is up to date.');
  }
}

(async () => {
  let err = false;
  for (const fn of [checkEnv, checkConnection, checkDatabaseVersion, applyMigration]) {
    try {
      await fn();
    } catch (e) {
      error(describe(e));
      err = true;
    } finally {
      if (err) {
        process.exit(1);
      }
    }
  }
})();
