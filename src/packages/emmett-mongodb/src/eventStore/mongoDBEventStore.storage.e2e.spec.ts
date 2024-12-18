import {
  assertIsNotNull,
  assertNotEqual,
  assertOk,
  assertThatArray,
  projections,
  STREAM_DOES_NOT_EXIST,
} from '@event-driven-io/emmett';
import {
  MongoDBContainer,
  type StartedMongoDBContainer,
} from '@testcontainers/mongodb';
import { Collection, Db, MongoClient } from 'mongodb';
import { after, before, describe, it } from 'node:test';
import { v4 as uuid } from 'uuid';
import {
  DefaultMongoDBEventStoreCollectionName,
  getMongoDBEventStore,
  MongoDBEventStoreDefaultStreamVersion,
  mongoDBInlineProjection,
  toStreamCollectionName,
  toStreamName,
  type EventStream,
  type MongoDBEventStore,
  type MongoDBEventStoreCollectionResolution,
  type StreamType,
} from '.';
import {
  type DiscountApplied,
  type PricedProductItem,
  type ProductItemAdded,
  type ShoppingCartEvent,
} from '../testing/shoppingCart.domain';

const SHOPPING_CART_PROJECTION_NAME = 'shoppingCartShortInfo';
const streamType: StreamType = 'shopping_cart';

void describe('MongoDBEventStore storage resolution', () => {
  let mongodb: StartedMongoDBContainer;

  before(async () => {
    mongodb = await new MongoDBContainer().start();
  });

  after(async () => {
    try {
      await mongodb.stop();
    } catch (error) {
      console.log(error);
    }
  });

  void it('sets up database and collection with COLLECTION_PER_STREAM_TYPE as default', async () => {
    const client = new MongoClient(mongodb.getConnectionString(), {
      directConnection: true,
    });

    try {
      const eventStore = getMongoDBEventStore({
        client,
        projections: projections.inline([
          mongoDBInlineProjection({
            name: SHOPPING_CART_PROJECTION_NAME,
            canHandle: ['ProductItemAdded', 'DiscountApplied'],
            evolve,
          }),
        ]),
      });

      await assertCanAppend(eventStore);

      const collection = await assertEventStoreSetUpCollection(
        client.db(),
        toStreamCollectionName(streamType),
      );
      const stream = await collection.findOne();
      assertIsNotNull(stream);
    } finally {
      await client.close();
    }
  });

  void it('sets up database and collection with custom SINGLE_COLLECTION', async () => {
    const customCollectionName = uuid();

    const client = new MongoClient(mongodb.getConnectionString(), {
      directConnection: true,
    });

    try {
      const eventStore = getMongoDBEventStore({
        storage: {
          type: 'SINGLE_COLLECTION',
          collectionName: customCollectionName,
        },
        client,
        projections: projections.inline([
          mongoDBInlineProjection({
            name: SHOPPING_CART_PROJECTION_NAME,
            canHandle: ['ProductItemAdded', 'DiscountApplied'],
            evolve,
          }),
        ]),
      });

      await assertCanAppend(eventStore);

      const collection = await assertEventStoreSetUpCollection(
        client.db(),
        customCollectionName,
      );
      const stream = await collection.findOne();
      assertIsNotNull(stream);
    } finally {
      await client.close();
    }
  });

  void it('sets up database and collection with default SINGLE_COLLECTION', async () => {
    const client = new MongoClient(mongodb.getConnectionString(), {
      directConnection: true,
    });

    try {
      const eventStore = getMongoDBEventStore({
        storage: {
          type: 'SINGLE_COLLECTION',
        },
        client,
        projections: projections.inline([
          mongoDBInlineProjection({
            name: SHOPPING_CART_PROJECTION_NAME,
            canHandle: ['ProductItemAdded', 'DiscountApplied'],
            evolve,
          }),
        ]),
      });

      await assertCanAppend(eventStore);

      const collection = await assertEventStoreSetUpCollection(
        client.db(),
        DefaultMongoDBEventStoreCollectionName,
      );
      const stream = await collection.findOne();
      assertIsNotNull(stream);
    } finally {
      await client.close();
    }
  });

  void it('sets up database and collection with CUSTOM colleciton resolution', async () => {
    const customCollectionSuffix = uuid();
    const databaseName = uuid();

    const client = new MongoClient(mongodb.getConnectionString(), {
      directConnection: true,
    });

    try {
      const eventStore = getMongoDBEventStore({
        storage: {
          type: 'CUSTOM',
          collectionFor: (
            streamType: string,
          ): MongoDBEventStoreCollectionResolution => ({
            collectionName: `${streamType}:${customCollectionSuffix}`,
            databaseName,
          }),
        },
        client,
        projections: projections.inline([
          mongoDBInlineProjection({
            name: SHOPPING_CART_PROJECTION_NAME,
            canHandle: ['ProductItemAdded', 'DiscountApplied'],
            evolve,
          }),
        ]),
      });

      await assertCanAppend(eventStore);

      const collection = await assertEventStoreSetUpCollection(
        client.db(databaseName),
        `${streamType}:${customCollectionSuffix}`,
      );
      const stream = await collection.findOne();
      assertIsNotNull(stream);
    } finally {
      await client.close();
    }
  });
});

const assertCanAppend = async (eventStore: MongoDBEventStore) => {
  const productItem: PricedProductItem = {
    productId: '123',
    quantity: 10,
    price: 3,
  };
  const shoppingCartId = uuid();
  const streamName = toStreamName(streamType, shoppingCartId);

  const result = await eventStore.appendToStream<ShoppingCartEvent>(
    streamName,
    [{ type: 'ProductItemAdded', data: { productItem } }],
    { expectedStreamVersion: STREAM_DOES_NOT_EXIST },
  );

  assertNotEqual(
    result.nextExpectedStreamVersion,
    MongoDBEventStoreDefaultStreamVersion,
  );
};

const assertEventStoreSetUpCollection = async (
  db: Db,
  collectionName: string,
): Promise<Collection<EventStream<ProductItemAdded | DiscountApplied>>> => {
  const existingCollections = await db.collections();
  const collection = existingCollections.find(
    (c) => c.collectionName,
    collectionName,
  );

  assertOk(collection);

  const indexes = await collection.indexes();

  assertThatArray(indexes).anyMatches(
    (index) => index.unique === true && index.key['streamName'] === 1,
  );

  return collection as unknown as Collection<
    EventStream<ProductItemAdded | DiscountApplied>
  >;
};

type ShoppingCartShortInfo = {
  productItemsCount: number;
  totalAmount: number;
};

const evolve = (
  document: ShoppingCartShortInfo | null,
  { type, data: event }: ProductItemAdded | DiscountApplied,
): ShoppingCartShortInfo | null => {
  document = document ?? { productItemsCount: 0, totalAmount: 0 };

  switch (type) {
    case 'ProductItemAdded':
      return {
        totalAmount:
          document.totalAmount +
          event.productItem.price * event.productItem.quantity,
        productItemsCount:
          document.productItemsCount + event.productItem.quantity,
      };
    case 'DiscountApplied':
      return {
        ...document,
        totalAmount: (document.totalAmount * (100 - event.percent)) / 100,
      };
    default:
      return document;
  }
};