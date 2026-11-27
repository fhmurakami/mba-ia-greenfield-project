import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { DataSource, DataSourceOptions } from 'typeorm';
import databaseConfig from '../src/config/database.config';

export function getTestTypeOrmOptions(
  entities?: DataSourceOptions['entities'],
): TypeOrmModuleOptions {
  const db = databaseConfig();
  return {
    type: 'postgres',
    host: db.host,
    port: db.port,
    username: db.username,
    password: db.password,
    database: db.database,
    ...(entities ? { entities } : { autoLoadEntities: true }),
    synchronize: false,
  };
}

export async function createTestDataSource(
  entities: NonNullable<DataSourceOptions['entities']>,
): Promise<DataSource> {
  const db = databaseConfig();
  const dataSource = new DataSource({
    type: 'postgres',
    host: db.host,
    port: db.port,
    username: db.username,
    password: db.password,
    database: db.database,
    entities,
    synchronize: false,
  });

  return dataSource.initialize();
}

export async function clearTestTables(
  dataSource: DataSource,
  tables?: readonly string[],
): Promise<void> {
  const targetTables =
    tables ?? dataSource.entityMetadatas.map((meta) => meta.tableName);

  if (targetTables.length === 0) {
    return;
  }

  for (const table of targetTables) {
    if (!/^[a-zA-Z0-9_]+$/.test(table)) {
      throw new Error(`Invalid table name: ${table}`);
    }
  }

  const quotedTables = targetTables.map((table) => `"${table}"`).join(', ');
  await dataSource.query(
    `TRUNCATE TABLE ${quotedTables} RESTART IDENTITY CASCADE`,
  );
}
