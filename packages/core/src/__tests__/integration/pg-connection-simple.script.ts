import { getPrismaClient, disconnectPrisma } from '../../services/query/prisma-client.js';

const prisma = getPrismaClient();

async function main() {
  console.log('🔍 Testing PostgreSQL connection...\n');
  
  try {
    // Test basic connection
    const result = await prisma.$queryRaw`SELECT current_database() as db, current_user as usr, version() as version`;
    console.log('✅ Connection successful!\n');
    console.log('Database info:', result);
    
    // List tables
    const tables = await prisma.$queryRaw`
      SELECT tablename 
      FROM pg_tables 
      WHERE schemaname = 'public' 
      ORDER BY tablename
    `;
    console.log('\n📊 Tables in database:');
    (tables as any[]).forEach((t: any) => console.log(`  - ${t.tablename}`));
    
    // Count data
    const [projectCount, memoryCount, documentCount] = await Promise.all([
      prisma.project.count(),
      prisma.memory.count(),
      prisma.document.count(),
    ]);
    
    console.log('\n📈 Current data:');
    console.log(`  - Projects: ${projectCount}`);
    console.log(`  - Memories: ${memoryCount}`);
    console.log(`  - Documents: ${documentCount}`);
    
  } catch (error) {
    console.error('❌ Connection failed:', error);
    throw error;
  }
}

main()
  .catch(console.error)
  .finally(() => disconnectPrisma());
