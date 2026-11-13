/**
 * The worker that updates the currency worker's rates once a day (see
 * update.ts). It has no routes: nothing but its schedule runs it.
 *
 * The update runs in a Durable Object, not in the worker: a free worker has
 * 10 ms of CPU for a run, which the update is several times over. The object
 * keeps nothing: it's only somewhere with the time to run.
 */
import { DurableObject } from "cloudflare:workers";
import { update, type Update } from "./update.ts";

/** Runs the update, one at a time. */
export class Updater extends DurableObject<Env> {
  /** The update under way. */
  private running: Promise<Update> | undefined;

  /**
   * Runs the update, or waits for the one already running: two at once
   * would deploy over each other.
   */
  async update() {
    const running = (this.running ??= update(this.env));
    try {
      return await running;
    } finally {
      // Not when another has started since: the first to be told it's done clears it.
      if (this.running === running) this.running = undefined;
    }
  }
}

export default {
  // A failed update throws here, and the run is logged as failed.
  async scheduled(_controller, env) {
    // The one object there is, so that there is one update at a time.
    console.log("Updated the rates", await env.UPDATER.getByName("updater").update());
  },
} satisfies ExportedHandler<Env>;
