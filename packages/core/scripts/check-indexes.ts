import { getPrismaClient } from './src/services/query/prisma-client.js';

const prisma = getPrismaClient();

const result = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
  SELECT indexname, indexdef 
  FROM pg_indexes 
  WHERE tablename = 'symbol_imports'
  ORDER BY indexname
`;

console.log('\nIndexes on symbol_imports:');
result.forEach(r => {
  console.log(`  - ${r.indexname}`);
  if (r.indexname.includes('names')) {
    console.log(`    ${r.indexdef}`);
  }
});

await prisma.$disconnect();
