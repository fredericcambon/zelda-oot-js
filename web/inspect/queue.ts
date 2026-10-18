// Work on the running game is queued and run between two frames: guest memory must not change while a frame is in progress.

/** Thrown by an action that cannot go ahead; the message is shown to the player as it is. */
export class Refused extends Error {}

type Action = () => Promise<string | void> | string | void;

interface Entry {
  run: Action;
  failure: string;
}

export class ActionQueue {
  private entries: Entry[] = [];

  /** Queues `run` for the next gap between frames; an error that is not a refusal is reported as `<failure>: <message>`. */
  push(run: Action, failure = 'Failed'): void {
    this.entries.push({ run, failure });
  }

  get pending(): number {
    return this.entries.length;
  }

  /** Runs what is queued, in order, and returns one message per action that has something to say. */
  async drain(): Promise<string[]> {
    const entries = this.entries;
    this.entries = [];
    const messages: string[] = [];
    for (const { run, failure } of entries) {
      try {
        const message = await run();
        if (message) messages.push(message);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        messages.push(err instanceof Refused ? reason : `${failure}: ${reason}`);
      }
    }
    return messages;
  }
}
