/**
 * Test PostgreSQL migration - verify all systems work
 */

import { getPrismaClient } from '../../services/query/prisma-client.js';
import { logger } from '@th0th-ai/shared';

const prisma = getPrismaClient();

async function testPostgreSQLMigration() {
  logger.info('🚀 Testing PostgreSQL migration...');

  try {
    // Test 1: Check connection
    logger.info('Test 1: Checking database connection...');
    await prisma.$queryRaw`SELECT 1 as test`;
    logger.info('✅ Database connection successful');

    // Test 2: Check memories table
    logger.info('Test 2: Checking memories table...');
    const memoryCount = await prisma.memory.count();
    logger.info(`✅ Memories table accessible. Count: ${memoryCount}`);

    // Test 3: Create a test memory
    logger.info('Test 3: Creating test memory...');
    const testMemory = await prisma.memory.create({
      data: {
        id: `test_${Date.now()}`,
        content: 'PostgreSQL migration test memory',
        type: 'conversation',
        level: 1,
        importance: 0.5,
        projectId: 'test-project',
      },
    });
    logger.info(`✅ Test memory created: ${testMemory.id}`);

    // Test 4: Read the test memory
    logger.info('Test 4: Reading test memory...');
    const readMemory = await prisma.memory.findUnique({
      where: { id: testMemory.id },
    });
    logger.info(`✅ Test memory retrieved: ${readMemory?.content}`);

    // Test 5: Check workspaces table
    logger.info('Test 5: Checking workspaces table...');
    const workspaceCount = await prisma.workspace.count();
    logger.info(`✅ Workspaces table accessible. Count: ${workspaceCount}`);

    // Test 6: Check symbol tables
    logger.info('Test 6: Checking symbol tables...');
    const symbolDefCount = await prisma.symbolDefinition.count();
    logger.info(`✅ Symbol definitions table accessible. Count: ${symbolDefCount}`);

    // Test 7: Check graph edges
    logger.info('Test 7: Checking memory edges table...');
    const edgeCount = await prisma.memoryEdge.count();
    logger.info(`✅ Memory edges table accessible. Count: ${edgeCount}`);

    // Test 8: Check embedding cache
    logger.info('Test 8: Checking embedding cache table...');
    const cacheCount = await prisma.embeddingCache.count();
    logger.info(`✅ Embedding cache table accessible. Count: ${cacheCount}`);

    // Clean up test memory
    await prisma.memory.delete({
      where: { id: testMemory.id },
    });
    logger.info('✅ Test memory cleaned up');

    logger.info('');
    logger.info('🎉 All PostgreSQL migration tests passed!');
    logger.info('');
    logger.info('Summary:');
    logger.info(`  - Memories: ${memoryCount}`);
    logger.info(`  - Workspaces: ${workspaceCount}`);
    logger.info(`  - Symbol definitions: ${symbolDefCount}`);
    logger.info(`  - Memory edges: ${edgeCount}`);
    logger.info(`  - Embedding cache entries: ${cacheCount}`);

  } catch (error) {
    logger.error('❌ PostgreSQL migration test failed:', error as Error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

testPostgreSQLMigration();
