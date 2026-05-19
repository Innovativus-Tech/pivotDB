import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';

const prisma = new PrismaClient();

async function main() {
  const count = await prisma.user.count();
  if (count === 0) {
    const email = process.env.SUPERADMIN_EMAIL ?? 'admin@localhost';
    const password = process.env.SUPERADMIN_PASSWORD ?? 'changeme';
    const passwordHash = createHash('sha256').update(password).digest('hex');
    await prisma.user.create({
      data: { email, passwordHash, role: 'superadmin' },
    });
    console.log(`✅ Superadmin created: ${email}`);
    console.log('   Log in and go to Settings → Create Admin Profile to set up your workspace.');
  } else {
    console.log('Users already exist, skipping seed.');
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
