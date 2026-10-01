import { ChannelModel, ConfirmChannel, Message, Options } from 'amqplib';

import { DomainEvent, EVENTS_EXCHANGE } from './events';

export class UnroutableEvent extends Error {
  constructor(
    readonly routingKey: string,
    readonly messageId: string,
  ) {
    super(`no queue is bound for '${routingKey}' on ${EVENTS_EXCHANGE} — ${messageId} was returned`);
    this.name = 'UnroutableEvent';
  }
}

export class PublishNacked extends Error {
  constructor(readonly messageId: string) {
    super(`the broker refused to take responsibility for ${messageId}`);
    this.name = 'PublishNacked';
  }
}

// "Published" here means the broker said so, not that the bytes left the socket.
// The confirm channel turns publish into a request with an answer; mandatory turns
// "no binding matched" from a silent drop into a basic.return, which RabbitMQ sends
// before the confirm of the same message — so by the time the confirm callback
// runs, the return listener has already recorded whether this message came back.
export class EventPublisher {
  private readonly returned = new Set<string>();

  private constructor(private readonly channel: ConfirmChannel) {
    channel.on('return', (message: Message) => {
      const id = message.properties.messageId;
      if (typeof id === 'string') this.returned.add(id);
    });
  }

  static async open(connection: ChannelModel): Promise<EventPublisher> {
    return new EventPublisher(await connection.createConfirmChannel());
  }

  publish(event: DomainEvent): Promise<void> {
    return this.publishRaw(event.type, Buffer.from(JSON.stringify(event)), {
      messageId: event.eventId,
      type: event.type,
      timestamp: Math.floor(Date.parse(event.occurredAt) / 1000),
    });
  }

  // For bodies that are not a well-formed event — demo:dlq uses it to publish the
  // kind of message a broken producer would.
  publishRaw(
    routingKey: string,
    content: Buffer,
    properties: Options.Publish & { messageId: string },
  ): Promise<void> {
    const { messageId } = properties;

    return new Promise((resolve, reject) => {
      this.channel.publish(
        EVENTS_EXCHANGE,
        routingKey,
        content,
        {
          contentType: 'application/json',
          persistent: true,
          mandatory: true,
          ...properties,
        },
        (error: unknown) => {
          const wasReturned = this.returned.delete(messageId);
          if (error) return reject(new PublishNacked(messageId));
          if (wasReturned) return reject(new UnroutableEvent(routingKey, messageId));
          resolve();
        },
      );
    });
  }

  async close(): Promise<void> {
    await this.channel.waitForConfirms();
    await this.channel.close();
  }
}
