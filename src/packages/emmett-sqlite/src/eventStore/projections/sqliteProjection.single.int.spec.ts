import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuid } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sqliteRawSQLProjection, type SQLiteProjectionHandlerContext } from '.';
import { sqliteConnection, type SQLiteConnection } from '../../connection';
import {
  type DiscountApplied,
  type ProductItemAdded,
} from '../../testing/shoppingCart.domain';
import { SQLiteProjectionSpec } from './sqliteProjectionSpec';

type EventType =
  | (ProductItemAdded & {
      metadata: { streamName: string };
    })
  | (DiscountApplied & {
      metadata: { streamName: string };
    });

const projection = 'shoppingCartShortInfo';

const testDatabasePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
);
const fileName = path.resolve(testDatabasePath, 'testdb.db');

void describe('SQLite Projections', () => {
  let given: SQLiteProjectionSpec<EventType>;
  let connection: SQLiteConnection;
  let shoppingCartId: string;

  beforeEach(async () => {
    console.log(fileName);
    connection = sqliteConnection({ fileName: fileName });

    const streamsTableSQL = `CREATE TABLE IF NOT EXISTS ${projection}
        (
          id TEXT PRIMARY KEY,
          productItemsCount INTEGER,
          totalAmount INTEGER,
          discountsApplied TEXT
        );
      `;

    await connection.command(streamsTableSQL);

    given = SQLiteProjectionSpec.for({
      projection: shoppingCartShortInfoProjection,
      connection: connection,
    });
  });

  beforeEach(() => (shoppingCartId = `shoppingCart:${uuid()}:${uuid()}`));

  afterEach(async () => {
    if (!fs.existsSync(fileName)) {
      return;
    }
    fs.unlinkSync(fileName);
  });

  void it('with empty given and raw when', () =>
    given([])
      .when([
        {
          type: 'ProductItemAdded',
          data: {
            productItem: {
              price: 100,
              productId: 'shoes',
              quantity: 100,
            },
          },
          metadata: {
            streamName: shoppingCartId,
          },
        },
      ])
      .then(
        async ({ connection }) =>
          await rowExists({
            connection,
            id: shoppingCartId,
          }),
      ));
});

const rowExists = async <T>({
  connection,
  id,
}: {
  connection: SQLiteConnection;
  id: string;
}): Promise<boolean> => {
  const res = await connection.querySingle<T>(
    `SELECT * FROM ${projection} WHERE id = ?`,
    [id],
  );

  try {
    expect(res).toBeTruthy();
  } catch (_e: unknown) {
    return false;
  }
  return true;
};

type ShoppingCartShortInfo = {
  productItemsCount: number;
  totalAmount: number;
  appliedDiscounts: string[];
};

const shoppingCartShortInfoProjection = sqliteRawSQLProjection(
  (event: EventType) => event.metadata.streamName,
  async (
    event: EventType,
    context: SQLiteProjectionHandlerContext,
    documentId: string,
  ): Promise<string> => {
    const res = await context.connection.querySingle<{
      productItemsCount: number;
      totalAmount: number;
      discountsApplied: string;
    }>(
      `SELECT productItemsCount, totalAmount, discountsApplied FROM ${projection} WHERE id = ? limit 1`,
      [documentId],
    );

    const document: ShoppingCartShortInfo = {
      productItemsCount: 0,
      totalAmount: 0,
      appliedDiscounts: [],
    };
    if (res != null) {
      document.productItemsCount = res.productItemsCount;
      document.totalAmount = res.totalAmount;
      document.appliedDiscounts = res.discountsApplied.split(',');
    }

    switch (event.type) {
      case 'ProductItemAdded':
        document.productItemsCount += event.data.productItem.quantity;
        document.totalAmount +=
          event.data.productItem.price * event.data.productItem.quantity;
        break;
      case 'DiscountApplied':
        if (document.appliedDiscounts.includes(event.data.couponId)) return '';
        document.appliedDiscounts.push(event.data.couponId);
        document.totalAmount =
          (document.totalAmount * (100 - event.data.percent)) / 100;
        break;
      default:
        return '';
    }

    const sql = `INSERT INTO 
        ${projection} 
        (
          id, 
          productItemsCount, 
          totalAmount, 
          discountsApplied
        ) VALUES (
          "${documentId}", 
          "${document.productItemsCount}", 
          "${document.totalAmount}", 
          "${document.appliedDiscounts.join(',')}"
        )
        ON CONFLICT (id) DO UPDATE SET
          productItemsCount = "${document.productItemsCount}",
          totalAmount = "${document.totalAmount}",
          discountsApplied = "${document.appliedDiscounts.join(',')}"
      `;
    return sql;
  },
  ['ProductItemAdded', 'DiscountApplied'],
);
