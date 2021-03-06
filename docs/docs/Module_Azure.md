---
id: module-azure
title: Azure
---

Cookie Cutter's Azure module is split into three major pieces:

1. *Event Sourced*: use this if your service is reading or manipulating state that is stored in the form of event streams
2. *Materialized*: use this if your service's state follows a more traditional CRUD pattern
3. *Streaming*: use this 

## Event Sourced

### State Management

The `EventSourced` namespace in Cookie Cutter's Azure module is meant for dealing with state that is stored in the form of event streams. Below is an example where the event stream consists of two event types, Increment and Decrement, and the aggregated state is the sum of those events. When the service receives an input message, it will load the aggregate identified with the key `"key-123"` and try to append another Increment event to the same stream.

```typescript
class Increment {
    constructor(public readonly count: number) { }
}

class Decrement {
    constructor(public readonly count: number) { }
}

class TallyState {
    public total: number;

    constructor(snapshot?: { total: number }) {
        this.total = (snapshot && snapshot.total) || 0;
    }

    public snap(): { total: number } {
        return { total: this.total };
    }
}

class TallyStateAggregator {
    public onIncrement(msg: Increment, state: TallyState) {
        state.total += msg.count;
    }

    public onDecrement(msg: Decrement, state: TallyState) {
        state.total -= msg.count;
    }
}

Application.create()
  .input()
      .add(new StaticInputSource([
          { type: "MyInput", payload: { amount: 5 } },
      ]))
      .done()
  .state(EventSourced.cosmosState({
      url: "https://my-db.cosmos.azure.com",
      key: "XXXXX",
      databaseId: "my-db",
      collectionId: "my-collection",
      encoder: new JsonMessageEncoder(),
  }, TallyState, new TallyStateAggregator()))
  .dispatch({
      onMyInput: (msg: IMyInput, ctx: IDispatchContext<TallyState>): Promise<void> => {
          // this will find all events (Increment and Decrement messages) in
          // the cosmos collection and aggregate them into TallyState using TallyStateAggregator
          const stateRef = await ctx.state.get("key-123");

          // this will store an additional event into the event stream that
          // stateRef refers to ... it will also enforce optimistic concurrency, meaning
          // it will only append the new event if the event stream hasn't changed since
          // it was read last - otherwise it will retry by calling this event handler again
          if (stateRef.state.total > 0) {
              ctx.store(Increment, stateRef, new Increment(msg.amount));
          }
      }
  })
  .output()
      .stored(EventSourced.cosmosSink({
          url: "https://my-db.cosmos.azure.com",
          key: "XXXXX",
          databaseId: "my-db",
          collectionId: "my-collection",
          encoder: new JsonMessageEncoder(),
      }))
      .done()
  .run();
```

### Snapshots

Sometimes event streams can get rather long and running the aggregation logic every time a stream is requested can add overhead and slow down the service. For that purpose the Azure module supports storing snapshots of an aggregate at a certain point in time (identified by a sequence number) in Azure Blob Storage. When a state is requested by a message handler the state provider will first load the latest snapshot of that state and then retrieve and apply all remaining events on top of that snapshot.

```typescript
Application.create()
  .input()
      // ...
      .done()
  .state(EventSourced.cosmosState({
      url: "https://my-db.cosmos.azure.com",
      key: "XXXXX",
      databaseId: "my-db",
      collectionId: "my-collection",
      encoder: new JsonMessageEncoder(),
  }, TallyState, new TallyStateAggregator(), blobStorageSnapshotProvider({
      storageAccount: "XXX",
      storageAccessKey: "YYYYY",
      container: "my-snapshots",
  })))
  .dispatch({
      // ...
  })
  .output()
      .stored(EventSourced.cosmosSink({
          url: "https://my-db.cosmos.azure.com",
          key: "XXXXX",
          databaseId: "my-db",
          collectionId: "my-collection",
          encoder: new JsonMessageEncoder(),
      }))
      .done()
  .run();
```

In order to write snapshots to Azure Blob Storage you'd usually setup a separate service that listens to the events from the underlying event sourced streams, aggregates them and then stores a snapshot of that aggregated state every N messages into Azure Blob Storage. The idiomatic way of doing this is to setup a change capture data feed from Cosmos into a message broker system like Kafka and then have a service listen to that message stream. Cookie Cutter has a helper function called `snapshotter` that can convert any event aggregator into a message handler that will emit a snapshot of the aggregated state automatically.

```typescript
Application.create()
  .input()
      .add(kafkaSource({
          // ...
          topics: "cosmos-collection-changefeed",
      }))
      .done()
  .state(EventSourced.cosmosState({
      url: "https://my-db.cosmos.azure.com",
      key: "XXXXX",
      databaseId: "my-db",
      collectionId: "my-collection",
      encoder: new JsonMessageEncoder(),
  }, TallyState, new TallyStateAggregator(), blobStorageSnapshotProvider({
      storageAccount: "XXX",
      storageAccessKey: "YYYYY",
      container: "my-snapshots",
  })))
  .dispatch(snapshotter(new TallyStateAggregator()))
  .output()
      .stored(EventSourced.blobStorageSnapshotSink({
          storageAccount: "XXX",
          storageAccessKey: "YYYYY",
          container: "my-snapshots",
      }))
      .done()
  .run();
```

