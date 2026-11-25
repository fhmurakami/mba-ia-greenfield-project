import { DataSource } from 'typeorm';
import { AppDataSource } from '../data-source';

export type SeedFunction = (dataSource: DataSource) => Promise<void>;

const seeders: SeedFunction[] = [];

async function runSeeds(): Promise<void> {
  await AppDataSource.initialize();
  try {
    for (const seeder of seeders) {
      await seeder(AppDataSource);
    }
    console.log('Database seeding completed successfully.');
  } finally {
    await AppDataSource.destroy();
  }
}

runSeeds().catch((error: unknown) => {
  console.error('Database seeding failed:', error);
  process.exit(1);
});
