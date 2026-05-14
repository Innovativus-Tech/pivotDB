import { Queue } from 'bullmq';
import { redis } from './redis.js';

const connection = redis;

export const exportQueue  = new Queue('export',  { connection });
export const syncQueue    = new Queue('sync',    { connection });
export const backupQueue  = new Queue('backup',  { connection });