## Materialized

### State Management

Materialized Views work conceptually very similar to Event Sourced aggregates. The main difference is that there is no state aggregator class and the snapshot returned from the state class is used to persist the state in cosmos and rehydrate the state object from it.

```typescript
class TallyState {
    public total: number;

    constructor(snapshot?: { total: number }) {
        this.total = (snapshot && snapshot.total) || 0;
    }

    public snap(): { total: number } {
        return { total: this.total };
    }

    public increment(amount: number) {
        this.total += amount;
    }
}

Application.create()
  .input()
      .add(new StaticInputSource([
          { type: "MyInput", payload: { amount: 5 } },
      ]))
      .done()
  .state(Materialized.cosmosState({
      url: "https://my-db.cosmos.azure.com",
      key: "XXXXX",
      databaseId: "my-db",
      collectionId: "my-collection",
      encoder: new JsonMessageEncoder(),
  }, TallyState))
  .dispatch({
      onMyInput: (msg: IMyInput, ctx: IDispatchContext<TallyState>): Promise<void> => {
          // this will retrieve the document in cosmos with the specified key and then use the
          // content of that document as the snapshot parameter of the TallyState constructor
          const stateRef = await ctx.state.get("key-123");

          // this will store the snapshot of the updated state back to cosmos ... it will 
          // also enforce optimistic concurrency, meaning it will only overwrite the current
          // state if it hasn't changed since it was read last - otherwise it will retry 
          // by calling this event handler again
          if (stateRef.state.total > 0) {
              stateRef.state.increment(msg.amount);
              ctx.store(Increment, stateRef, stateRef.state.snap());
          }
      }
  })
  .output()
      .stored(Materialized.cosmosSink({
          url: "https://my-db.cosmos.azure.com",
          key: "XXXXX",
          databaseId: "my-db",
          collectionId: "my-collection",
          encoder: new JsonMessageEncoder(),
      }))
      .done()
  .run();
```

## Streaming

All sinks in the Streaming namespace will react to `publish`_ed_ messages vs. `store`_d_ messages as they are expected for Event Sourced and Materialized Views. This means that there is no optimistic concurrency for anything under Streaming.

### Cosmos

The purpose of this sink is to append messages to Cosmos without any additional checks. It will still ensure monotonically increasing sequence numbers per event stream, but it will not retry the entire message handler on sequence number conflicts. Instead it will just insert the document with the next available sequence number. The setup for this is similar to the Event Sourced output sink as described above.

```typescript
Application.create()
  // ...
  .dispatch({
      onMyInput: (msg: IMyInput, ctx: IDispatchContext) {
          ctx.publish(Increment, new Increment(msg.amount));
      }
  })
  .output()
      .published(Streaming.cosmosSink({
          url: "https://my-db.cosmos.azure.com",
          key: "XXXXX",
          databaseId: "my-db",
          collectionId: "my-collection",
          encoder: new JsonMessageEncoder(),
      }))
      .done()
  .run();
```

### Queues

Azure Queues is a FIFO queue implementation that is backed by an Azure SLA.

#### Enqueuing Items

```typescript
Application.create()
    .input()
        .add(intervalSource({
            timeoutMs: 100,
        }))
        .done()
    .dispatch({
        onInterval: (_: IInterval, ctx: IDispatchContext) => {
            ctx.publish<ISomeTask>(SomeTask, {
                taskId: "1234",
                task: "do something",
            });
        },
    })
    .output()
        .published(Streaming.queueSink({
            storageAccount: "[SOME_ACCOUNT]",
            storageAccessKey: "[SOME_KEY]",
            queueName: "[QUEUE_NAME]",
            encoder: new JsonMessageEncoder(),
        }))
        .done()
    .run();
```

#### Consuming Items

```typescript
Application.create()
    .input()
        .add(Streaming.queueSource({
          storageAccount: "[SOME_ACCOUNT]",
          storageAccessKey: "[SOME_KEY]",
          queueName: "[QUEUE_NAME]",
          encoder: new JsonMessageEncoder(),
          visibilityTimeout: 30, // default 30 seconds
          numOfMessages: 32, // default 32
        }))
        .done()
    .dispatch({
        onSomeTask: (_msg: ISomeTask, ctx: IDispatchContext) => {
            const dequeueCount = ctx.metadata(QueueMetadata.DequeueCount);
            if (dequeueCount > 10) {
                // maybe time to give up if it hasn't worked the last 10 times ...
            }
        },
    })
    .run(ErrorHandlingMode.LogAndContinue, ParallelismMode.Serial);
```

It is recommended to run the service in Serial mode with `queueSource` because once the message is received from Azure Queues its visibility timeout window starts and running the service in serial mode will decrease the chance of hitting the window timeout as messages are queued up internally in Cookie Cutter in Concurrent mode.

Queues items will be reprocessed if you throw an error in the message handler function. The `DequeueCount` metadata can be used to detect reprocessed messages and skip over those if appropriate.
