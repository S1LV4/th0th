import { getPrismaClient, disconnectPrisma } from '../../services/query/prisma-client.js';

const prisma = getPrismaClient();

async function main() {
  console.log('Testing PostgreSQL connection...');
  console.log('DATABASE_URL:', process.env.DATABASE_URL?.substring(0, 50) + '...');
  
  // Test query
  const result = await prisma.$queryRaw`SELECT current_database() as db, current_user as user`;
  console.log('Connection successful!', result);
  
  // List tables
  const tables = await prisma.$queryRaw`
    SELECT tablename FROM pg_tables 
    WHERE schemaname = 'public' 
    ORDER BY tablename
  `;
  console.log('\nTables in database:', tables);
  
  // Count projects
  const projectCount = await prisma.project.count();
  console.log(`\nProjects in database: ${projectCount}`);
  
  // Count memories
  const memoryCount = await prisma.memory.count();
  console.log(`Memories in database: ${memoryCount}`);
}

main()
  .catch(console.error)
  .finally(() => disconnectPrisma());
