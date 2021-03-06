/*
Copyright (c) Walmart Inc.

This source code is licensed under the Apache 2.0 license found in the
LICENSE file in the root directory of this source tree.
*/

import {
    config,
    EventSourcedMetadata,
    IInputSource,
    IMessageEncoder,
    IOutputSink,
    IPublishedMessage,
} from "@walmartlabs/cookie-cutter-core";
import { KafkaPublisherConfiguration, KafkaSubscriptionConfiguration } from "./config";
import { KafkaSink } from "./KafkaSink";
import { KafkaSource } from "./KafkaSource";
import { IRawKafkaMessage } from "./model";

export enum KafkaOffsetResetStrategy {
    // starts consuming from the latest offset if no consumer group is present
    Latest = 1,
    // starts consuming from the earliest offset if no consumer group is present
    Earliest,
    // always starts consuming from the latest offset even if a consumer group is present
    AlwaysLatest,
    // always starts consuming from the earliest offset even if a consumer group is present
    AlwaysEarliest,
}

export interface IKafkaHeaderNames {
    readonly eventType: string;
    readonly sequenceNumber: string;
    readonly stream: string;
    readonly timestamp: string;
    readonly contentType: string;
}

export const DefaultKafkaHeaderNames: IKafkaHeaderNames = {
    eventType: EventSourcedMetadata.EventType,
    sequenceNumber: EventSourcedMetadata.SequenceNumber,
    stream: EventSourcedMetadata.Stream,
    timestamp: EventSourcedMetadata.Timestamp,
    contentType: "X-Message-Type",
};

export interface IKafkaBrokerConfiguration {
    readonly broker: string;
    readonly encoder: IMessageEncoder;
    readonly headerNames?: IKafkaHeaderNames;
}

export interface IKafkaSubscriptionConfiguration {
    /**
     * Kafka consumer group id
     */
    readonly group: string;
    /**
     * Topics to consume
     */
    readonly topics: string | Array<string | IKafkaTopic>;
    /**
     * Whether message consumption should be enable Exactly once Semantics (EoS).
     *
     * If EOS, consumed offset for a message will only be committed
     * when a message has been released.
     *
     * Allows consumer to participate in the "consume-transform-producer" loop
     */
    readonly eos?: boolean;
    readonly consumeTimeout?: number;
    readonly maxBytesPerPartition?: number;
    /**
     * The rate at which to periodically commit offsets to Kafka. Defaults to 60000 ms (1 min).
     */
    readonly offsetCommitInterval?: number;

    readonly preprocessor?: IKafkaMessagePreprocessor;
}

export enum KafkaMessagePublishingStrategy {
    NonTransactional = 1,
    Transactional,
    ExactlyOnceSemantics,
}

export interface IKafkaPublisherConfiguration {
    readonly defaultTopic?: string;
    readonly maximumBatchSize?: number;
    /**
     * The message publishing strategy to use for the underlying
     * kafka publisher. `Transactional` will attempt to publish
     * using kafka transactions and rollback on any errors. `ExactlyOnceSemantics`
     * will attempt commit offsets for any consumed messages as part of a
     * "consume-transform-produce" loop within a kafka transaction. In order to
     * enable `ExactlyOnceSemantics` a corresponding KafkaSource needs to be setup
     * with the `eos` option turned on. Defaults to `NonTransactional`.
     */
    readonly messagePublishingStrategy?: KafkaMessagePublishingStrategy;
    /**
     * Unique ID which will be associated with producer's transactions.
     *
     * Should be static across application runs. From the docs:
     * > The key to fencing out zombies properly is to ensure that the input topics
     * > and partitions in the read-process-write cycle is always the same for a given
     * > transactional.id. If this isn’t true, then it is possible for some messages to
     * > leak through the fencing provided by transactions.
     */
    readonly transactionalId?: string;
}

export interface IKafkaTopic {
    readonly name: string;
    readonly offsetResetStrategy?: KafkaOffsetResetStrategy;
}

export enum KafkaMetadata {
    Timestamp = "timestamp",
    Topic = "topic",
    Offset = "offset",
    Partition = "partition",
    Key = "key",
    Tombstone = "tombstone",
    ExactlyOnceSemantics = "eos",
    ConsumerGroupId = "consumerGroupId",
}

export interface IKafkaMessagePreprocessor {
    process(msg: IRawKafkaMessage): IRawKafkaMessage;
}

export function kafkaSource(
    configuration: IKafkaBrokerConfiguration & IKafkaSubscriptionConfiguration
): IInputSource {
    configuration = config.parse(KafkaSubscriptionConfiguration, configuration, {
        consumeTimeout: 50,
        offsetCommitInterval: 5000,
        eos: false,
        headerNames: DefaultKafkaHeaderNames,
        preprocessor: {
            process: (msg) => msg,
        },
    });
    return new KafkaSource(configuration);
}

export function kafkaSink(
    configuration: IKafkaBrokerConfiguration & IKafkaPublisherConfiguration
): IOutputSink<IPublishedMessage> {
    configuration = config.parse(KafkaPublisherConfiguration, configuration, {
        messagePublishingStrategy: KafkaMessagePublishingStrategy.NonTransactional,
        maximumBatchSize: 1000,
        headerNames: DefaultKafkaHeaderNames,
    });
    return new KafkaSink(configuration);
}
