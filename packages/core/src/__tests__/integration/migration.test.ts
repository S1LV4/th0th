/**
 * Test migration: FK constraints, array types, and JSON metadata
 */

import { getPrismaClient } from '../../services/query/prisma-client.js';
import { logger } from '@th0th-ai/shared';

const prisma = getPrismaClient();

async function testMigration() {
  logger.info('Testing Schema Migration...');

  try {
    // Test 1: Create a memory with array tags and JSON metadata
    logger.info('Test 1: Creating memory with tags array and JSON metadata...');
    const testMemory = await prisma.memory.create({
      data: {
        id: 'test-migration-' + Date.now(),
        content: 'Test memory for migration validation',
        type: 'code',
        level: 1,
        userId: 'test-user',
        projectId: 'test-project',
        importance: 0.8,
        tags: ['migration', 'test', 'postgresql'],
        metadata: { source: 'migration-test', timestamp: new Date().toISOString() },
      },
    });
    logger.info(`✓ Created memory with tags: ${JSON.stringify(testMemory.tags)}`);
    logger.info(`✓ Metadata type: ${typeof testMemory.metadata}`);

    // Test 2: Query by tag using array containment
    logger.info('Test 2: Querying by tag using array containment...');
    const memoriesWithTag = await prisma.memory.findMany({
      where: {
        tags: { has: 'migration' },
      },
    });
    logger.info(`✓ Found ${memoriesWithTag.length} memories with tag 'migration'`);

    // Test 3: Create edge and test FK constraint
    logger.info('Test 3: Creating edge with FK constraint...');
    const testMemory2 = await prisma.memory.create({
      data: {
        id: 'test-migration-2-' + Date.now(),
        content: 'Second test memory',
        type: 'code',
        level: 1,
        importance: 0.5,
        tags: ['test'],
      },
    });

    const testEdge = await prisma.memoryEdge.create({
      data: {
        fromId: testMemory.id,
        toId: testMemory2.id,
        edgeType: 'relates_to',
        weight: 0.9,
        metadata: { reason: 'testing FK constraints' },
      },
    });
    logger.info(`✓ Created edge ${testEdge.id} with JSON metadata`);

    // Test 4: Delete memory and verify cascade delete
    logger.info('Test 4: Testing FK cascade delete...');
    await prisma.memory.delete({ where: { id: testMemory.id } });
    
    const edgeStillExists = await prisma.memoryEdge.findUnique({
      where: { id: testEdge.id },
    });
    
    if (edgeStillExists) {
      throw new Error('Edge should have been deleted by CASCADE');
    }
    logger.info('✓ Edge was cascade deleted as expected');

    // Test 5: Check constraint validation
    logger.info('Test 5: Testing CHECK constraints...');
    try {
      await prisma.memory.create({
        data: {
          id: 'test-invalid-type',
          content: 'Invalid type test',
          type: 'invalid_type', // Should fail CHECK constraint
          level: 1,
          importance: 0.5,
          tags: [],
        },
      });
      throw new Error('Should have failed CHECK constraint');
    } catch (err: any) {
      if (err.message.includes('chk_memory_type')) {
        logger.info('✓ CHECK constraint working correctly');
      } else {
        throw err;
      }
    }

    // Cleanup
    logger.info('Cleaning up test data...');
    await prisma.memory.delete({ where: { id: testMemory2.id } });

    logger.info('\n✅ All migration tests passed!\n');
    logger.info('Migration Summary:');
    logger.info('- ✓ Tags migrated to text[] array');
    logger.info('- ✓ Metadata migrated to jsonb');
    logger.info('- ✓ Foreign key constraints working');
    logger.info('- ✓ CASCADE delete working');
    logger.info('- ✓ CHECK constraints enforced');
    logger.info('- ✓ Array containment queries working');

  } catch (error) {
    logger.error('Migration test failed:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

testMigration().catch(err => {
  console.error(err);
  process.exit(1);
});
